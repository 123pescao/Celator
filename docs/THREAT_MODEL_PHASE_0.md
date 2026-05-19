# Threat Model — Phase 0: Security Foundation

This document covers the security threats most relevant to the Phase 0 architecture and describes the controls that mitigate them.

---

## 1. Approval Bypass

**Threat:** An attacker (or compromised worker, or bug) submits a deletion/opt-out request without a valid operator approval.

**Attack vectors:**
- Calling the execution service directly, bypassing `canExecuteSubmission()`
- Setting task status to `SUBMITTED` directly via a database write
- Reusing an approval from a different task or a different payload

**Controls:**
- `canExecuteSubmission()` is called by the Execution Service as a mandatory gate — execution logic is separated from approval logic by service boundary
- Task status can only transition from `READY_TO_SUBMIT` → `SUBMITTED` via the state machine. Direct DB writes cannot create a valid `SUBMITTED` status without a corresponding approval and snapshot
- Check #15: payload hash mismatch blocks re-used or tampered approvals
- Check #10: no approval = no execution (fail closed)
- Check #16/29/30: snapshot signature and key version checks

**Residual risk:** A compromised database with write access could inject fake approval records. Mitigate in production with: row-level security on the `operator_approvals` table, audit log write to a separate store, and DB write alerts for approval records.

---

## 2. Queue Poisoning

**Threat:** An attacker injects malicious tasks into the queue that appear approved but were not legitimately prepared.

**Attack vectors:**
- Direct DB inserts of `CleanupTask` with `OPERATOR_APPROVED` status
- Injecting a task referencing a real snapshot from a different task

**Controls:**
- State machine enforces `FOUND` → ... → `OPERATOR_APPROVED` path. No task can be created already in OPERATOR_APPROVED status through the service layer
- Check #8: task must be linked to a cleanup case
- Check #15: payload hash on the approval references the specific payload — cross-task snapshot reuse is blocked
- Audit log captures all status transitions

---

## 3. Snapshot Tampering

**Threat:** An attacker modifies a review packet snapshot after the operator approves it, to change what gets submitted.

**Attack vectors:**
- Modifying `submissionFields` in the approved snapshot
- Modifying the `findingUrl` or `sourceRef` after approval
- Changing the `actionType` after approval

**Controls:**
- `payloadHash` is SHA-256 of the canonical serialized payload — any change changes the hash
- `snapshotSignature` is HMAC-SHA256 of the `payloadHash` — a changed hash produces a different signature which fails verification
- Check #15: current payload hash must match approved payload hash at execution time
- Check #16/29: signature verified using KMS signing key at execution time
- Snapshots are immutable once created — no update methods exist in the service

**Residual risk:** If the signing key is compromised, forged signatures become possible. See Threat #4.

---

## 4. Signing Key Compromise

**Threat:** An attacker obtains the snapshot signing key and generates forged approval signatures.

**Attack vectors:**
- Environment variable exposure (`LOCAL_KMS_SIGNING_SECRET` in plaintext)
- KMS access policy misconfiguration allowing unauthorized access
- Insider threat with KMS admin access

**Controls:**
- Signing key is separate from PII encryption keys — compromise of one does not compromise the other
- `signingKeyVersion` is stored with every snapshot — a key rotation invalidates all existing signatures for the old version
- Check #30: signing key version must be valid and not revoked
- In production: KMS access policy restricts signing key to Approval Service only, with CloudTrail/equivalent logging
- All KMS key usage is logged in the KMS audit trail (production requirement)

**Response to key compromise:**
1. Trigger GLOBAL emergency pause immediately
2. Rotate the signing key in KMS
3. Invalidate all pending snapshots (set `snapshotStatus = INVALIDATED`)
4. Require new review packets for all affected tasks
5. Review KMS access logs to determine scope of compromise
6. Audit all approvals signed with the compromised key

---

## 5. PII Leakage via Logs

**Threat:** Personal information (email, phone, address, etc.) appears in application logs, where it may be collected by log aggregation systems, accessed by unauthorized users, or retained beyond the client's deletion request.

**Attack vectors:**
- Logging a plaintext identifier directly
- Logging a full client object that contains vault record ciphertexts or decrypted values
- Logging an approval payload that contains submission fields with PII
- Error messages that include PII in stack traces

**Controls:**
- `PiiSafeLogger` uses pino's `redact` feature to remove 30+ known PII field names from structured log output
- `scrubPiiFromString()` applies regex-based pattern scrubbing to log message strings (email, phone, SSN, card, bearer token)
- `IdentityVaultService` does not log plaintext values at any level
- The vault access log stores only record IDs and purpose codes, never field values
- Review packets include a `redactedPreview` field for operator display — the full payload is hashed, not stored in plaintext in the DB

---

## 6. Consent Revocation Race

**Threat:** A client revokes consent while a task is in the queue between `OPERATOR_APPROVED` and `SUBMITTED`. The submission executes after revocation.

**Attack vectors:**
- Consent revoked at 14:00, execution job runs at 14:01 using an approval from 13:59
- Authorization `revokedAt` set but execution worker reads a cached authorization

**Controls:**
- Check #7: `revokedAt` is evaluated at execution time by `canExecuteSubmission()`, not just at approval time
- Check #5: consent scope is also evaluated at execution time
- `EmergencyPauseService.triggerPause('CLIENT', clientId, ...)` can halt all tasks immediately when revocation is detected
- The state machine can transition active tasks to `PAUSED_BY_SYSTEM` via the universal safe exit

**Residual risk:** If the execution worker doesn't call `canExecuteSubmission()` at execution time (only at queue time), a race is possible. **The execution service must call `canExecuteSubmission()` immediately before every submission, not only when the task enters the queue.**

---

## 7. Operator Compromise

**Threat:** An operator account is compromised (stolen credentials, phishing, insider threat) and is used to approve fraudulent submissions.

**Attack vectors:**
- Stolen password + no MFA
- Session hijacking
- Insider threat with legitimate access

**Controls:**
- Check #13: MFA freshness check — approvals require MFA within the freshness window (default 4 hours)
- Check #14: session approval count limit — excessive approvals in a session trigger re-authentication
- `OperatorQualityMetric` tracks approval rate, review time, bulk attempts — anomalies trigger alerts
- Emergency pause scope `OPERATOR` can halt all approvals tied to a specific operator instantly
- Segregation of duties: high-risk tasks require a different preparer and approver
- Check #38: single-operator organizations cannot self-approve high-risk tasks

**Response to operator compromise:**
1. `pauseService.triggerPause('OPERATOR', operatorId, reason, admin)`
2. Deactivate the operator account (`isActive = false`)
3. Review all approvals made by the operator in the affected window
4. Require new approvals for any tasks approved by the compromised account
5. Check #11 will block execution on any remaining tasks approved by the deactivated operator

---

## 8. Consent Mapping Manipulation

**Threat:** An attacker or malicious admin modifies the `consent_scope_mappings` table to add permissions that were not in clients' original consent documents.

**Attack vectors:**
- Direct DB update on an existing mapping row
- Admin API adding a conflicting mapping without closing the old one

**Controls:**
- `ConsentPolicyService.preventMappingUpdate()` and `preventMappingDelete()` throw immediately
- `appendConsentScopeMapping()` detects conflicting mappings (same scope/action/time but different permitted value) and throws
- `effectiveFrom`/`effectiveUntil` versioning means historical evaluations are stable
- All mapping creations write AuditLog entries
- In production: DB-level triggers or row-level security can enforce the append-only constraint at the database layer

**Residual risk:** A direct DB write bypassing the service layer can still modify mappings. In production: DB write access to `consent_scope_mappings` must require senior admin authorization and must write an audit event to a separate audit store.

---

## 9. Emergency Pause Misuse

**Threats:**
- Denial of service: an attacker or disgruntled insider triggers repeated GLOBAL pauses to halt operations
- Bypass: a GLOBAL pause is resolved prematurely by a single admin with insufficient review

**Controls:**
- Pause trigger requires `ADMIN_TRIGGER_EMERGENCY_PAUSE` permission (admin role only)
- All pause events write immutable `AuditLog` and `EmergencyPauseEvent` records
- GLOBAL pause `requiresDualAdmin = true` — Phase 1 enforces two-admin consensus to resolve
- Resolution requires a minimum 20-character summary (documents the rationale)
- Repeated unnecessary pause/unpause cycles are visible in the audit log

**Residual risk in Phase 0:** Dual-admin enforcement for GLOBAL pause is scaffolded but not fully enforced. A single admin can resolve a GLOBAL pause in Phase 0 (with a warning log). Phase 1 must enforce this.

---

## 10. Crypto-Shredding Limitations

**Threat:** A client requests data deletion. Crypto-shredding destroys the DEK, but residual data may remain in backups, logs, or derived records.

**What crypto-shredding covers:**
- `IdentityVaultRecord` ciphertext — permanently unrecoverable
- Active memory after shredding — future decryption throws immediately

**What crypto-shredding does NOT cover:**
- Database backups created before shredding — the ciphertext in old backups is unrecoverable, but may still be retained
- Audit logs referencing the client ID (these are intentionally retained for compliance)
- `ClientPortalEvent` and timeline records (may be retained for fraud investigation)
- Derived data that was decrypted and stored outside the vault before shredding

**Required mitigations (production):**
- Backup retention policy must specify that restored backups must re-run crypto-shredding for shredded clients
- `ClientDataDeletionRequest` records what was retained and why
- LLM outputs and other derived data must be audited for PII leakage before shredding is declared complete
- DEK deletion must be durable and confirmed by the KMS — in Phase 0 (in-memory KMS), shredding is not durable across restarts

---

## Summary: Open Items for Phase 1

| Threat | Phase 0 Status | Phase 1 Required |
|--------|---------------|-----------------|
| Approval bypass via DB write | Mitigated at service layer | Add DB-level triggers on status transitions |
| Signing key compromise | Detection via key versioning | Enforce KMS access policies; CloudTrail alerting |
| Consent revocation race | Mitigated at gate | Enforce gate call at execution time (not queue time) |
| Operator compromise | Scaffolded rate limits and quality metrics | Implement real-time anomaly alerting |
| GLOBAL pause dual-admin | Data model in place | Enforce two-admin workflow in pause service |
| Crypto-shredding in backups | Documented | Implement backup shredding policy enforcement |
| Audit log tamper protection | In-DB audit log | Add write-once audit export to external store |
