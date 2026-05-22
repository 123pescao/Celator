# Phase 1C — Actor Context and Audit Reliability

## Overview

Phase 1C hardens the developer-testing API by replacing fake actor defaults with DB-backed actor resolution and by making audit writes fail-closed on security-sensitive paths.

**What was built (2026-05-21):**

- `apps/api/src/auth/dev-actor-context.ts` — actor resolution via `x-dev-actor-id` header
- All 4 protected route files updated to use `requireDevActor` (no more `?? 'dev-actor'` fallbacks)
- `operatorId` removed from request bodies on attest, reject, and approval routes (sourced from actor instead)
- Admin routes guarded against production access (`DEV_BOOTSTRAP_DISABLED` if `NODE_ENV=production`)
- All 7 service files apply audit fail-close: if `audit.write()` returns `Err`, the service method returns that error
- 10 unit tests for actor context, 7 unit tests for audit fail-close across 4 service test files
- Smoke script updated to 22 steps: real `USER_ID` actor, actor validation steps, timeline/audit count assertions
- API package gains vitest and test infrastructure

---

## Actor Context — `requireDevActor`

**File:** `apps/api/src/auth/dev-actor-context.ts`

```typescript
// Reads x-dev-actor-id, returns actor context or sends error reply
const ctx = await requireDevActor(request, reply, userRepo);
if (!ctx) return; // reply already sent
// ctx.actor.id  — use as actorId
// ctx.actor.organizationId — use as operatorOrganizationId
```

### Error responses

| Condition | HTTP | Error code |
|---|---|---|
| `x-dev-actor-id` header missing | 401 | `ACTOR_REQUIRED` |
| User not found in DB | 401 | `ACTOR_INVALID` |
| User exists but `isActive=false` | 403 | `ACTOR_INACTIVE` |
| User org doesn't match required org | 403 | `ACTOR_ORG_MISMATCH` |

**This is NOT production auth.** `requireDevActor` is intended only for developer-testing endpoints. A production deployment must replace this with a proper JWT/OAuth provider and remove or gate all routes using this mechanism.

---

## DEV_BOOTSTRAP Endpoints

`POST /api/v1/organizations` and `POST /api/v1/users` are bootstrap endpoints — no actor is required because they exist to seed the DB before any real users exist.

They are **blocked in production** via a Fastify `onRequest` hook in `admin.ts`:

```typescript
if (process.env['NODE_ENV'] === 'production') {
  return reply.code(403).send({ ok: false, error: 'DEV_BOOTSTRAP_DISABLED' });
}
```

---

## Audit Fail-Close

Before Phase 1C, all service methods silently discarded the `Result<AuditLog, ErrorCode>` returned by `audit.write()`. This meant an operator could take a security-relevant action (approve, create, revoke) with no audit trail and the service would still return `ok`.

After Phase 1C, all ALLOWED-outcome audit writes are fail-closed:

```typescript
// After entity mutation:
const auditResult = await this.audit.write({ ... outcome: 'ALLOWED' ... });
if (!auditResult.ok) return auditResult; // propagates AUDIT_LOG_FAILED
return ok(entity);
```

**BLOCKED-outcome audit writes are NOT fail-closed** (e.g., `TASK_TRANSITION_BLOCKED`). The policy decision has already been made — the action is denied regardless of whether the audit write succeeds. Fail-closing would replace a clear `TRANSITION_NOT_ALLOWED` with an opaque `AUDIT_LOG_FAILED`, making debugging harder with no security benefit.

### Services updated

| Service | Methods with fail-close |
|---|---|
| `ClientService` | `create`, `activateAfterVerification`, `updateStatus`, `setFlags` |
| `CleanupCaseService` | `create`, `close` |
| `CleanupTaskService` | `create`, `transition` (ALLOWED path only) |
| `ClientIdentityVerificationService` | `createRecord`, `recordOperatorAttestation`, `completeVerification`, `rejectVerification` |
| `ConsentWorkflowService` | `createConsentVersion`, `createAuthorization`, `revokeAuthorization` |
| `ReviewPacketService` | `create` |
| `OperatorApprovalService` | `recordDecision` |

---

## Route Changes

### `clients.ts`

- `AttestBody`: removed `operatorId` field — actor from header
- `RejectVerificationBody`: removed `operatorId` field — actor from header
- All write handlers use `requireDevActor` with `if (!ctx) return`
- Plugin options type: `{ services: AppServices; userRepo: UserRepository }`

### `cases.ts`

- All write handlers use `requireDevActor`
- Plugin options type: `{ services: AppServices; userRepo: UserRepository }`

### `consent.ts`

- All write handlers use `requireDevActor`
- Plugin options type: `{ services: AppServices; userRepo: UserRepository }`

### `review-packets.ts`

- `RecordDecisionBody`, `ApproveBody`, `RejectBody`: removed `operatorId` and `operatorOrganizationId`
- `operatorId` comes from `ctx.actor.id`, `operatorOrganizationId` from `ctx.actor.organizationId`
- Plugin options type: `{ services: AppServices; userRepo: UserRepository }`

---

## Smoke Script Changes (Phase 1C)

- Steps renumbered — now 22 steps total
- Step 3–4 (org/user creation): explicitly sends no actor header (`__none__`)
- After step 4: `ACTOR_ID` set to `USER_ID` — all subsequent requests carry the real user ID
- **Step 5 (new):** Assert missing actor header → 401 `ACTOR_REQUIRED`
- **Step 6 (new):** Assert invalid actor ID → 401 `ACTOR_INVALID`
- Step 9 (attest): `operatorId` removed from body
- Step 17 (approve): `operatorId` and `operatorOrganizationId` removed from body
- Step 18 (timeline): **Asserts `events.length > 0`** (not just a count display)
- Step 19 (audit logs): **Asserts `auditLogs.length > 0`** (not just a count display)
- Array counting works with jq → node → grep fallback (no jq required)

---

## Test Infrastructure

### `apps/api`

- New: `vitest.config.ts`, `test` and `test:coverage` scripts in `package.json`
- New: `src/__tests__/dev-actor-context.test.ts` — 10 tests covering all 401/403 cases and success paths

### `packages/core`

Added `audit fail-close` describe blocks to:
- `client.service.test.ts` — 3 new tests
- `cleanup-task.service.test.ts` — 3 new tests (including BLOCKED path verification)
- `consent-workflow.service.test.ts` — 3 new tests
- `review-packet.service.test.ts` — 1 new test

---

## Open Items (deferred to Phase 1D)

- Production OAuth/JWT — `requireDevActor` is a placeholder; replace before any non-local deployment
- MFA freshness enforcement — `mfaFreshAt` is accepted but not validated against a wall-clock threshold
- Full async HMAC signatures for review packet snapshots
- Dual-admin enforcement for GLOBAL emergency pause
