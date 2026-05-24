import { describe, it, expect } from 'vitest';
import { checkAuditMetadata, checkRedactedPreview } from '../pii/pii-policy.js';

describe('checkAuditMetadata', () => {
  describe('allows safe metadata', () => {
    it('allows null metadata', () => {
      expect(checkAuditMetadata(null)).toBeNull();
    });

    it('allows non-object metadata', () => {
      expect(checkAuditMetadata('someString')).toBeNull();
      expect(checkAuditMetadata(42)).toBeNull();
    });

    it('allows enum values', () => {
      expect(checkAuditMetadata({ riskTier: 'HIGH', outcome: 'ALLOWED' })).toBeNull();
    });

    it('allows IDs and counts', () => {
      expect(checkAuditMetadata({ taskId: 'task_abc123', count: 5 })).toBeNull();
    });

    it('allows Unix timestamp (no separators — not phone-like)', () => {
      // This was the Phase 1C false positive: a 10-digit timestamp with no separators
      expect(checkAuditMetadata({ ts: 1699999999 })).toBeNull();
      expect(checkAuditMetadata({ createdAt: '1699999999' })).toBeNull();
    });

    it('allows 64-character hex documentHash', () => {
      const hash = 'a'.repeat(32) + 'b'.repeat(32); // 64-char hex-like string
      expect(checkAuditMetadata({ documentHash: hash })).toBeNull();
    });

    it('allows semver-style version string', () => {
      // e.g. "999.177947.6851" — the Phase 1C smoke script format
      expect(checkAuditMetadata({ version: '999.177947.6851' })).toBeNull();
      expect(checkAuditMetadata({ version: '1.2.3' })).toBeNull();
    });

    it('allows CUIDs', () => {
      expect(checkAuditMetadata({ clientId: 'clhw4k8fg0000abcd12345678' })).toBeNull();
    });

    it('allows sourceName and sourceRef', () => {
      expect(checkAuditMetadata({ sourceName: 'acxiom', sourceRef: 'broker-123' })).toBeNull();
    });

    it('allows boolean values', () => {
      expect(checkAuditMetadata({ isActive: true, verified: false })).toBeNull();
    });

    it('allows redacted email-like strings that start with [REDACTED', () => {
      expect(checkAuditMetadata({ contact: '[REDACTED_EMAIL]' })).toBeNull();
    });
  });

  describe('rejects PII field names', () => {
    it('rejects "email" key', () => {
      expect(checkAuditMetadata({ email: 'anything' })).not.toBeNull();
    });

    it('rejects "phone" key', () => {
      expect(checkAuditMetadata({ phone: '555-123-4567' })).not.toBeNull();
    });

    it('rejects "dob" key', () => {
      expect(checkAuditMetadata({ dob: '1990-01-01' })).not.toBeNull();
    });

    it('rejects "address" key', () => {
      expect(checkAuditMetadata({ address: '123 Main St' })).not.toBeNull();
    });

    it('rejects "ssn" key', () => {
      expect(checkAuditMetadata({ ssn: '123-45-6789' })).not.toBeNull();
    });

    it('rejects "fullName" key', () => {
      expect(checkAuditMetadata({ fullName: 'Jane Doe' })).not.toBeNull();
    });
  });

  describe('rejects credential field names', () => {
    it('rejects "password" key', () => {
      expect(checkAuditMetadata({ password: 'hunter2' })).not.toBeNull();
    });

    it('rejects "token" key', () => {
      expect(checkAuditMetadata({ token: 'abc.def.ghi' })).not.toBeNull();
    });

    it('rejects "secret" key', () => {
      expect(checkAuditMetadata({ secret: 'shhh' })).not.toBeNull();
    });

    it('rejects "apiKey" key', () => {
      expect(checkAuditMetadata({ apiKey: 'sk-abc123' })).not.toBeNull();
    });
  });

  describe('rejects PII value patterns', () => {
    it('rejects value containing email pattern', () => {
      expect(checkAuditMetadata({ info: 'user@example.com' })).not.toBeNull();
    });

    it('rejects value containing phone WITH separators', () => {
      expect(checkAuditMetadata({ info: '555-123-4567' })).not.toBeNull();
      expect(checkAuditMetadata({ info: '555.123.4567' })).not.toBeNull();
      expect(checkAuditMetadata({ info: '555 123 4567' })).not.toBeNull();
    });

    it('does NOT reject phone digits without separators (timestamp-like)', () => {
      // 10 consecutive digits without separators should not be flagged
      expect(checkAuditMetadata({ info: '5551234567' })).toBeNull();
    });

    it('rejects SSN pattern', () => {
      expect(checkAuditMetadata({ info: '123-45-6789' })).not.toBeNull();
    });
  });

  describe('nested metadata', () => {
    it('checks nested objects one level deep', () => {
      expect(checkAuditMetadata({ outer: { email: 'user@x.com' } })).not.toBeNull();
    });

    it('allows non-PII nested objects', () => {
      expect(checkAuditMetadata({ counts: { tasks: 5, cases: 2 } })).toBeNull();
    });
  });
});

describe('checkRedactedPreview', () => {
  it('returns null for safe preview text', () => {
    expect(checkRedactedPreview('Opt-out from Acxiom for client clh1234')).toBeNull();
    expect(checkRedactedPreview('Review task for data broker removal')).toBeNull();
  });

  it('returns null for redacted tokens', () => {
    expect(checkRedactedPreview('Contact: j***@example.com')).toBeNull();
    expect(checkRedactedPreview('Phone: ***-***-1234')).toBeNull();
  });

  it('rejects raw email in preview', () => {
    expect(checkRedactedPreview('User email: john@example.com')).not.toBeNull();
  });

  it('rejects phone with separators in preview', () => {
    expect(checkRedactedPreview('Call: 555-123-4567')).not.toBeNull();
  });

  it('rejects SSN in preview', () => {
    expect(checkRedactedPreview('ID: 123-45-6789')).not.toBeNull();
  });

  it('allows hash and version strings', () => {
    expect(checkRedactedPreview('Hash: abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')).toBeNull();
    expect(checkRedactedPreview('Version: 999.177947.6851')).toBeNull();
  });
});
