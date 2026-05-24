/**
 * Redaction utilities — produce safe display strings from PII values.
 *
 * These functions always return a redacted string. They never throw.
 * Input is consumed only to compute the safe representation — it is never
 * stored, logged, or returned after redaction.
 */

import type { PiiFieldType } from './pii-zones.js';

export function redactEmail(email: string): string {
  const atIdx = email.indexOf('@');
  if (atIdx <= 0) return '[REDACTED_EMAIL]';
  const local = email.substring(0, atIdx);
  const domain = email.substring(atIdx); // includes @
  const prefix = local.length > 0 ? local[0] : '';
  return `${prefix}***${domain}`;
}

export function redactPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '[REDACTED_PHONE]';
  return `***-***-${digits.slice(-4)}`;
}

export function redactAddress(_address: string): string {
  return '[REDACTED_ADDRESS]';
}

export function redactDob(_dob: string): string {
  return '[REDACTED_DOB]';
}

export function redactName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '[REDACTED_NAME]';
  return `${trimmed[0]}*** [REDACTED_NAME]`;
}

export function redactGovernmentId(_id: string): string {
  return '[REDACTED_GOVERNMENT_ID]';
}

export function redactUrl(_url: string): string {
  return '[REDACTED_URL]';
}

export function redactIp(_ip: string): string {
  return '[REDACTED_IP]';
}

/**
 * Compute a safe display value for a PII field.
 * Used to store a pre-computed redacted display alongside ciphertext in the vault.
 */
export function redactForDisplay(fieldType: PiiFieldType, value: string): string {
  switch (fieldType) {
    case 'EMAIL':
      return redactEmail(value);
    case 'PHONE':
      return redactPhone(value);
    case 'ADDRESS':
      return redactAddress(value);
    case 'DOB':
      return redactDob(value);
    case 'FULL_NAME':
      return redactName(value);
    case 'GOVERNMENT_ID':
      return redactGovernmentId(value);
    case 'USERNAME': {
      const t = value.trim();
      return t.length > 0 ? `${t[0]}***` : '[REDACTED_USERNAME]';
    }
    case 'URL':
      return redactUrl(value);
    case 'IP_ADDRESS':
      return redactIp(value);
    default:
      return '[REDACTED]';
  }
}
