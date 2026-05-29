import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvidenceService } from '../services/evidence.service.js';
import type { EvidenceRecordRepository, CleanupTaskRepository } from '@celator/db';
import type { AuditService } from '../services/audit.service.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_TASK = {
  id: 'task_001',
  caseId: 'case_001',
  dataSourceTargetId: null,
  status: 'FOUND' as const,
  actionType: null,
  matchStatus: 'NEEDS_OPERATOR_REVIEW' as const,
  riskTier: 'STANDARD' as const,
  sourceRef: null,
  findingUrl: null,
  preparedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_RECORD = {
  id: 'ev_001',
  taskId: 'task_001',
  clientId: 'client_001',
  storageKey: 'evidence/task_001/screen.png',
  contentHash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
  evidenceType: 'SCREENSHOT',
  mimeType: 'image/png',
  sizeBytes: 12345,
  isImmutable: false,
  retainUntil: null,
  createdAt: new Date(),
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeEvidenceRepo(overrides?: Partial<EvidenceRecordRepository>): EvidenceRecordRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_RECORD),
    findById: vi.fn().mockResolvedValue(FAKE_RECORD),
    listForTask: vi.fn().mockResolvedValue([FAKE_RECORD]),
    listForTaskScoped: vi.fn().mockResolvedValue([FAKE_RECORD]),
    findManyByIds: vi.fn().mockResolvedValue([FAKE_RECORD]),
    markImmutable: vi.fn().mockResolvedValue({ ...FAKE_RECORD, isImmutable: true }),
    ...overrides,
  } as unknown as EvidenceRecordRepository;
}

function makeTaskRepo(): CleanupTaskRepository {
  return {
    findById: vi.fn().mockResolvedValue(FAKE_TASK),
    create: vi.fn(),
    listForCase: vi.fn(),
    updateStatus: vi.fn(),
    update: vi.fn(),
    bulkUpdateStatus: vi.fn(),
  } as unknown as CleanupTaskRepository;
}

function makeAudit(): AuditService {
  return { write: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as unknown as AuditService;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvidenceService', () => {
  let evidenceRepo: EvidenceRecordRepository;
  let taskRepo: CleanupTaskRepository;
  let audit: AuditService;
  let svc: EvidenceService;

  beforeEach(() => {
    evidenceRepo = makeEvidenceRepo();
    taskRepo = makeTaskRepo();
    audit = makeAudit();
    svc = new EvidenceService(evidenceRepo, taskRepo, audit);
  });

  describe('register', () => {
    it('creates evidence record successfully', async () => {
      const result = await svc.register(
        { taskId: 'task_001', clientId: 'client_001', storageKey: 'evidence/task_001/screen.png', contentHash: 'abc123', evidenceType: 'SCREENSHOT' },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.evidenceType).toBe('SCREENSHOT');
    });

    it('returns EVIDENCE_TYPE_INVALID for unknown evidenceType', async () => {
      const result = await svc.register(
        { taskId: 'task_001', clientId: 'client_001', storageKey: 'evidence/task_001/screen.png', contentHash: 'abc123', evidenceType: 'INVALID_TYPE' as never },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('EVIDENCE_TYPE_INVALID');
    });

    it('rejects storageKey containing email pattern (@)', async () => {
      const result = await svc.register(
        { taskId: 'task_001', clientId: 'client_001', storageKey: 'uploads/user@example.com/screen.png', contentHash: 'abc123', evidenceType: 'SCREENSHOT' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('rejects storageKey containing URL scheme (://)', async () => {
      const result = await svc.register(
        { taskId: 'task_001', clientId: 'client_001', storageKey: 's3://bucket/evidence.png', contentHash: 'abc123', evidenceType: 'SCREENSHOT' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('rejects storageKey containing local path (/home/)', async () => {
      const result = await svc.register(
        { taskId: 'task_001', clientId: 'client_001', storageKey: '/home/username/downloads/screen.png', contentHash: 'abc123', evidenceType: 'SCREENSHOT' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('rejects storageKey containing path traversal (..)', async () => {
      const result = await svc.register(
        { taskId: 'task_001', clientId: 'client_001', storageKey: 'evidence/../secret/key.pem', contentHash: 'abc123', evidenceType: 'SCREENSHOT' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('returns NOT_FOUND when task is missing', async () => {
      vi.mocked(taskRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.register(
        { taskId: 'missing', clientId: 'client_001', storageKey: 'evidence/ok.png', contentHash: 'abc123', evidenceType: 'SCREENSHOT' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });

    it('writes EVIDENCE_REGISTERED audit event', async () => {
      await svc.register(
        { taskId: 'task_001', clientId: 'client_001', storageKey: 'evidence/ok.png', contentHash: 'abc123', evidenceType: 'SCREENSHOT' },
        'actor_001',
      );
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'EVIDENCE_REGISTERED' }));
    });

    it('audit metadata does not include storageKey', async () => {
      await svc.register(
        { taskId: 'task_001', clientId: 'client_001', storageKey: 'evidence/task_001/ok.png', contentHash: 'abc123', evidenceType: 'SCREENSHOT' },
        'actor_001',
      );
      const call = vi.mocked(audit.write).mock.calls.find(([a]) => a.eventType === 'EVIDENCE_REGISTERED');
      expect(call).toBeDefined();
      const meta = JSON.stringify(call![0].metadata);
      expect(meta).not.toContain('storageKey');
      expect(meta).not.toContain('ok.png');
    });

    it('response contains no ciphertext or vault fields', async () => {
      const result = await svc.register(
        { taskId: 'task_001', clientId: 'client_001', storageKey: 'evidence/ok.png', contentHash: 'abc123', evidenceType: 'SCREENSHOT' },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
      expect(json).not.toContain('encryptedKeyRef');
    });
  });

  describe('listForTask', () => {
    it('returns records scoped to taskId and clientId', async () => {
      const result = await svc.listForTask('task_001', 'client_001');
      expect(evidenceRepo.listForTaskScoped).toHaveBeenCalledWith('task_001', 'client_001');
      expect(result).toHaveLength(1);
    });
  });

  describe('markImmutable', () => {
    it('marks evidence record immutable', async () => {
      const result = await svc.markImmutable('ev_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.isImmutable).toBe(true);
    });

    it('returns EVIDENCE_RECORD_NOT_FOUND for missing record', async () => {
      vi.mocked(evidenceRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.markImmutable('missing', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('EVIDENCE_RECORD_NOT_FOUND');
    });

    it('returns FORBIDDEN when clientId does not match record', async () => {
      vi.mocked(evidenceRepo.findById).mockResolvedValueOnce({ ...FAKE_RECORD, clientId: 'client_OTHER' });
      const result = await svc.markImmutable('ev_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FORBIDDEN');
    });

    it('is idempotent — returns success if already immutable', async () => {
      vi.mocked(evidenceRepo.findById).mockResolvedValueOnce({ ...FAKE_RECORD, isImmutable: true });
      const result = await svc.markImmutable('ev_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(evidenceRepo.markImmutable).not.toHaveBeenCalled();
    });

    it('writes EVIDENCE_MARKED_IMMUTABLE audit event', async () => {
      await svc.markImmutable('ev_001', 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'EVIDENCE_MARKED_IMMUTABLE' }));
    });
  });

  describe('getById', () => {
    it('returns evidence record', async () => {
      const result = await svc.getById('ev_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('ev_001');
    });

    it('returns EVIDENCE_RECORD_NOT_FOUND for missing record', async () => {
      vi.mocked(evidenceRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.getById('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('EVIDENCE_RECORD_NOT_FOUND');
    });
  });
});
