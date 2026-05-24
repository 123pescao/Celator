import { describe, it, expect } from 'vitest';
import {
  redactEmail,
  redactPhone,
  redactAddress,
  redactDob,
  redactName,
  redactForDisplay,
} from '../pii/pii-redaction.js';

describe('redactEmail', () => {
  it('redacts a standard email', () => {
    expect(redactEmail('joel@example.com')).toBe('j***@example.com');
  });

  it('keeps only the first character of local part', () => {
    expect(redactEmail('alice@domain.org')).toBe('a***@domain.org');
  });

  it('handles single-character local part', () => {
    expect(redactEmail('a@b.com')).toBe('a***@b.com');
  });

  it('returns [REDACTED_EMAIL] for malformed input (no @)', () => {
    expect(redactEmail('notanemail')).toBe('[REDACTED_EMAIL]');
  });
});

describe('redactPhone', () => {
  it('redacts a hyphenated phone', () => {
    expect(redactPhone('787-555-1212')).toBe('***-***-1212');
  });

  it('redacts a raw 10-digit phone', () => {
    expect(redactPhone('7875551212')).toBe('***-***-1212');
  });

  it('shows only last 4 digits', () => {
    expect(redactPhone('555-867-5309')).toBe('***-***-5309');
  });

  it('returns [REDACTED_PHONE] for very short input', () => {
    expect(redactPhone('123')).toBe('[REDACTED_PHONE]');
  });
});

describe('redactAddress', () => {
  it('always returns REDACTED_ADDRESS', () => {
    expect(redactAddress('123 Main St, San Juan, PR 00901')).toBe('[REDACTED_ADDRESS]');
    expect(redactAddress('')).toBe('[REDACTED_ADDRESS]');
  });
});

describe('redactDob', () => {
  it('always returns REDACTED_DOB', () => {
    expect(redactDob('1990-01-15')).toBe('[REDACTED_DOB]');
  });
});

describe('redactName', () => {
  it('keeps only the first character', () => {
    expect(redactName('John Smith')).toBe('J*** [REDACTED_NAME]');
  });

  it('handles empty name', () => {
    expect(redactName('')).toBe('[REDACTED_NAME]');
  });
});

describe('redactForDisplay', () => {
  it('dispatches EMAIL to redactEmail', () => {
    expect(redactForDisplay('EMAIL', 'alice@example.com')).toBe('a***@example.com');
  });

  it('dispatches PHONE to redactPhone', () => {
    expect(redactForDisplay('PHONE', '555-123-4567')).toBe('***-***-4567');
  });

  it('dispatches ADDRESS to redactAddress', () => {
    expect(redactForDisplay('ADDRESS', '1 Main St')).toBe('[REDACTED_ADDRESS]');
  });

  it('dispatches DOB to redactDob', () => {
    expect(redactForDisplay('DOB', '2000-12-31')).toBe('[REDACTED_DOB]');
  });

  it('dispatches FULL_NAME to redactName', () => {
    expect(redactForDisplay('FULL_NAME', 'Jane Doe')).toBe('J*** [REDACTED_NAME]');
  });

  it('dispatches GOVERNMENT_ID', () => {
    expect(redactForDisplay('GOVERNMENT_ID', 'ABC123456')).toBe('[REDACTED_GOVERNMENT_ID]');
  });

  it('dispatches USERNAME', () => {
    expect(redactForDisplay('USERNAME', 'batman')).toBe('b***');
  });

  it('dispatches URL', () => {
    expect(redactForDisplay('URL', 'https://example.com/profile/123')).toBe('[REDACTED_URL]');
  });

  it('dispatches OTHER as generic redacted', () => {
    expect(redactForDisplay('OTHER', 'anything')).toBe('[REDACTED]');
  });
});
