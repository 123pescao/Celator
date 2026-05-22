import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsentWorkflowService } from '../services/consent-workflow.service.js';
import type { ConsentVersionRepository, ClientAuthorizationRepository } from '@celator/db';
import type { AuditService } from '../services/audit.service.js';
import type { CleanupTaskService } from '../services/cleanup-task.service.js';

const FAKE_VERSION = {
  id: 'cv_001',
  version: '1.0.0',
  documentHash: 'a'.repeat(64),
  effectiveFrom: new Date('2024-01-01'),
  effectiveUntil: null,
  createdAt: new Date(),
};

const FAKE_AUTH = {
  id: 'auth_001',
  clientId: 'client_001',
  consentVersionId: 'cv_001',
  scopeNames: ['DATA_BROKER_OPT_OUT'],
  jurisdiction: 'US-CA',
  authorizationType: 'SELF' as const,
  signedAt: new Date('2024-06-01'),
  expiresAt: null,
  revokedAt: null,
  revocationReason: null,
  createdAt: new Date(),
};

function makeVersionRepo(): ConsentVersionRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_VERSION),
    findById: vi.fn().mockResolvedValue(FAKE_VERSION),
    findByVersion: vi.fn().mockResolvedValue(null),
    findCurrent: vi.fn().mockResolvedValue(FAKE_VERSION),
    list: vi.fn().mockResolvedValue([FAKE_VERSION]),
  } as unknown as ConsentVersionRepository;
}

function makeAuthRepo(): ClientAuthorizationRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_AUTH),
    findById: vi.fn().mockResolvedValue(FAKE_AUTH),
    findActiveForClient: vi.fn().mockResolvedValue([FAKE_AUTH]),
    listForClient: vi.fn().mockResolvedValue([FAKE_AUTH]),
    revoke: vi.fn().mockImplementation((id, reason, revokedAt) => Promise.resolve({ ...FAKE_AUTH, revokedAt, revocationReason: reason })),
  } as unknown as ClientAuthorizationRepository;
}

function makeAudit(): AuditService {
  return { write: vi.fn().mockResolvedValue({ ok: true }) } as unknown as AuditService;
}

function makeTaskService(): CleanupTaskService {
  return { pauseTasksForRevocation: vi.fn().mockResolvedValue(undefined) } as unknown as CleanupTaskService;
}

describe('ConsentWorkflowService', () => {
  let svc: ConsentWorkflowService;
  let authRepo: ClientAuthorizationRepository;
  let versionRepo: ConsentVersionRepository;

  beforeEach(() => {
    versionRepo = makeVersionRepo();
    authRepo = makeAuthRepo();
    const taskService = makeTaskService();
    svc = new ConsentWorkflowService(versionRepo, authRepo, makeAudit(), () => taskService);
  });

  describe('createConsentVersion', () => {
    it('creates a new consent version', async () => {
      const result = await svc.createConsentVersion('1.0.0', 'a'.repeat(64), new Date(), undefined, 'admin_001');
      expect(result.ok).toBe(true);
      expect(versionRepo.create).toHaveBeenCalledOnce();
    });

    it('rejects duplicate version', async () => {
      vi.mocked(versionRepo.findByVersion).mockResolvedValueOnce(FAKE_VERSION);
      const result = await svc.createConsentVersion('1.0.0', 'b'.repeat(64), new Date(), undefined, 'admin_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('createAuthorization', () => {
    it('creates authorization linked to a consent version', async () => {
      const result = await svc.createAuthorization({
        clientId: 'client_001',
        consentVersionId: 'cv_001',
        scopeNames: ['DATA_BROKER_OPT_OUT'],
        jurisdiction: 'US-CA',
        signedAt: new Date(),
      }, 'op_001');
      expect(result.ok).toBe(true);
      expect(authRepo.create).toHaveBeenCalledOnce();
    });

    it('fails if consent version not found', async () => {
      vi.mocked(versionRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.createAuthorization({
        clientId: 'c1',
        consentVersionId: 'missing',
        scopeNames: ['X'],
        jurisdiction: 'US',
        signedAt: new Date(),
      }, 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });
  });

  describe('revokeAuthorization', () => {
    it('revokes an active authorization', async () => {
      const result = await svc.revokeAuthorization('auth_001', 'Client request', 'op_001');
      expect(result.ok).toBe(true);
      expect(authRepo.revoke).toHaveBeenCalledWith('auth_001', 'Client request', expect.any(Date));
    });

    it('fails if authorization already revoked', async () => {
      vi.mocked(authRepo.findById).mockResolvedValueOnce({ ...FAKE_AUTH, revokedAt: new Date() });
      const result = await svc.revokeAuthorization('auth_001', 'reason', 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTHORIZATION_REVOKED');
    });
  });

  describe('evaluateActionCoverage', () => {
    it('returns covered=true for matching scope and jurisdiction', async () => {
      const result = await svc.evaluateActionCoverage('auth_001', 'DATA_BROKER_OPT_OUT', 'US-CA');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.covered).toBe(true);
    });

    it('returns covered=false for non-matching scope', async () => {
      const result = await svc.evaluateActionCoverage('auth_001', 'DELETE_ACCOUNT', 'US-CA');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.covered).toBe(false);
    });

    it('returns covered=false for non-matching jurisdiction', async () => {
      const result = await svc.evaluateActionCoverage('auth_001', 'DATA_BROKER_OPT_OUT', 'US-TX');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.covered).toBe(false);
    });

    it('returns covered=false for revoked authorization', async () => {
      vi.mocked(authRepo.findById).mockResolvedValueOnce({ ...FAKE_AUTH, revokedAt: new Date() });
      const result = await svc.evaluateActionCoverage('auth_001', 'DATA_BROKER_OPT_OUT', 'US-CA');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.covered).toBe(false);
    });

    it('returns covered=false for expired authorization', async () => {
      vi.mocked(authRepo.findById).mockResolvedValueOnce({ ...FAKE_AUTH, expiresAt: new Date('2020-01-01') });
      const result = await svc.evaluateActionCoverage('auth_001', 'DATA_BROKER_OPT_OUT', 'US-CA');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.covered).toBe(false);
    });
  });

  describe('audit fail-close', () => {
    const AUDIT_ERR = { ok: false as const, error: 'AUDIT_LOG_FAILED' as const, message: 'DB down' };

    it('createConsentVersion propagates audit failure', async () => {
      const audit = makeAudit();
      vi.mocked(audit.write).mockResolvedValueOnce(AUDIT_ERR);
      const svc2 = new ConsentWorkflowService(versionRepo, authRepo, audit, () => makeTaskService());
      const result = await svc2.createConsentVersion('2.0.0', 'b'.repeat(64), new Date(), undefined, 'admin_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });

    it('createAuthorization propagates audit failure', async () => {
      const audit = makeAudit();
      vi.mocked(audit.write).mockResolvedValueOnce(AUDIT_ERR);
      const svc2 = new ConsentWorkflowService(versionRepo, authRepo, audit, () => makeTaskService());
      const result = await svc2.createAuthorization({
        clientId: 'client_001',
        consentVersionId: 'cv_001',
        scopeNames: ['X'],
        jurisdiction: 'US-CA',
        signedAt: new Date(),
      }, 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });

    it('revokeAuthorization propagates audit failure', async () => {
      const audit = makeAudit();
      vi.mocked(audit.write).mockResolvedValueOnce(AUDIT_ERR);
      const svc2 = new ConsentWorkflowService(versionRepo, authRepo, audit, () => makeTaskService());
      const result = await svc2.revokeAuthorization('auth_001', 'reason', 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });
  });
});
