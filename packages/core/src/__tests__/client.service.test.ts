import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClientService } from '../services/client.service.js';
import type { ClientRepository } from '@celator/db';
import type { AuditService } from '../services/audit.service.js';

const FAKE_CLIENT = {
  id: 'client_001',
  organizationId: 'org_001',
  displayName: 'Test Client',
  status: 'PENDING_IDENTITY_VERIFICATION' as const,
  hasDisputeFlag: false,
  hasComplianceHold: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRepo(): ClientRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_CLIENT),
    findById: vi.fn().mockResolvedValue(FAKE_CLIENT),
    listByOrg: vi.fn().mockResolvedValue([FAKE_CLIENT]),
    updateStatus: vi.fn().mockImplementation((_id, status) => Promise.resolve({ ...FAKE_CLIENT, status })),
    update: vi.fn().mockResolvedValue(FAKE_CLIENT),
  } as unknown as ClientRepository;
}

function makeAudit(): AuditService {
  return { write: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as unknown as AuditService;
}

describe('ClientService', () => {
  let repo: ClientRepository;
  let audit: AuditService;
  let svc: ClientService;

  beforeEach(() => {
    repo = makeRepo();
    audit = makeAudit();
    svc = new ClientService(repo, audit);
  });

  describe('create', () => {
    it('creates a client and writes audit', async () => {
      const result = await svc.create({ organizationId: 'org_001', displayName: 'Alice' }, 'op_001');
      expect(result.ok).toBe(true);
      expect(repo.create).toHaveBeenCalledOnce();
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'CLIENT_CREATED' }));
    });
  });

  describe('getById', () => {
    it('returns client when found', async () => {
      const result = await svc.getById('client_001');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.id).toBe('client_001');
    });

    it('returns CLIENT_NOT_FOUND when not found', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.getById('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('CLIENT_NOT_FOUND');
    });
  });

  describe('activateAfterVerification', () => {
    it('transitions PENDING_IDENTITY_VERIFICATION to ACTIVE', async () => {
      const result = await svc.activateAfterVerification('client_001', 'op_001');
      expect(result.ok).toBe(true);
      expect(repo.updateStatus).toHaveBeenCalledWith('client_001', 'ACTIVE');
    });

    it('rejects activation if client is already ACTIVE', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce({ ...FAKE_CLIENT, status: 'ACTIVE' });
      const result = await svc.activateAfterVerification('client_001', 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('returns CLIENT_NOT_FOUND for missing client', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.activateAfterVerification('missing', 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('CLIENT_NOT_FOUND');
    });
  });

  describe('updateStatus', () => {
    it('writes audit on status change', async () => {
      const result = await svc.updateStatus('client_001', 'SUSPENDED', 'op_001');
      expect(result.ok).toBe(true);
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'CLIENT_STATUS_CHANGED' }));
    });
  });

  describe('audit fail-close', () => {
    const AUDIT_ERR = { ok: false as const, error: 'AUDIT_LOG_FAILED' as const, message: 'DB down' };

    it('create propagates audit failure', async () => {
      vi.mocked(audit.write).mockResolvedValueOnce(AUDIT_ERR);
      const result = await svc.create({ organizationId: 'org_001', displayName: 'Alice' }, 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });

    it('activateAfterVerification propagates audit failure', async () => {
      vi.mocked(audit.write).mockResolvedValueOnce(AUDIT_ERR);
      const result = await svc.activateAfterVerification('client_001', 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });

    it('updateStatus propagates audit failure', async () => {
      vi.mocked(audit.write).mockResolvedValueOnce(AUDIT_ERR);
      const result = await svc.updateStatus('client_001', 'SUSPENDED', 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });
  });
});
