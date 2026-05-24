# Phase 1F — Manual Removal Workflow MVP

## What Phase 1F added

Phase 1F closes Phase 1 by adding a complete manual operator workflow for tracking data removal submissions. It connects the existing pieces (client, vault, target, task, review packet, approval) into a single traceable operator-driven flow.

New additions:
- `ManualRemovalSubmission` database model and migration
- `ManualRemovalSubmissionRepository` with create, find, list, updateSubmitted, updateOutcome methods
- `ManualRemovalSubmissionService` with full lifecycle: create → submitted → outcome
- 5 REST API endpoints under `/api/v1`
- Timeline events: `MANUAL_SUBMISSION_CREATED`, `MANUAL_SUBMISSION_SUBMITTED`, `MANUAL_SUBMISSION_OUTCOME_RECORDED`
- Audit events using the same string keys
- `SubmissionMethod` enum: WEB_FORM, EMAIL, SUPPORT_PORTAL, PHONE, MAIL, OTHER
- `SubmissionStatus` enum: DRAFTED, READY_FOR_MANUAL_SUBMISSION, SUBMITTED, ACKNOWLEDGED, REJECTED, NEEDS_MORE_INFO, COMPLETED, FAILED
- 21 new unit tests, 10 new integration tests, 8 new smoke steps (33–40)

## What is still manual

Everything. Phase 1F tracks that a human operator submitted a removal request. It does not:
- Fill in web forms automatically
- Send emails on behalf of the operator
- Log into broker accounts
- Submit opt-out or deletion requests programmatically
- Poll for status updates from data brokers

The operator performs all external actions. Celator records what was done, when, and what the outcome was.

## What is deliberately not automated

- Form filling / browser automation
- Email sending to data brokers
- Account login or OAuth flows
- CAPTCHA solving
- Any external network call to a data broker, search engine, social platform, or public record site
- Auto-submission based on approval state

## How PII safety is preserved

1. `redactedSummary` is required for every submission and is validated through `checkRedactedPreview` before storage. Any string containing a raw email, phone number, or SSN pattern is rejected with `PII_FORBIDDEN_IN_REDACTED_PREVIEW`.

2. `operatorNotes` is an optional free-text field that is also run through `checkRedactedPreview` before storage. This prevents accidental PII entry in notes.

3. `confirmationCode` and `confirmationUrl` store broker reference numbers and portal URLs — neither is PII. They are safe to store in plaintext.

4. The service response (`SafeManualSubmission`) is a deliberately shaped type. It contains no vault ciphertext, no plaintext field values, and no IV or auth tag. The `toSafe()` function enforces this by explicit field selection.

5. Audit metadata for submission events contains only IDs, method enum, and outcome status — no PII. The existing `checkAuditMetadata` in `AuditService` provides the second layer of enforcement.

## How the operator workflow works

```
1. Client intake + vault data stored (Phase 1D)
2. Target registry — identify the data broker (Phase 1E)
3. Task created and linked to target (Phase 1E)
4. Removal draft built — verify vault has required fields (Phase 1E)
5. Review packet created (Phase 1A)
6. Operator approves review packet (Phase 1A)
7. Operator manually performs the removal action (outside Celator)
   Examples:
   - Visits the broker's opt-out URL
   - Sends an email to the broker's privacy team
   - Submits a DSAR through the broker's support portal
8. POST /api/v1/tasks/:taskId/manual-submissions
   — Records that a submission will be or was attempted
9. POST /api/v1/manual-submissions/:id/submitted
   — Marks the submission as SUBMITTED, records confirmationCode if provided
10. POST /api/v1/manual-submissions/:id/outcome
    — Records the broker response (ACKNOWLEDGED, COMPLETED, REJECTED, etc.)
```

## API routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/tasks/:taskId/manual-submissions` | Create a submission for a task |
| GET | `/api/v1/tasks/:taskId/manual-submissions` | List submissions for a task |
| GET | `/api/v1/clients/:clientId/manual-submissions` | List submissions for a client |
| POST | `/api/v1/manual-submissions/:submissionId/submitted` | Mark as submitted |
| POST | `/api/v1/manual-submissions/:submissionId/outcome` | Record broker outcome |

All endpoints require `X-Dev-Actor-Id` header.

## Status transitions

```
DRAFTED → READY_FOR_MANUAL_SUBMISSION
DRAFTED → SUBMITTED  (via /submitted)
READY_FOR_MANUAL_SUBMISSION → SUBMITTED  (via /submitted)
SUBMITTED → ACKNOWLEDGED
SUBMITTED → REJECTED
SUBMITTED → NEEDS_MORE_INFO
SUBMITTED → COMPLETED
SUBMITTED → FAILED
ACKNOWLEDGED → COMPLETED
ACKNOWLEDGED → FAILED
NEEDS_MORE_INFO → SUBMITTED  (re-submit after providing more info)
```

Terminal states (cannot be changed): COMPLETED, FAILED, REJECTED

## How to run validation

```bash
# From Celator/
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:integration
bash scripts/verify-phase1a-runtime.sh --full-workflow
```

The full smoke test runs 40 steps. Steps 33–40 exercise the Phase 1F endpoints.
