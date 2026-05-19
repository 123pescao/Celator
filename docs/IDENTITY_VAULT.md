# Identity Vault — Design and Reference

## Overview

The Identity Vault is the only place in Celator where raw PII is stored. All client identifiers (email, phone, address, DOB, etc.) are encrypted at rest using AES-256-GCM with per-client Data Encryption Keys (DEKs). The DEKs are managed by the KMS abstraction, not stored in the application database.

No other service in Celator decrypts PII. If another service needs a client identifier, it must call the Identity Vault with a valid purpose code.

## Encryption Model

### Algorithm

AES-256-GCM with:
- 256-bit key (per-client DEK)
- 96-bit random IV per operation (never reused)
- 128-bit authentication tag (prevents ciphertext tampering)

The authentication tag provides integrity protection. If ciphertext is modified after encryption, decryption fails with an authentication error, not silently corrupt data.

### Per-Client DEKs

Each client gets their own Data Encryption Key. The DEK is:
1. Generated as 32 random bytes (AES-256)
2. Wrapped (encrypted) by the master key in the KMS
3. The wrapped DEK reference is stored in the application database
4. The plaintext DEK is never stored anywhere

To decrypt a vault record:
1. Retrieve the wrapped DEK reference from the key store
2. Call KMS to unwrap (decrypt) the DEK
3. Use the plaintext DEK to decrypt the vault record
4. Zero the plaintext DEK from memory immediately after use

### Key Versioning

DEKs are versioned. When a key is rotated, the old version is retained until all records using it have been re-encrypted. Each vault record stores the key version used to encrypt it.

## KMS Abstraction

The `KmsProvider` interface abstracts the key management system. In Phase 0, the `LocalKmsProvider` is used for development. In production, this must be replaced with a real KMS implementation.

### LocalKmsProvider (Development Only)

- Wraps DEKs using AES-256-GCM with a master secret from the environment
- Signing key is separate from the master secret (loaded from `LOCAL_KMS_SIGNING_SECRET`)
- All key material in memory only — not persisted to disk
- **NOT suitable for production**

### Production KMS Requirements

The production KMS implementation must:
- Use AWS KMS, GCP Cloud KMS, HashiCorp Vault, or equivalent
- Store DEKs as KMS key material (not in the application DB)
- Support key versioning and rotation
- Log all key usage to an immutable audit system
- Apply IAM policies: only the Identity Vault service can access PII DEKs
- Apply IAM policies: only the Approval Service can access the signing key
- Signing key and PII DEKs must be separate keys with separate access policies

## Purpose Codes

Every decrypt call requires a valid `VaultPurposeCode`. This prevents accidental decryption for unauthorized uses.

| Code | Description |
|------|-------------|
| `PURPOSE_OPERATOR_REVIEW_PACKET` | Generating an operator review packet |
| `PURPOSE_FORM_FILL` | Filling a broker opt-out form (Phase 3+) |
| `PURPOSE_REPORT_GENERATION` | Generating a client privacy report |
| `PURPOSE_CLIENT_EXPORT` | Client data export / GDPR subject access |
| `PURPOSE_DEK_ROTATION` | DEK rotation job |

### Denied Purposes

The following purpose codes are explicitly denied and will throw immediately:

- `PURPOSE_LLM_CLASSIFICATION`
- `PURPOSE_LLM_DRAFTING`
- `PURPOSE_LLM_ANY`
- `PURPOSE_LOG`
- `PURPOSE_SEARCH`
- `PURPOSE_ANALYTICS`

Any unknown purpose code is also denied (fail closed).

## Access Logs

Every decrypt call writes an `IdentityVaultAccessLog` record containing:
- `recordId` — which vault record was accessed
- `clientId` — which client's data
- `purposeCode` — why it was accessed
- `actorId` + `actorType` — who accessed it
- `accessedAt` — timestamp

The access log is written **before** decryption succeeds. If the decrypt fails (authentication error, key not found, etc.), the access attempt is still logged.

The access log never contains:
- Plaintext values
- Ciphertext values
- Key material
- Full identity profiles

## DEK Rotation

DEK rotation is triggered by `rotateClientDek(clientId)`. The rotation process:

1. Generates a new DEK for the client
2. Re-encrypts all vault records using the new DEK
3. Updates key version references on each record
4. Records the job in `DekRotationJob` for audit

The rotation job is idempotent: if a job is already `IN_PROGRESS` for a client, the second call returns the existing job rather than starting a conflicting rotation.

After rotation, the old DEK version is retained until the grace period expires (in production). During the grace period, both old and new DEK versions can decrypt (needed for in-flight operations).

## Crypto-Shredding

`cryptoShredClient(clientId)` implements the "deletion by key destruction" pattern:

1. All vault records for the client are marked `isCryptoShredded = true`
2. The client's DEK material is removed from the key store
3. The client is added to the `shreddedClients` set
4. Future decryption attempts throw immediately

Because the DEK is destroyed, the ciphertext in the database becomes permanently unrecoverable. No database purge is required to achieve data deletion — the key destruction is sufficient.

In production, "destroy the DEK" means instructing the KMS to delete the key material. The ciphertext rows can remain in the database indefinitely without risk.

### Limitations

- Crypto-shredding is permanent. There is no undo.
- In Phase 0 (in-memory KMS), shredding is not durable across restarts.
- In production, DEK deletion must be durable and confirmed by the KMS before shredding is declared complete.
- Audit logs, timeline events, and anonymized records that don't reference the vault may be retained for legal compliance even after shredding.
