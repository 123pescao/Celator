# Phase 1D — PII Boundary and Protected Data Intake

## Why PII is Not Globally Forbidden

Celator's business purpose is to help operators manage and execute the removal of clients' exposed digital footprint. This work requires receiving, storing, and referencing client identifiers (email, phone, address, etc.) in a controlled manner.

A global "reject all PII everywhere" rule would make the system non-functional. Instead, Phase 1D establishes a **field-aware PII policy** with three distinct zones:

---

## PII Zones

### FORBIDDEN ZONE
PII must never appear in these places:
- Logs and console output
- Audit metadata (`AuditLog.metadata` JSON)
- Case timeline notes (`CaseTimelineEvent.note`)
- Route error messages and HTTP responses (except vault endpoints returning redacted display)
- Stack traces and debug output
- Generic JSON fields not controlled by a specific service

Violations are rejected at write time — fail-closed.

### PROTECTED ZONE
PII is allowed here only through explicit, audited service operations:
- `IdentityVaultRecord.ciphertext` — AES-256-GCM ciphertext only; plaintext never stored
- Future controlled operator review views with purpose tracking
- Future removal payload assembly (planned for Phase 1E)

Access always requires a `VaultPurposeCode` and is logged to `IdentityVaultAccessLog`.

### SAFE_DERIVED ZONE
These values are derived from PII but do not expose it:
- Hashes (SHA-256, document hashes)
- Redacted display values (e.g., `j***@example.com`)
- Field labels (e.g., `"EMAIL"`, `"PHONE"`)
- Counts, risk tiers, action types, source names, match statuses
- IDs and timestamps

---

## PII Policy Module

**Location:** `packages/security/src/pii/`

| File | Purpose |
|---|---|
| `pii-patterns.ts` | Regex patterns and field name sets |
| `pii-zones.ts` | Zone and field type definitions |
| `pii-policy.ts` | `checkAuditMetadata()`, `checkRedactedPreview()` |
| `pii-redaction.ts` | `redactEmail()`, `redactPhone()`, `redactForDisplay()`, etc. |

### False Positive Avoidance

The prior Phase 1C `AuditService` used a broad phone-number regex (`\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b` with optional separators) which matched Unix timestamps and numeric sequences. Phase 1D fixes this:

| Input | Old behavior | New behavior |
|---|---|---|
| `1699999999` (Unix timestamp) | BLOCKED (false positive) | ALLOWED ✓ |
| `999.177947.6851` (semver) | BLOCKED (false positive) | ALLOWED ✓ |
| `abcdef...` (64-char hex hash) | ALLOWED ✓ | ALLOWED ✓ |
| `555-123-4567` (phone with dashes) | BLOCKED ✓ | BLOCKED ✓ |
| `555.123.4567` (phone with dots) | BLOCKED ✓ | BLOCKED ✓ |
| `user@example.com` (email) | BLOCKED ✓ | BLOCKED ✓ |
| `123-45-6789` (SSN) | BLOCKED ✓ | BLOCKED ✓ |

**Key fix:** Phone detection now **requires** explicit separators between digit groups. A 10-digit sequence without separators (`5551234567`) is not flagged as a phone number — it could be a timestamp, a CUID fragment, or any other numeric ID.

### Audit Metadata Check (field-aware)

`checkAuditMetadata(metadata)` rejects:
1. Keys matching known PII field names: `email`, `phone`, `dob`, `address`, `ssn`, `fullName`, `governmentId`, etc. (normalized, case-insensitive)
2. Keys matching credential names: `password`, `secret`, `token`, `apiKey`, `privateKey`, etc.
3. Values containing email pattern (`user@domain.tld`)
4. Values containing phone WITH explicit separators (`555-123-4567`, `555.123.4567`)
5. Values containing SSN pattern (`123-45-6789`)

Recursion depth is capped at 2 levels.

---

## Identity Vault Intake

### Service: `IdentityVaultIntakeService`

**Location:** `packages/core/src/services/identity-vault-intake.service.ts`

DB-backed vault intake using `LocalKmsProvider` (dev) or any `KmsProvider` implementation. Never stores plaintext.

#### `store(input)` → `Result<VaultStoreResult, ErrorCode>`

1. Validates `fieldType` against `VAULT_FIELD_TYPES` enum
2. Validates `purposeCode` against the allowed purpose set
3. Calls `kms.generateDataKey(clientId)` — gets a fresh DEK
4. Encrypts `plaintext` with AES-256-GCM
5. Zeros the plaintext key buffer from memory immediately
6. Computes `redactedDisplay` using `redactForDisplay(fieldType, plaintext)`
7. Persists `IdentityVaultRecord` with ciphertext, iv, authTag, keyId, keyVersion, encryptedKeyRef, redactedDisplay
8. Writes `IdentityVaultAccessLog`
9. Returns `{ recordId, fieldType, redactedDisplay, createdAt }`

The response **never** contains the plaintext value or the raw ciphertext.

#### `listMetadata(clientId)` → `VaultRecordMetadata[]`

Returns: `id`, `fieldType`, `redactedDisplay`, `isCryptoShredded`, `createdAt`.
Never returns ciphertext, iv, authTag, or plaintext.

#### `logAccess(recordId, purposeCode, actorId, actorType)` → `Result<VaultAccessResult, ErrorCode>`

Validates the record exists and is not crypto-shredded, writes an access log, returns `redactedDisplay`. No decryption occurs in Phase 1D.

### Supported Field Types

`EMAIL`, `PHONE`, `ADDRESS`, `FULL_NAME`, `DOB`, `USERNAME`, `GOVERNMENT_ID`, `URL`, `OTHER`

### Supported Purpose Codes

`PURPOSE_OPERATOR_REVIEW_PACKET`, `PURPOSE_FORM_FILL`, `PURPOSE_REPORT_GENERATION`, `PURPOSE_CLIENT_EXPORT`, `PURPOSE_DEK_ROTATION`

### encryptedKeyRef column

`IdentityVaultRecord` now stores `encryptedKeyRef` (nullable). For dev `LocalKmsProvider`, this is the wrapped DEK blob needed for future decryption. In a production KMS environment, this would be null — the KMS holds the key by `keyId`.

---

## Redaction Utilities

**Location:** `packages/security/src/pii/pii-redaction.ts`

| Function | Input | Output |
|---|---|---|
| `redactEmail(email)` | `alice@example.com` | `a***@example.com` |
| `redactPhone(phone)` | `787-555-1212` | `***-***-1212` |
| `redactAddress(addr)` | `123 Main St` | `[REDACTED_ADDRESS]` |
| `redactDob(dob)` | `1990-01-15` | `[REDACTED_DOB]` |
| `redactName(name)` | `Jane Doe` | `J*** [REDACTED_NAME]` |
| `redactForDisplay(fieldType, value)` | dispatches by type | appropriate redaction |

---

## Audit Metadata Policy

The updated `AuditService` uses `checkAuditMetadata()` (from the PII policy module) instead of the prior raw regex check.

**Allowed in audit metadata:**
- IDs (cuid, uuid, database IDs)
- Timestamps (numeric or ISO string)
- Hashes (hex strings, base64 strings)
- Version strings (semver, custom formats)
- Enums (`riskTier`, `outcome`, `decision`, `matchStatus`)
- Source names and refs
- Counts and booleans

**Rejected in audit metadata:**
- Raw email addresses
- Phone numbers with explicit separators
- SSN-formatted strings
- Fields named: `email`, `phone`, `dob`, `address`, `ssn`, `fullName`, etc.
- Fields named: `password`, `secret`, `token`, `apiKey`, etc.

---

## Review Packet Redacted Preview

`ReviewPacketService.create()` now validates `redactedPreview` before creating the snapshot, using `checkRedactedPreview()`.

**Rejected:**
- Raw email addresses in the preview text
- Phone numbers with separators
- SSN-formatted strings

**Allowed:**
- Redacted tokens: `j***@example.com`, `***-***-4567`
- Hashes, version strings, counts
- Broker names, task IDs, action types

Error code: `PII_FORBIDDEN_IN_REDACTED_PREVIEW`

---

## Identity Vault API Endpoints

All vault endpoints require a valid actor via `X-Dev-Actor-Id`.
Responses never return plaintext.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/clients/:clientId/vault-records` | Store encrypted PII; returns `redactedDisplay` |
| `GET` | `/api/v1/clients/:clientId/vault-records` | List vault record metadata; no plaintext |
| `POST` | `/api/v1/vault-records/:recordId/access` | Log access event; returns `redactedDisplay` |

No decrypt endpoint exists in Phase 1D.

---

## Data Source Target Model Foundation

`DataSourceTarget` is a new Prisma model describing data broker and platform targets for future deletion/opt-out workflows. It does not execute any removal actions.

**Fields:** `sourceName`, `sourceType` (`DATA_BROKER`, `SEARCH_ENGINE`, `SOCIAL_PLATFORM`, `PUBLIC_RECORD_SITE`, `PEOPLE_SEARCH`, `BREACH_INDEX`, `OTHER`), `baseDomain`, `jurisdiction`, `supportedActionTypes`, `requiresLogin`, `requiresCaptcha`, `manualOnly`, `piiRequiredFields`, `notes`, `isActive`.

Future phases will use this model to know what PII fields are required and what actions are supported before preparing deletion packets. No scraping, no HTTP requests.

---

## New Error Codes (Phase 1D)

| Code | Meaning |
|---|---|
| `PII_FORBIDDEN_IN_REDACTED_PREVIEW` | Raw PII detected in `redactedPreview` |
| `VAULT_FIELD_TYPE_INVALID` | Unknown `fieldType` passed to vault intake |

---

## What Remains Out of Scope

- Vault decryption endpoint (Phase 1E)
- DEK rotation for DB-backed records (Phase 1E)
- Crypto-shredding via API (Phase 1E)
- Production KMS integration (production readiness phase)
- Removal payload assembly using vault records
- Browser automation, scraping, deletion submission
- Frontend dashboard or client portal UI
- Email/notification sending
- LLM integration (permanently out of scope)

---

## Schema Migration

Migration: `packages/db/prisma/migrations/20260522000001_phase1d/migration.sql`

Changes:
- Added `encrypted_key_ref TEXT` to `identity_vault_records`
- Added `redacted_display TEXT` to `identity_vault_records`
- Added `SourceType` enum
- Added `data_source_targets` table
