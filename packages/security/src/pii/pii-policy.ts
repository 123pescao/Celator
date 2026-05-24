/**
 * Field-aware PII policy for Celator.
 *
 * Two kinds of checks:
 *
 * 1. Audit metadata check — rejects forbidden field names (email, phone, dob…) AND
 *    rejects values that match PII patterns (email regex, phone-with-separator, SSN).
 *    Timestamps, UUIDs, CUIDs, hex hashes, and semver strings are NOT rejected.
 *
 * 2. Redacted-preview check — rejects raw PII patterns in free-text review packet summaries.
 *    Applied before storing ApprovalPayloadSnapshot.redactedPreview.
 */

import {
  EMAIL_PATTERN,
  PHONE_WITH_SEPARATOR_PATTERN,
  SSN_PATTERN,
  PII_FIELD_NAMES,
  CREDENTIAL_FIELD_NAMES,
} from './pii-patterns.js';

// ---------------------------------------------------------------------------
// Audit metadata checks
// ---------------------------------------------------------------------------

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase().replace(/[_\-\s]/g, '');
  return PII_FIELD_NAMES.has(lower) || CREDENTIAL_FIELD_NAMES.has(lower);
}

function isForbiddenValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (EMAIL_PATTERN.test(value)) return true;
  if (PHONE_WITH_SEPARATOR_PATTERN.test(value)) return true;
  if (SSN_PATTERN.test(value)) return true;
  return false;
}

function checkObject(obj: Record<string, unknown>, depth: number): string | null {
  if (depth > 2) return null; // Don't recurse deeper than 2 levels
  for (const [key, value] of Object.entries(obj)) {
    if (isForbiddenKey(key)) {
      return `forbidden field name "${key}" in audit metadata`;
    }
    if (isForbiddenValue(value)) {
      return `PII pattern detected in field "${key}" in audit metadata`;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = checkObject(value as Record<string, unknown>, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Check audit metadata for PII violations.
 * Returns an error description string if a violation is found, or null if clean.
 */
export function checkAuditMetadata(metadata: unknown): string | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return checkObject(metadata as Record<string, unknown>, 0);
}

// ---------------------------------------------------------------------------
// Redacted-preview checks
// ---------------------------------------------------------------------------

/**
 * Validate that a free-text redacted preview does not contain raw PII.
 * Returns an error description string if a violation is found, or null if clean.
 */
export function checkRedactedPreview(preview: string): string | null {
  if (EMAIL_PATTERN.test(preview)) return 'raw email detected in redactedPreview';
  if (PHONE_WITH_SEPARATOR_PATTERN.test(preview)) return 'phone pattern detected in redactedPreview';
  if (SSN_PATTERN.test(preview)) return 'SSN pattern detected in redactedPreview';
  return null;
}
