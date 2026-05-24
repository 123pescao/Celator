# Phase 2A — Workflow Engine + Target Playbook Foundation

## What Phase 2A added

Phase 2A turns manual removal tracking into a structured workflow engine. It adds:

- `RemovalPlaybook` — reusable template describing the operator steps for a removal action
- `RemovalPlaybookStep` — ordered steps inside a playbook with safe instructions
- `TaskWorkflowRun` — one workflow instance per cleanup task
- `TaskWorkflowStepRun` — one step instance per workflow run
- `WorkflowEngineService` — service for creating playbooks, starting workflows, advancing/blocking steps, and linking manual submissions to specific steps
- 8 REST API endpoints under `/api/v1`
- 3 generic seed playbooks for development
- Timeline events: `WORKFLOW_STARTED`, `WORKFLOW_STEP_ADVANCED`, `WORKFLOW_STEP_BLOCKED`, `WORKFLOW_MANUAL_SUBMISSION_LINKED`, `WORKFLOW_COMPLETED`
- Audit events using the same string keys
- 5 new error codes: `PLAYBOOK_NOT_FOUND`, `WORKFLOW_RUN_NOT_FOUND`, `WORKFLOW_STEP_NOT_FOUND`, `WORKFLOW_INVALID_TRANSITION`, `WORKFLOW_UNSAFE_TEXT`
- 26 new unit tests, 10 new integration tests, 12 new smoke steps (41–52)

## What playbooks are

A `RemovalPlaybook` is a reusable template that describes the expected operator process for removing data from a specific source type or target. It contains:

- A name and version (unique together)
- An optional `sourceType` (DATA_BROKER, SEARCH_ENGINE, SOCIAL_PLATFORM, etc.)
- An optional link to a specific `DataSourceTarget`
- A status: ACTIVE, INACTIVE, DEPRECATED
- An ordered list of `RemovalPlaybookStep` records

Each step describes:
- What kind of action it represents (`stepKind`)
- A human-readable title and PII-safe instructions
- Whether the step requires approval or a manual submission
- An optional evidence type requirement

Playbooks are PII-free. Instructions must not contain raw email addresses, phone numbers, or other identifiable values.

## What workflow runs are

A `TaskWorkflowRun` is one instance of a playbook applied to a specific cleanup task. When a workflow is started:

1. A `TaskWorkflowRun` is created linked to the task, client, and playbook
2. One `TaskWorkflowStepRun` is created for each playbook step
3. The first step moves to `READY` status — all others start as `PENDING`

The operator then advances through the steps:
- `READY` or `IN_PROGRESS` → `COMPLETED` via the advance endpoint
- The next `PENDING` step automatically advances to `READY`
- When all steps are done, the run status becomes `COMPLETED`

## What this phase does

Phase 2A provides the structure for tracking removal workflows. It does not execute any removal actions. It:

- Defines reusable playbook templates per source type
- Creates per-task workflow instances with step-by-step state
- Links manual submission records from Phase 1F to specific workflow steps
- Produces structured audit and timeline events for every state transition
- Enforces PII safety on all text fields through `checkRedactedPreview`

## What is still manual

Everything. The operator still:
- Navigates to broker opt-out pages themselves
- Submits forms, sends emails, or calls support portals directly
- Records outcomes in Celator after the external action is complete
- Verifies removal by checking the broker listing page

Celator tracks what was done, when, by whom, and what the outcome was.

## What is deliberately not automated

- Form filling / browser automation
- Email sending to data brokers
- Account login or OAuth flows
- CAPTCHA solving
- Any external network call to a data broker, search engine, social platform, or public record site
- Auto-submission based on approval or workflow state
- Polling for status updates from data brokers

## How PII safety is preserved

1. `instructions` in playbook steps are validated with `checkRedactedPreview` — any step instruction containing a raw email, phone number, or SSN is rejected with `WORKFLOW_UNSAFE_TEXT`
2. `operatorNotes` on step runs is validated before storage — raw PII rejected
3. `safeResultSummary` on step runs is validated before storage — raw PII rejected
4. `blockStep.reason` is validated before storage — raw PII rejected
5. All audit metadata contains only IDs, status enums, and step orders — no field values
6. No vault ciphertext, authTag, or encryptedKeyRef appears in any workflow response

## How playbook selection works

When `startWorkflowForTask` is called:

1. If `playbookId` is explicitly provided → use that playbook
2. If the task has a `dataSourceTargetId` → find the most recent ACTIVE playbook linked to that target
3. Otherwise → return `PLAYBOOK_NOT_FOUND` (caller must provide an explicit `playbookId`)

## How Phase 2A sets up Phase 2B

Phase 2A establishes the playbook and workflow data model. Phase 2B (target-specific adapters) will be able to:
- Auto-assign a target-specific playbook when a task is linked to a `DataSourceTarget`
- Add target-specific step validation (e.g., confirming the broker's opt-out URL is reachable)
- Pre-populate step instructions with target-specific guidance (still PII-free)
- Auto-advance steps when certain conditions are met (e.g., confirmation email received)

Phase 2A deliberately leaves target-specific logic out and provides the generic structure.

## API routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/removal-playbooks` | Create a playbook with steps |
| GET | `/api/v1/removal-playbooks` | List active playbooks |
| GET | `/api/v1/removal-playbooks/:playbookId` | Get playbook with steps |
| POST | `/api/v1/tasks/:taskId/workflow-runs` | Start workflow for task |
| GET | `/api/v1/tasks/:taskId/workflow-run` | Get current workflow state |
| POST | `/api/v1/workflow-runs/:runId/steps/:stepRunId/advance` | Advance a step |
| POST | `/api/v1/workflow-runs/:runId/steps/:stepRunId/block` | Block a step |
| POST | `/api/v1/workflow-runs/:runId/steps/:stepRunId/manual-submission` | Link manual submission to step |

All endpoints require `X-Dev-Actor-Id` header.

## Playbook step kinds

| Kind | Description |
|------|-------------|
| `VERIFY_TARGET_REQUIREMENTS` | Check target is active, PII fields available |
| `PREPARE_REMOVAL_DRAFT` | Build removal request draft via vault |
| `OPERATOR_REVIEW` | Operator reviews and approves the request |
| `MANUAL_SUBMISSION` | Operator manually submits the removal request |
| `WAIT_FOR_CONFIRMATION` | Wait for broker processing window |
| `RECORD_OUTCOME` | Record the broker response |
| `VERIFY_REMOVAL` | Verify the listing is gone |
| `CLOSE_TASK` | Close the task with final outcome |
| `CUSTOM` | Custom step for non-standard flows |

## Workflow run statuses

| Status | Meaning |
|--------|---------|
| `IN_PROGRESS` | Active, steps being worked |
| `WAITING` | Paused waiting for broker response |
| `BLOCKED` | A step was blocked — needs operator action |
| `COMPLETED` | All steps done |
| `FAILED` | Workflow ended in failure |
| `CANCELLED` | Workflow was cancelled |

## Seed playbooks

The seed script creates 3 generic playbooks (all with 8 steps):

1. **Generic Data Broker Opt-Out** (`sourceType: DATA_BROKER`)
2. **Generic Search Engine Result Removal** (`sourceType: SEARCH_ENGINE`)
3. **Generic Social Platform Account/Data Removal** (`sourceType: SOCIAL_PLATFORM`)

Run with:
```bash
cd Celator && node --loader ts-node/esm scripts/seed-dev-playbooks.ts
```

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

The full smoke test runs 52 steps. Steps 41–52 exercise the Phase 2A endpoints.
