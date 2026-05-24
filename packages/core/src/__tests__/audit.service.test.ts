import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditService } from '../services/audit.service.js';
import type { AuditLogRepository } from '@celator/db';

function makeRepo(): AuditLogRepository {
  return {
    create: vi.fn().mockResolvedValue({ id: 'audit_001', eventType: 'TEST', actorType: 'OPERATOR', outcome: 'ALLOWED', blockedBy: [], createdAt: new Date() }),
    listByClient: vi.fn().mockResolvedValue([]),
    listByActor: vi.fn().mockResolvedValue([]),
    listByResource: vi.fn().mockResolvedValue([]),
    listByEventType: vi.fn().mockResolvedValue([]),
  } as unknown as AuditLogRepository;
}

describe('AuditService', () => {
  let repo: AuditLogRepository;
  let svc: AuditService;

  beforeEach(() => {
    repo = makeRepo();
    svc = new AuditService(repo);
  });

  describe('write', () => {
    it('writes a valid audit event', async () => {
      const result = await svc.write({
        eventType: 'CLIENT_CREATED',
        actorType: 'OPERATOR',
        actorId: 'user_001',
        clientId: 'client_001',
        outcome: 'ALLOWED',
        metadata: { someKey: 'someValue' },
      });
      expect(result.ok).toBe(true);
      expect(repo.create).toHaveBeenCalledOnce();
    });

    it('rejects metadata containing email-like pattern', async () => {
      const result = await svc.write({
        eventType: 'TEST',
        actorType: 'SYSTEM',
        outcome: 'ALLOWED',
        metadata: { contact: 'user@example.com' },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects metadata containing phone-like pattern', async () => {
      const result = await svc.write({
        eventType: 'TEST',
        actorType: 'SYSTEM',
        outcome: 'ALLOWED',
        metadata: { phone: '555-123-4567' },
      });
      expect(result.ok).toBe(false);
    });

    it('rejects metadata containing SSN-like pattern', async () => {
      const result = await svc.write({
        eventType: 'TEST',
        actorType: 'SYSTEM',
        outcome: 'ALLOWED',
        metadata: { ssn: '123-45-6789' },
      });
      expect(result.ok).toBe(false);
    });

    it('allows metadata with non-PII strings', async () => {
      const result = await svc.write({
        eventType: 'TASK_CREATED',
        actorType: 'OPERATOR',
        outcome: 'ALLOWED',
        metadata: { riskTier: 'HIGH', taskId: 'task_001' },
      });
      expect(result.ok).toBe(true);
    });

    it('returns AUDIT_LOG_FAILED when repo throws', async () => {
      vi.mocked(repo.create).mockRejectedValueOnce(new Error('DB down'));
      const result = await svc.write({ eventType: 'X', actorType: 'SYSTEM', outcome: 'ERROR' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });
  });

  describe('false-positive avoidance (Phase 1D)', () => {
    it('allows Unix timestamp value (10 digits, no separators)', async () => {
      const result = await svc.write({
        eventType: 'TEST',
        actorType: 'SYSTEM',
        outcome: 'ALLOWED',
        metadata: { ts: 1699999999 },
      });
      expect(result.ok).toBe(true);
    });

    it('allows timestamp string without separators', async () => {
      const result = await svc.write({
        eventType: 'TEST',
        actorType: 'SYSTEM',
        outcome: 'ALLOWED',
        metadata: { createdAt: '1699999999' },
      });
      expect(result.ok).toBe(true);
    });

    it('allows 64-character hex documentHash', async () => {
      const hash = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
      const result = await svc.write({
        eventType: 'CONSENT_CREATED',
        actorType: 'OPERATOR',
        outcome: 'ALLOWED',
        metadata: { documentHash: hash },
      });
      expect(result.ok).toBe(true);
    });

    it('allows semver-style version string (smoke script format)', async () => {
      const result = await svc.write({
        eventType: 'CONSENT_CREATED',
        actorType: 'OPERATOR',
        outcome: 'ALLOWED',
        metadata: { version: '999.177947.6851' },
      });
      expect(result.ok).toBe(true);
    });

    it('rejects raw email even with a non-PII key name', async () => {
      const result = await svc.write({
        eventType: 'TEST',
        actorType: 'SYSTEM',
        outcome: 'ALLOWED',
        metadata: { info: 'user@example.com' },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });

    it('rejects phone number with separators', async () => {
      const result = await svc.write({
        eventType: 'TEST',
        actorType: 'SYSTEM',
        outcome: 'ALLOWED',
        metadata: { contact: '555-123-4567' },
      });
      expect(result.ok).toBe(false);
    });

    it('rejects token/secret key names', async () => {
      const result = await svc.write({
        eventType: 'TEST',
        actorType: 'SYSTEM',
        outcome: 'ALLOWED',
        metadata: { token: 'abc123' },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('list methods', () => {
    it('delegates listByClient to repo', async () => {
      await svc.listByClient('c1', 50);
      expect(repo.listByClient).toHaveBeenCalledWith('c1', 50);
    });

    it('delegates listByResource to repo', async () => {
      await svc.listByResource('r1', 'CleanupTask');
      expect(repo.listByResource).toHaveBeenCalledWith('r1', 'CleanupTask');
    });
  });
});
