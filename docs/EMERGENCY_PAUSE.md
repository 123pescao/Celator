# Emergency Pause — Design and Reference

## Overview

The Emergency Pause Service is the kill-switch for Celator. When triggered, it immediately blocks all calls to `canExecuteSubmission()` for the affected scope. Queued submission jobs are not processed. Workers that check the gate are blocked.

A pause is appropriate when:
- A security incident is detected or suspected
- A legal hold is placed on a source, client, or jurisdiction
- A data quality issue is found in a playbook or identity match
- An operator account is believed to be compromised
- A bug is discovered that could cause incorrect submissions

## Scopes

| Scope | What It Blocks |
|-------|----------------|
| `GLOBAL` | All execution system-wide |
| `CLIENT` | All tasks for a specific client |
| `BROKER` | All tasks targeting a specific broker/source |
| `OPERATOR` | All approvals and executions tied to a specific operator |
| `JURISDICTION` | All tasks in a specific jurisdiction |

Scopes are additive. Multiple pauses can be active simultaneously. A task must pass all applicable scope checks.

## Triggering a Pause

```typescript
pauseService.triggerPause(
  'CLIENT',
  clientId,
  'Disputed identity match flagged by client — holding all submissions pending review',
  { actorId: adminUserId, actorType: 'ADMIN' },
);
```

Rules:
- Reason must be at least 10 characters (enforce meaningful documentation)
- `GLOBAL` pauses set `requiresDualAdmin: true` (Phase 0 scaffolds this; Phase 1 enforces it)
- Every trigger writes an immutable `AuditLog` entry with `eventType: EMERGENCY_PAUSE_TRIGGERED`
- Pause is immediately effective — no delay, no queue drain

## Resolving a Pause

```typescript
pauseService.resolvePause(
  pauseId,
  'Root cause identified: playbook selector mismatch on broker-xyz. ' +
  'Playbook updated and canary tests passed. Safe to resume.',
  { actorId: adminUserId, actorType: 'ADMIN' },
);
```

Rules:
- Resolution summary must be at least 20 characters (require documented rationale)
- `GLOBAL` pauses: Phase 1 will enforce two-admin consensus before resolving
- Every resolution writes an immutable `AuditLog` entry with `eventType: EMERGENCY_PAUSE_RESOLVED`
- A dual-admin warning is logged in Phase 0 when a GLOBAL pause is resolved by a single admin

## GLOBAL Pause — Dual-Admin Consensus (Phase 1)

A GLOBAL pause affects all clients, all operators, and all executions. The risk of accidental resolution is high. Phase 1 will enforce:

1. First admin triggers the pause
2. Second admin (different user ID) explicitly approves the resolution
3. Both approvals are logged
4. Only after second approval does the pause resolve

In Phase 0, the data model (`requiresDualAdmin`, `secondAdminApprovedBy`, `secondAdminApprovedAt`) is in place but the workflow is not enforced.

## isPausedFor — Gate Integration

`ApprovalGateService.canExecuteSubmission()` calls `isPausedFor(context)` as check #25. The context includes `clientId`, `operatorId`, `brokerRef`, and `jurisdiction`. If any active pause matches, the gate returns `blocked`.

```typescript
pauseService.isPausedFor({
  clientId: 'client_001',
  operatorId: 'op_001',
  brokerRef: 'broker-xyz',
  jurisdiction: 'US-CA',
});
// Returns true if any active pause scope matches any of these values
```

## Audit Trail

All pause events are immutable. The `EmergencyPauseEvent` table stores the full history of every pause trigger and resolution, with actor IDs and timestamps.

The `AuditLog` table additionally receives entries for every trigger and resolve, creating two independent audit records per event.

Pause events are never deleted. They are the security incident log for Celator.
