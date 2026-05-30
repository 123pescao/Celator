import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CaseReportService } from '../services/case-report.service.js';
import type { CaseReportRepository } from '@celator/db';
import type { AuditService } from '../services/audit.service.js';
import type { IdentityVaultIntakeService } from '../services/identity-vault-intake.service.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_REPORT = {
  id: 'report_001',
  clientId: 'client_001',
  caseId: 'case_001',
  reportType: 'CASE_SUMMARY' as const,
  exportFormat: 'JSON' as const,
  status: 'PENDING' as const,
  redactedSummary: 'Case has 3 tasks, 2 completed.',
  requestedByUserId: 'user_001',
  generatedAt: null,
  failedAt: null,
  expiresAt: new Date(Date.now() + 86400_000 * 30),
  failureReason: null,
  vaultAccessLogId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_REPORT_READY = {
  ...FAKE_REPORT,
  status: 'READY' as const,
  generatedAt: new Date(),
};

const FAKE_REPORT_EXPIRED = {
  ...FAKE_REPORT,
  status: 'READY' as const,
  generatedAt: new Date(),
  expiresAt: new Date(Date.now() - 1000),
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeReportRepo(overrides?: Partial<CaseReportRepository>): CaseReportRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_REPORT),
    findById: vi.fn().mockResolvedValue(FAKE_REPORT),
    listForClient: vi.fn().mockResolvedValue([FAKE_REPORT]),
    listForCase: vi.fn().mockResolvedValue([FAKE_REPORT]),
    updateStatus: vi.fn().mockResolvedValue(FAKE_REPORT_READY),
    ...overrides,
  } as unknown as CaseReportRepository;
}

function makeVaultService(): IdentityVaultIntakeService {
  return {
    logAccess: vi.fn().mockResolvedValue({ ok: true, value: { recordId: 'vr_001', fieldType: 'EMAIL', redactedDisplay: '[REDACTED]', purposeCode: 'PURPOSE_REPORT_GENERATION', accessedAt: new Date() } }),
    store: vi.fn(),
    getMetadata: vi.fn(),
    decryptForOperator: vi.fn(),
  } as unknown as IdentityVaultIntakeService;
}

function makeAudit(): AuditService {
  return { write: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as unknown as AuditService;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CaseReportService', () => {
  let reportRepo: CaseReportRepository;
  let vaultService: IdentityVaultIntakeService;
  let audit: AuditService;
  let svc: CaseReportService;

  beforeEach(() => {
    reportRepo = makeReportRepo();
    vaultService = makeVaultService();
    audit = makeAudit();
    svc = new CaseReportService(reportRepo, vaultService, audit);
  });

  describe('requestReport', () => {
    it('creates a PENDING report and writes REPORT_REQUESTED audit event', async () => {
      const result = await svc.requestReport(
        { clientId: 'client_001', caseId: 'case_001', reportType: 'CASE_SUMMARY', exportFormat: 'JSON', redactedSummary: 'Case has 3 tasks.' },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('PENDING');
      expect(reportRepo.create).toHaveBeenCalledOnce();
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'REPORT_REQUESTED' }));
    });

    it('returns REPORT_CONTENT_UNSAFE when redactedSummary contains raw email', async () => {
      const result = await svc.requestReport(
        { clientId: 'client_001', reportType: 'CASE_SUMMARY', exportFormat: 'JSON', redactedSummary: 'Contact admin@example.com for details.' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('REPORT_CONTENT_UNSAFE');
      expect(reportRepo.create).not.toHaveBeenCalled();
    });

    it('returns REPORT_CONTENT_UNSAFE when redactedSummary contains raw phone', async () => {
      const result = await svc.requestReport(
        { clientId: 'client_001', reportType: 'CASE_SUMMARY', exportFormat: 'JSON', redactedSummary: 'Call 555-123-4567 for updates.' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('REPORT_CONTENT_UNSAFE');
    });

    it('fails closed when audit.write returns an error', async () => {
      vi.mocked(audit.write).mockResolvedValueOnce({ ok: false, error: 'AUDIT_LOG_FAILED', message: 'DB down' });
      const result = await svc.requestReport(
        { clientId: 'client_001', reportType: 'CASE_SUMMARY', exportFormat: 'JSON', redactedSummary: 'Safe summary.' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });

    it('audit metadata does not contain redactedSummary text', async () => {
      await svc.requestReport(
        { clientId: 'client_001', reportType: 'CASE_SUMMARY', exportFormat: 'JSON', redactedSummary: 'Case has 3 tasks, 2 completed.' },
        'actor_001',
      );
      const call = vi.mocked(audit.write).mock.calls[0]![0];
      const meta = JSON.stringify(call.metadata);
      expect(meta).not.toContain('Case has 3 tasks');
    });

    it('SafeCaseReport does not contain vaultAccessLogId field', async () => {
      const result = await svc.requestReport(
        { clientId: 'client_001', reportType: 'CASE_SUMMARY', exportFormat: 'JSON', redactedSummary: 'Safe.' },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const json = JSON.stringify(result.value);
      expect(json).not.toContain('vaultAccessLogId');
      expect(result.value).toHaveProperty('vaultAccessLogged');
    });
  });

  describe('generateStub', () => {
    it('transitions PENDING to READY and sets generatedAt', async () => {
      const result = await svc.generateStub('report_001', 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(reportRepo.updateStatus).toHaveBeenCalledWith('report_001', 'READY', expect.objectContaining({ generatedAt: expect.any(Date) }));
    });

    it('returns REPORT_NOT_FOUND when report does not exist', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.generateStub('missing', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('REPORT_NOT_FOUND');
    });

    it('returns REPORT_INVALID_STATUS when report is not PENDING', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce({ ...FAKE_REPORT, status: 'READY' as const });
      const result = await svc.generateStub('report_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('REPORT_INVALID_STATUS');
    });

    it('calls vaultService.logAccess with PURPOSE_REPORT_GENERATION when vaultRecordId provided for PROOF_PACKET', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce({ ...FAKE_REPORT, reportType: 'PROOF_PACKET' as const });
      await svc.generateStub('report_001', 'actor_001', 'vr_001');
      expect(vaultService.logAccess).toHaveBeenCalledWith('vr_001', 'PURPOSE_REPORT_GENERATION', 'actor_001', 'OPERATOR');
    });

    it('does NOT call vaultService.logAccess when no vaultRecordId is provided', async () => {
      await svc.generateStub('report_001', 'actor_001');
      expect(vaultService.logAccess).not.toHaveBeenCalled();
    });

    it('does NOT call vaultService.logAccess for CASE_SUMMARY even if vaultRecordId is provided', async () => {
      await svc.generateStub('report_001', 'actor_001', 'vr_001');
      expect(vaultService.logAccess).not.toHaveBeenCalled();
    });

    it('writes REPORT_GENERATED_STUB audit event', async () => {
      await svc.generateStub('report_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'REPORT_GENERATED_STUB' }));
    });

    it('fails closed when audit.write returns an error', async () => {
      vi.mocked(audit.write).mockResolvedValueOnce({ ok: false, error: 'AUDIT_LOG_FAILED', message: 'DB down' });
      const result = await svc.generateStub('report_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });
  });

  describe('getById', () => {
    it('returns SafeCaseReport when report exists and has not expired', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce(FAKE_REPORT_READY);
      const result = await svc.getById('report_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('report_001');
    });

    it('returns REPORT_EXPIRED when expiresAt is in the past', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce(FAKE_REPORT_EXPIRED);
      const result = await svc.getById('report_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('REPORT_EXPIRED');
    });

    it('returns REPORT_NOT_FOUND when report does not exist', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.getById('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('REPORT_NOT_FOUND');
    });

    it('SafeCaseReport does not contain vaultAccessLogId', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce(FAKE_REPORT_READY);
      const result = await svc.getById('report_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const json = JSON.stringify(result.value);
      expect(json).not.toContain('vaultAccessLogId');
      expect(result.value).toHaveProperty('vaultAccessLogged');
      expect(typeof result.value.vaultAccessLogged).toBe('boolean');
    });

    it('vaultAccessLogged is true when vaultAccessLogId is set on DB record', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce({ ...FAKE_REPORT_READY, vaultAccessLogId: 'val_001' });
      const result = await svc.getById('report_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.vaultAccessLogged).toBe(true);
    });

    it('report with null expiresAt is not treated as expired', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce({ ...FAKE_REPORT_READY, expiresAt: null });
      const result = await svc.getById('report_001');
      expect(result.ok).toBe(true);
    });
  });

  describe('markFailed', () => {
    it('transitions PENDING to FAILED with failureReason', async () => {
      vi.mocked(reportRepo.updateStatus).mockResolvedValueOnce({ ...FAKE_REPORT, status: 'FAILED' as const, failedAt: new Date(), failureReason: 'Generation error' });
      const result = await svc.markFailed('report_001', 'Generation error', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('returns REPORT_INVALID_STATUS when report is already in terminal state', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce({ ...FAKE_REPORT, status: 'READY' as const });
      const result = await svc.markFailed('report_001', 'Too late', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('REPORT_INVALID_STATUS');
    });

    it('returns REPORT_CONTENT_UNSAFE when failureReason contains PII', async () => {
      const result = await svc.markFailed('report_001', 'Failed for user@example.com', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('REPORT_CONTENT_UNSAFE');
    });
  });

  describe('expireReport', () => {
    it('transitions READY to EXPIRED', async () => {
      vi.mocked(reportRepo.findById).mockResolvedValueOnce(FAKE_REPORT_READY);
      vi.mocked(reportRepo.updateStatus).mockResolvedValueOnce({ ...FAKE_REPORT_READY, status: 'EXPIRED' as const });
      const result = await svc.expireReport('report_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(reportRepo.updateStatus).toHaveBeenCalledWith('report_001', 'EXPIRED');
    });

    it('returns REPORT_INVALID_STATUS when report is not READY', async () => {
      const result = await svc.expireReport('report_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('REPORT_INVALID_STATUS');
    });
  });

  describe('listForClient', () => {
    it('returns array of SafeCaseReport for the given clientId', async () => {
      const result = await svc.listForClient('client_001');
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]!.clientId).toBe('client_001');
    });

    it('returns empty array when client has no reports', async () => {
      vi.mocked(reportRepo.listForClient).mockResolvedValueOnce([]);
      const result = await svc.listForClient('client_001');
      expect(result).toEqual([]);
    });

    it('list items do not contain vaultAccessLogId', async () => {
      const result = await svc.listForClient('client_001');
      const json = JSON.stringify(result);
      expect(json).not.toContain('vaultAccessLogId');
    });
  });
});
