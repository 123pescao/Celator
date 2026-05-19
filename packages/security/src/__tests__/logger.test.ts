import { describe, it, expect } from 'vitest';
import { scrubPiiFromString, createLogger } from '../logger/pii-safe-logger.js';

describe('PiiSafeLogger — scrubPiiFromString', () => {
  it('redacts email addresses', () => {
    const result = scrubPiiFromString('Contact user@example.com for details');
    expect(result).not.toContain('user@example.com');
    expect(result).toContain('[EMAIL_REDACTED]');
  });

  it('redacts US phone numbers', () => {
    const result = scrubPiiFromString('Call (555) 123-4567 for support');
    expect(result).not.toContain('555');
    expect(result).toContain('[PHONE_REDACTED]');
  });

  it('redacts SSN formatted values', () => {
    const result = scrubPiiFromString('SSN: 123-45-6789 is on file');
    expect(result).not.toContain('123-45-6789');
    expect(result).toContain('[SSN_REDACTED]');
  });

  it('redacts credit card numbers', () => {
    const result = scrubPiiFromString('Card: 4111 1111 1111 1111');
    expect(result).not.toContain('4111');
    expect(result).toContain('[CARD_REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const result = scrubPiiFromString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result).toContain('[BEARER_REDACTED]');
  });

  it('returns safe strings unchanged', () => {
    const safe = 'Task task_001 transitioned from FOUND to CLASSIFIED';
    expect(scrubPiiFromString(safe)).toBe(safe);
  });

  it('redacts multiple PII items in one string', () => {
    const result = scrubPiiFromString('User user@test.com called 555-123-4567');
    expect(result).not.toContain('user@test.com');
    expect(result).not.toContain('555-123-4567');
  });
});

describe('PiiSafeLogger — createLogger', () => {
  it('creates a logger without throwing', () => {
    expect(() => createLogger({ name: 'test', level: 'silent' })).not.toThrow();
  });

  it('logger has info, warn, error methods', () => {
    const logger = createLogger({ name: 'test', level: 'silent' });
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
