# Celator Phase 1A — DB-Backed Case Management

## Overview

Phase 1A adds the database-backed case-management core to Celator. It does **not** add browser automation, LLM integration, external submissions, or any destructive automated actions.

**Non-negotiable rule (unchanged from Phase 0):** No automatic deletion. No automatic opt-out. No automatic final submission. No destructive action without an operator reviewing and explicitly approving it first.

---

## What was built

### 1. Prisma migration (`packages/db/prisma/migrations/`)

`20260521000000_init/migration.sql` — initial schema migration derived from the Phase 0 Prisma schema. Run with:

```bash
pnpm --filter @celator/db prisma:migrate:deploy
```

### 2. DB client (`packages/db/src/client.ts`)

Singleton `PrismaClient` factory:

```typescript
import { getPrismaClient, disconnectPrisma } from '@celator/db';

const db = getPrismaClient();  // returns shared singleton
await disconnectPrisma();      // clean shutdown
```

### 3. Repository layer (`packages/db/src/repositories/`)

15 thin repositories, each wrapping a Prisma model. All repositories are injected via constructor — no singletons, easy to mock in tests.

| Repository | Model |
|---|---|
| `OrganizationRepository` | `Organization` |
| `UserRepository` | `User` |
| `ClientRepository` | `Client` |
| `ClientIdentityVerificationRepository` | `ClientIdentityVerification` |
| `ConsentVersionRepository` | `ConsentVersion` |
| `ClientAuthorizationRepository` | `ClientAuthorization` |
| `CleanupCaseRepository` | `CleanupCase` |
| `CleanupTaskRepository` | `CleanupTask` |
| `ApprovalPayloadSnapshotRepository` | `ApprovalPayloadSnapshot` |
| `ApprovalRequestRepository` | `ApprovalRequest` |
| `OperatorApprovalRepository` | `OperatorApproval` |
| `AuditLogRepository` | `AuditLog` |
| `CaseTimelineRepository` | `CaseTimelineEvent` |
| `EvidenceRecordRepository` | `EvidenceRecord` |
| `EmergencyPauseRepository` | `EmergencyPauseEvent` |

### 4. DB-backed services (`packages/core/src/services/`)

| Service | Responsibility |
|---|---|
| `AuditService` | Write events, list by client/actor/resource. PII pattern check rejects metadata with email/phone/SSN patterns. Fail-closed on DB error. |
| `CaseTimelineService` | Append and list timeline events. Append-only — no updates. |
| `ClientService` | Create/get/list clients. `activateAfterVerification` enforces `PENDING_IDENTITY_VERIFICATION → ACTIVE` only. |
| `ClientIdentityVerificationService` | Create verification record, record operator attestation, complete or reject verification. Writes audit + drives client activation. |
| `ConsentWorkflowService` | Create consent versions, create/revoke authorizations, evaluate scope coverage, pause tasks on revocation. |
| `CleanupCaseService` | Create, get, list, close cases. Writes audit + timeline on all state changes. |
| `CleanupTaskService` | Create tasks, transition statuses (via `CleanupTaskStatusService` from Phase 0), bulk-pause tasks on consent revocation. Writes audit + timeline on all transitions. |
| `ReviewPacketService` | Create `ApprovalPayloadSnapshot` + `ApprovalRequest` + evidence holds. Validates `CONFIRMED_MATCH` and active authorization. Cancels prior pending requests. SHA-256 payload hash. |
| `OperatorApprovalService` | Record operator decision, update request/snapshot status, drive task status transition, write audit. |

### 5. Fastify API endpoints (`apps/api/src/routes/v1/`)

For developer testing only. **Not production-ready auth** — uses `X-Dev-Actor-Id` header.

| Route | Purpose |
|---|---|
| `POST /api/v1/clients` | Create a client |
| `GET /api/v1/clients/:id` | Get a client |
| `GET /api/v1/organizations/:orgId/clients` | List clients in org |
| `PATCH /api/v1/clients/:id/status` | Update client status |
| `POST /api/v1/cases` | Create a cleanup case |
| `GET /api/v1/cases/:id` | Get a case |
| `GET /api/v1/clients/:clientId/cases` | List cases for a client |
| `POST /api/v1/cases/:id/close` | Close a case |
| `POST /api/v1/tasks` | Create a cleanup task |
| `GET /api/v1/tasks/:id` | Get a task |
| `GET /api/v1/cases/:caseId/tasks` | List tasks in a case |
| `POST /api/v1/tasks/:id/transition` | Transition task status |
| `GET /api/v1/tasks/:id/allowed-transitions` | List allowed status transitions |
| `POST /api/v1/review-packets` | Create review packet |
| `GET /api/v1/tasks/:taskId/review-packet` | Get active review packet for task |
| `POST /api/v1/approval-requests/:id/decision` | Record operator decision |
| `POST /api/v1/consent-versions` | Create consent version |
| `POST /api/v1/authorizations` | Create authorization |
| `GET /api/v1/clients/:clientId/authorizations` | List active authorizations |
| `POST /api/v1/authorizations/:id/revoke` | Revoke authorization |

---

## Local development setup

### 1. Start Postgres

**Podman (recommended on this machine):**
```bash
podman run -d \
  --name celator-postgres \
  -e POSTGRES_USER=celator \
  -e POSTGRES_PASSWORD=celator \
  -e POSTGRES_DB=celator \
  -p 5432:5432 \
  postgres:16-alpine

# Or using compose (podman-compose or docker compose):
podman-compose up -d
```

**Docker:**
```bash
docker compose up -d
```

Verify the container is running:
```bash
podman ps | grep celator-postgres
# or
docker ps | grep celator-postgres
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit at minimum:
#   LOCAL_KMS_MASTER_SECRET=<any 32+ char string for local dev>
#   LOCAL_KMS_SIGNING_SECRET=<any 32+ char string for local dev>
# DATABASE_URL is pre-set to localhost:5432/celator in .env.example
```

### 3. Generate Prisma client and apply migrations

```bash
# Generate the Prisma client (required after schema changes)
pnpm prisma:generate

# Apply all migrations to the running database
pnpm --filter @celator/db prisma:migrate:deploy

# Verify — should print "Database schema is up to date"
pnpm --filter @celator/db exec prisma migrate status
```

### 4. Start the dev server

```bash
pnpm dev
# API starts at http://127.0.0.1:3000 (configurable via API_PORT / API_HOST in .env)
```

### 5. Run manual curl checks

```bash
# Health check
curl -s http://127.0.0.1:3000/health | jq .
# Expected: { "ok": true, "service": "celator-api", ... }

# Security status (Phase 1A runtime hardening)
curl -s http://127.0.0.1:3000/security/status | jq .
# Expected: { "ok": true, "database": { "reachable": true, "latencyMs": <n> }, "phase": "PHASE_1A_DB_CASE_MANAGEMENT", ... }

# DB-backed endpoint smoke test
curl -s http://127.0.0.1:3000/api/v1/organizations/org_001/clients | jq .
# Expected: { "ok": true, "clients": [] }  (empty list — no data seeded yet)
```

### 6. Run the automated verification script

```bash
bash scripts/verify-phase1a-runtime.sh
# Optional: target a different API host
bash scripts/verify-phase1a-runtime.sh --api-url http://127.0.0.1:3000
```

The script checks:
- Node.js ≥ 20 and pnpm are available
- The `celator-postgres` container is running
- `prisma migrate status` reports no pending migrations
- `/health` returns `ok: true`
- `/security/status` returns `ok: true` with `database.reachable: true`
- The phase field shows `PHASE_1A_DB_CASE_MANAGEMENT`
- A DB-backed route responds without crashing

Exit code 0 = all checks passed. Non-zero = one or more failures (see output).

### 7. Run tests

```bash
# All unit tests (no live DB required)
pnpm test

# With coverage
pnpm test:coverage
```

### 8. Run integration tests (requires Postgres)

```bash
# DATABASE_URL must be set (pre-configured in .env from step 2)
pnpm test:integration
# Or explicitly:
pnpm --filter @celator/core test:integration
```

Integration tests use the `it_` and `smoke_` prefixes for test data and clean up after each run. They do **not** touch non-test data.

### 9. Run the full workflow smoke script

The API must be running (`pnpm dev`) before running the smoke test.

```bash
bash scripts/smoke-phase1a-api-workflow.sh
# Or with a different API host:
bash scripts/smoke-phase1a-api-workflow.sh --api-url http://127.0.0.1:3000
```

The smoke script exercises the complete operator workflow end-to-end via the HTTP API:
organization → user → client → identity verification → activation → consent version → authorization → case → task → review packet → approval → timeline → audit logs

It also validates that bad requests return 400, nonexistent resources return 404, and error responses contain no stack traces.

### 10. Clean up test data

If integration or smoke tests leave residual data, clean it up with:

```bash
bash scripts/reset-phase1a-test-data.sh
# Skip confirmation prompt:
bash scripts/reset-phase1a-test-data.sh --yes
```

The reset script only deletes rows matching the `it_` / `smoke_` organization name prefixes and `999.x.x` consent versions. It prints the row counts before deletion and requires confirmation unless `--yes` is passed.

### 11. Run the verification script with full workflow

```bash
# Lightweight (no API required):
bash scripts/verify-phase1a-runtime.sh

# Full workflow including smoke test (API must be running):
bash scripts/verify-phase1a-runtime.sh --full-workflow
```

---

## Phase 1B additions

Phase 1B added the following on top of the Phase 1A DB core:

### New API endpoints

| Route | Purpose |
|---|---|
| `POST /api/v1/organizations` | Create an organization |
| `GET /api/v1/organizations/:id` | Get an organization |
| `POST /api/v1/users` | Create an operator user |
| `GET /api/v1/users/:id` | Get a user |
| `POST /api/v1/clients/:clientId/identity-verification` | Create a verification record |
| `GET /api/v1/clients/:clientId/identity-verification` | Get latest verification record |
| `POST /api/v1/identity-verifications/:id/attest` | Record operator attestation |
| `POST /api/v1/identity-verifications/:id/complete` | Complete verification (activates client) |
| `POST /api/v1/identity-verifications/:id/reject` | Reject verification |
| `GET /api/v1/cases/:caseId/timeline` | Get case timeline events |
| `GET /api/v1/clients/:clientId/audit-logs` | Get audit logs for a client |
| `POST /api/v1/approval-requests/:id/approve` | Approve shorthand (APPROVED decision) |
| `POST /api/v1/approval-requests/:id/reject` | Reject shorthand (REJECTED decision) |

### New scripts

| Script | Purpose |
|---|---|
| `scripts/smoke-phase1a-api-workflow.sh` | End-to-end API workflow smoke test |
| `scripts/reset-phase1a-test-data.sh` | Delete only test-prefixed data from the DB |

### New tests

| Test | Type | Purpose |
|---|---|---|
| `phase1a-workflow.integration.test.ts` | Integration (real DB) | Full workflow: org → approval → audit verification |

### ⚠ Important: approval does not mean submission

**Phase 1B approval records that an operator reviewed and approved a cleanup task. It does NOT trigger any external submission, deletion request, opt-out, or automated action. No external systems are contacted.**

Phase 1C and later phases may add submission capability — always behind an additional operator-controlled gate, never automatically.

---

## Test structure

### Unit tests (`packages/core/src/__tests__/`)

All services have unit tests using mock repositories (no DB required):

| Test file | Coverage |
|---|---|
| `audit.service.test.ts` | PII rejection, audit write, DB failures |
| `client.service.test.ts` | Create, get, activate, status transitions |
| `cleanup-task.service.test.ts` | Create, allowed/blocked transitions, audit on block |
| `consent-workflow.service.test.ts` | Version creation, auth create/revoke, scope coverage |
| `review-packet.service.test.ts` | Packet create with validation, snapshot expiry, auth check |
| `db-health.test.ts` | `checkDbHealth` reachable, ECONNREFUSED, ENOTFOUND, auth error, timeout, no-credential leakage |

### Integration tests (`packages/core/src/__tests__/integration/`)

Requires a live DB. Run with `pnpm test:integration`.

| Test file | Coverage |
|---|---|
| `phase1a-workflow.integration.test.ts` | Full org→approval workflow, PII-in-audit check, revocation blocks, validation guards |

---

## Phase 0 compatibility

- All 147 Phase 0 security unit tests pass unchanged
- Phase 0 in-memory services (`IdentityVaultService`, `ApprovalGateService`, `ConsentPolicyService`, etc.) are **not removed** — they are used for isolated security unit tests
- `CleanupTaskStatusService` from Phase 0 is imported by `CleanupTaskService` to enforce state transitions
- Phase 0 fail-closed behavior is preserved; no Phase 0 security check has been weakened

---

## Out of scope (Phase 1B and earlier)

- Browser automation or scraping
- LLM integration
- Email or notification sending
- Deletion submission, opt-out submission, or any external request to a data broker
- Account deletion on any platform
- Google/search result removal
- Payment or billing
- Frontend dashboard or client portal UI
- Production authentication provider

---

## Phase 0 open items remaining (carry to Phase 1C)

- Check 20 (duplicate detection): scaffolded comment, requires Phase 1C
- Check 21 (CAPTCHA/login preflight): requires browser automation, out of scope
- GLOBAL pause dual-admin enforcement: data model in place, workflow enforcement is Phase 1C
- Async HMAC signature verification: `canExecuteSubmission()` is synchronous; Phase 1A uses SHA-256 hash placeholder (`sha256:${payloadHash}`), full HMAC is Phase 1C
- Audit log tamper protection: in-DB only, external write-once store is Phase 1C
- DB-level triggers for status transitions: Phase 1C

---

## Phase 1C additions (2026-05-21)

Phase 1C hardened actor resolution and audit reliability. See [PHASE_1C_ACTOR_AUDIT_HARDENING.md](PHASE_1C_ACTOR_AUDIT_HARDENING.md) for full details.

**Summary of changes:**
- `apps/api/src/auth/dev-actor-context.ts` — `requireDevActor()` replaces all `?? 'dev-actor'` fallbacks; DB-backed, fail-closed with 401/403
- `admin.ts` — `DEV_BOOTSTRAP_DISABLED` guard blocks bootstrap endpoints in `NODE_ENV=production`
- All 7 service files — audit fail-close: `AUDIT_LOG_FAILED` propagates up on ALLOWED-outcome write failures
- Smoke script — 22 steps, real actor ID, actor validation steps, timeline/audit count assertions
- 17 new unit tests (10 actor context, 7 audit fail-close)
