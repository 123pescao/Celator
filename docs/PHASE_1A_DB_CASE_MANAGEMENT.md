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

```bash
# 1. Start the database
docker compose up -d

# 2. Set up environment
cp .env.example .env
# Edit LOCAL_KMS_MASTER_SECRET and LOCAL_KMS_SIGNING_SECRET

# 3. Generate Prisma client
pnpm prisma:generate

# 4. Apply migrations
pnpm --filter @celator/db prisma:migrate:deploy

# 5. Start the dev server
pnpm dev

# 6. Run tests
pnpm test
```

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

### Integration tests (`packages/core/src/__tests__/integration/`)

See [integration/README.md](../packages/core/src/__tests__/integration/README.md) — requires a live DB.

---

## Phase 0 compatibility

- All 147 Phase 0 security unit tests pass unchanged
- Phase 0 in-memory services (`IdentityVaultService`, `ApprovalGateService`, `ConsentPolicyService`, etc.) are **not removed** — they are used for isolated security unit tests
- `CleanupTaskStatusService` from Phase 0 is imported by `CleanupTaskService` to enforce state transitions
- Phase 0 fail-closed behavior is preserved; no Phase 0 security check has been weakened

---

## Phase 0 open items remaining (unchanged)

- Check 20 (duplicate detection): scaffolded comment, requires Phase 1B
- Check 21 (CAPTCHA/login preflight): requires browser automation, out of scope
- GLOBAL pause dual-admin enforcement: data model in place, workflow enforcement is Phase 1B
- Async HMAC signature verification: `canExecuteSubmission()` is synchronous; Phase 1A uses SHA-256 hash placeholder (`sha256:${payloadHash}`), full HMAC is Phase 1B
- Audit log tamper protection: in-DB only, external write-once store is Phase 1B
- DB-level triggers for status transitions: Phase 1B
