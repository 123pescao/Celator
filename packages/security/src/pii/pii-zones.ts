/**
 * PII zone and field type definitions for Celator.
 *
 * Celator's business purpose requires handling PII safely — not pretending it doesn't exist.
 * The design distinguishes three zones:
 *
 * FORBIDDEN  — PII must never appear here (logs, audit metadata, error messages, timeline notes)
 * PROTECTED  — PII is allowed only through explicit service operations with purpose tracking
 *              (IdentityVaultRecord ciphertext, controlled operator review with access logging)
 * SAFE_DERIVED — Safe summaries derived from PII (hashes, redacted previews, counts, enums)
 */

export type PiiZone = 'FORBIDDEN' | 'PROTECTED' | 'SAFE_DERIVED';

export type PiiFieldType =
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS'
  | 'FULL_NAME'
  | 'DOB'
  | 'USERNAME'
  | 'GOVERNMENT_ID'
  | 'URL'
  | 'IP_ADDRESS'
  | 'OTHER';

/** Field types accepted by the Identity Vault for intake */
export const VAULT_FIELD_TYPES: ReadonlySet<PiiFieldType> = new Set([
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'FULL_NAME',
  'DOB',
  'USERNAME',
  'GOVERNMENT_ID',
  'URL',
  'OTHER',
]);

export function isValidVaultFieldType(value: string): value is PiiFieldType {
  return VAULT_FIELD_TYPES.has(value as PiiFieldType);
}
