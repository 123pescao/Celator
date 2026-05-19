# Approval Gate — Design and Reference

## The Non-Negotiable Rule

**No submission, deletion, opt-out, or removal action may execute without explicit, deliberate operator approval.**

The approval gate is the enforcement mechanism. It is not advisory. It does not warn and proceed. Every check that fails blocks execution completely.

## ApprovalSnapshotService — Signed Review Packets

### Why Signed Snapshots

Operator approval is not a permission flag. It is a cryptographic commitment to a specific payload at a specific point in time.

Without signed snapshots, an attacker or bug could:
- Modify the submission payload after approval
- Reuse an approval from a different task
- Submit to a different broker than was approved
- Change the identity match after approval

### Snapshot Contents

Every review packet snapshot contains:

```
taskId              — the specific task being approved
clientId            — the client whose data is affected
caseId              — the case this task belongs to
actionType          — exactly what action is being taken
sourceRef           — the broker/source being submitted to
findingUrl          — the specific exposure being addressed
submissionFields    — the exact data that will be submitted
playbookVersion     — the playbook version used
requestTemplateHash — hash of the request template
evidenceIds         — IDs of supporting evidence
payloadHash         — SHA-256 of the canonicalized payload
snapshotSignature   — HMAC-SHA256 of payloadHash using KMS signing key
signingKeyVersion   — identifies which signing key to use for verification
snapshotExpiresAt   — when this snapshot becomes invalid
riskTier            — STANDARD, MEDIUM, or HIGH
```

### Canonicalization

JSON serialization is deterministic: object keys are sorted recursively before hashing. Key order in the payload does not affect the hash. Any value change (including adding a field, removing a field, or changing any value) changes the hash.

### Expiry Windows

| Action Type              | Risk Tier | Expires In |
|--------------------------|-----------|------------|
| OPT_OUT, DO_NOT_SELL     | STANDARD  | 14 days    |
| DELETE_PERSONAL_DATA     | STANDARD  | 30 days    |
| DELETE_PERSONAL_DATA     | HIGH      | 7 days     |
| LEGAL_ESCALATION         | Any       | 7 days     |
| Any                      | HIGH      | 7 days     |

### Evidence Holds

When a snapshot is created, a `SnapshotEvidenceHold` record is created for each evidence ID in the snapshot. Evidence referenced by an active snapshot cannot be deleted by retention jobs. Holds are released when the snapshot is marked USED, EXPIRED, or INVALIDATED.

### Snapshot Lifecycle

```
ACTIVE → USED (after successful execution)
ACTIVE → EXPIRED (after snapshotExpiresAt has passed)
ACTIVE → INVALIDATED (if payload changes, playbook changes, or security event)
```

Only ACTIVE snapshots can be approved. Only ACTIVE non-expired snapshots can be executed.

## canExecuteSubmission — 39-Point Gate

The gate receives a `GateContext` and returns:

```typescript
{
  allowed: boolean,
  blockedBy: string[],        // which checks failed
  requiredActions: string[],  // what operator must do to unblock
  auditEventId?: string       // every call writes an audit event
}
```

### Checks

| # | Check | Why |
|---|-------|-----|
| 1 | Client exists | No orphan submissions |
| 2 | Client status is ACTIVE | SUSPENDED, DISPUTED, CLOSED clients cannot submit |
| 3 | Client identity verification complete | No submissions for unverified clients |
| 4 | Client authorization exists | No consent = no action |
| 5 | Authorization scope covers action type | Consent must specifically permit this action |
| 6 | Authorization not expired | Time-limited consents must be renewed |
| 7 | Authorization not revoked | Revoked consent cannot be used |
| 8 | Task linked to a cleanup case | No orphan tasks |
| 9 | Match is CONFIRMED_MATCH or CLIENT_CONFIRMED | Never submit on an unconfirmed match |
| 10 | Operator approval exists | The central rule |
| 11 | Operator account is ACTIVE | Deactivated operators cannot approve |
| 12 | Operator has permission for this org/client | No cross-organization access |
| 13 | Operator MFA was fresh at approval time | Prevents stale MFA approvals |
| 14 | Operator approval rate not exceeded | Prevents rubber-stamping |
| 15 | Payload hash matches approved hash | No post-approval tampering |
| 16 | Snapshot signature present and key version valid | Structural signature check |
| 17 | Template hash matches if present | Request template unchanged |
| 18 | Playbook version matches if present | No outdated playbook execution |
| 19 | Source/broker not on legal hold | Legal holds block all submissions |
| 20 | Task not recently resubmitted with same payload | Deduplication |
| 21 | No CAPTCHA/login/ID/payment requirement appeared | Preflight structural check |
| 22 | No unresolved high-risk flags | Senior/specialist review required |
| 23 | No client dispute flag | Disputed clients are blocked |
| 24 | No compliance hold | Compliance holds block all submissions |
| 25 | Emergency pause not active | Kill-switch check |
| 26 | Audit log write succeeds | No submission without evidence trail |
| 27 | Evidence capture available | No submission without evidence storage |
| 28 | Snapshot not expired and status is ACTIVE | Stale approvals blocked |
| 29 | Snapshot signature valid (via signing key) | Deep signature verification |
| 30 | Signing key version is valid and not revoked | Key compromise detection |
| 31 | Evidence referenced by snapshot is under hold | No missing evidence |
| 32 | Resubmission history acknowledged | Context-aware re-submissions |
| 33 | Required warning acknowledgments present | Operator saw warnings |
| 34 | Consent scope mapping effective at signedAt | Historical consent evaluation |
| 35 | Consent mapping not retroactively changed | Append-only guarantee |
| 36 | Data minimization enforced | No over-sharing |
| 37 | No optional fields included | Minimum data principle |
| 38 | Single-operator org routes high-risk to L5 | Segregation of duties |
| 39 | Emergency pause unpause state valid | Consistent pause state |

### Fail Closed

If any required context is `undefined` rather than explicitly `false`, the gate returns `blocked`. Unknown state is treated as unsafe. There are no TODO checks that silently pass.

### Audit Trail

Every call to `canExecuteSubmission` writes an `AuditLog` entry with:
- `eventType`: `APPROVAL_GATE_ALLOWED` or `APPROVAL_GATE_BLOCKED`
- `blockedBy`: list of failed check IDs
- `actorId`, `clientId`, `taskId`, `snapshotId`
- `createdAt`

The audit log write happens last. If the write fails, the gate blocks.

## Signing Key Architecture

The signing key used to sign snapshot signatures is **separate** from the PII encryption keys (DEKs).

- Compromise of the signing key allows forged snapshots (bypass the gate)
- Compromise of a PII DEK exposes that client's data but does not allow forged approvals
- Both are serious. Both require separate controls.

In the LocalKmsProvider (development only), both are loaded from environment variables. In production, both must be stored in a real KMS (AWS KMS, GCP Cloud KMS, HashiCorp Vault), with access policies restricting the signing key to the Approval Service only.
