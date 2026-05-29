import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FollowUpReminderService } from '../services/follow-up-reminder.service.js';
import type { FollowUpReminderRepository, CleanupTaskRepository } from '@celator/db';
import type { AuditService } from '../services/audit.service.js';
import type { CaseTimelineService } from '../services/case-timeline.service.js';

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

const FAKE_FOLLOW_UP = {
  id: 'fu_001',
  taskId: 'task_001',
  clientId: 'client_001',
  status: 'PENDING' as const,
  dueAt: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
  safeNote: null,
  completedAt: null,
  cancelledAt: null,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeFollowUpRepo(overrides?: Partial<FollowUpReminderRepository>): FollowUpReminderRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_FOLLOW_UP),
    findById: vi.fn().mockResolvedValue(FAKE_FOLLOW_UP),
    listForTask: vi.fn().mockResolvedValue([FAKE_FOLLOW_UP]),
    listForClient: vi.fn().mockResolvedValue([FAKE_FOLLOW_UP]),
    listDueAsOf: vi.fn().mockResolvedValue([FAKE_FOLLOW_UP]),
    updateStatus: vi.fn().mockResolvedValue({ ...FAKE_FOLLOW_UP, status: 'COMPLETED', completedAt: new Date() }),
    ...overrides,
  } as unknown as FollowUpReminderRepository;
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

function makeTimeline(): CaseTimelineService {
  return { append: vi.fn().mockResolvedValue({}), listForCase: vi.fn(), listForTask: vi.fn() } as unknown as CaseTimelineService;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FollowUpReminderService', () => {
  let followUpRepo: FollowUpReminderRepository;
  let taskRepo: CleanupTaskRepository;
  let audit: AuditService;
  let timeline: CaseTimelineService;
  let svc: FollowUpReminderService;

  beforeEach(() => {
    followUpRepo = makeFollowUpRepo();
    taskRepo = makeTaskRepo();
    audit = makeAudit();
    timeline = makeTimeline();
    svc = new FollowUpReminderService(followUpRepo, taskRepo, audit, timeline);
  });

  describe('create', () => {
    it('creates a follow-up with status PENDING', async () => {
      const result = await svc.create(
        { taskId: 'task_001', clientId: 'client_001', dueAt: new Date(Date.now() + 86400000) },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('PENDING');
    });

    it('returns NOT_FOUND when task is missing', async () => {
      vi.mocked(taskRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.create(
        { taskId: 'missing', clientId: 'client_001', dueAt: new Date() },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });

    it('rejects PII (email) in safeNote', async () => {
      const result = await svc.create(
        { taskId: 'task_001', clientId: 'client_001', dueAt: new Date(), safeNote: 'Follow up with admin@example.com' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_UNSAFE_TEXT');
    });

    it('rejects PII (phone) in safeNote', async () => {
      const result = await svc.create(
        { taskId: 'task_001', clientId: 'client_001', dueAt: new Date(), safeNote: 'Call 555-123-4567' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_UNSAFE_TEXT');
    });

    it('accepts null safeNote (optional)', async () => {
      const result = await svc.create(
        { taskId: 'task_001', clientId: 'client_001', dueAt: new Date() },
        'actor_001',
      );
      expect(result.ok).toBe(true);
    });

    it('writes FOLLOW_UP_SCHEDULED audit event', async () => {
      await svc.create({ taskId: 'task_001', clientId: 'client_001', dueAt: new Date() }, 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'FOLLOW_UP_SCHEDULED' }));
    });

    it('audit metadata does not include dueAt (matches DOB pattern)', async () => {
      await svc.create({ taskId: 'task_001', clientId: 'client_001', dueAt: new Date('2026-06-15') }, 'actor_001');
      const call = vi.mocked(audit.write).mock.calls.find(([a]) => a.eventType === 'FOLLOW_UP_SCHEDULED');
      expect(call).toBeDefined();
      const meta = JSON.stringify(call![0].metadata);
      expect(meta).not.toContain('dueAt');
      expect(meta).not.toContain('2026-06-15');
    });

    it('appends FOLLOW_UP_SCHEDULED timeline event', async () => {
      await svc.create({ taskId: 'task_001', clientId: 'client_001', dueAt: new Date() }, 'actor_001');
      expect(timeline.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'FOLLOW_UP_SCHEDULED' }));
    });
  });

  describe('complete', () => {
    it('transitions PENDING follow-up to COMPLETED', async () => {
      const result = await svc.complete('fu_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(followUpRepo.updateStatus).toHaveBeenCalledWith('fu_001', 'COMPLETED', expect.any(Object));
    });

    it('returns FORBIDDEN when clientId does not match', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce({ ...FAKE_FOLLOW_UP, clientId: 'client_OTHER' });
      const result = await svc.complete('fu_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FORBIDDEN');
    });

    it('rejects completing an already COMPLETED follow-up', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce({ ...FAKE_FOLLOW_UP, status: 'COMPLETED' });
      const result = await svc.complete('fu_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FOLLOW_UP_INVALID_STATUS');
    });

    it('rejects completing a CANCELLED follow-up', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce({ ...FAKE_FOLLOW_UP, status: 'CANCELLED' });
      const result = await svc.complete('fu_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FOLLOW_UP_INVALID_STATUS');
    });

    it('allows completing a DUE follow-up (not terminal)', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce({ ...FAKE_FOLLOW_UP, status: 'DUE' });
      const result = await svc.complete('fu_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('writes FOLLOW_UP_COMPLETED audit event', async () => {
      await svc.complete('fu_001', 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'FOLLOW_UP_COMPLETED' }));
    });
  });

  describe('cancel', () => {
    it('transitions PENDING follow-up to CANCELLED', async () => {
      const result = await svc.cancel('fu_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('returns FORBIDDEN when clientId does not match', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce({ ...FAKE_FOLLOW_UP, clientId: 'client_OTHER' });
      const result = await svc.cancel('fu_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FORBIDDEN');
    });

    it('rejects cancelling an already CANCELLED follow-up', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce({ ...FAKE_FOLLOW_UP, status: 'CANCELLED' });
      const result = await svc.cancel('fu_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FOLLOW_UP_INVALID_STATUS');
    });

    it('rejects cancelling a COMPLETED follow-up', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce({ ...FAKE_FOLLOW_UP, status: 'COMPLETED' });
      const result = await svc.cancel('fu_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FOLLOW_UP_INVALID_STATUS');
    });

    it('writes FOLLOW_UP_CANCELLED audit event', async () => {
      await svc.cancel('fu_001', 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'FOLLOW_UP_CANCELLED' }));
    });
  });

  describe('listDueAsOf', () => {
    it('calls repo with correct asOf and clientId', async () => {
      const asOf = new Date('2026-06-15T00:00:00Z');
      await svc.listDueAsOf(asOf, 'client_001');
      expect(followUpRepo.listDueAsOf).toHaveBeenCalledWith(asOf, 'client_001');
    });

    it('returns only pending items for client (not other clients)', async () => {
      vi.mocked(followUpRepo.listDueAsOf).mockResolvedValueOnce([FAKE_FOLLOW_UP]);
      const result = await svc.listDueAsOf(new Date(), 'client_001');
      for (const fu of result) {
        expect(fu.clientId).toBe('client_001');
      }
    });

    it('returns empty array when no due items', async () => {
      vi.mocked(followUpRepo.listDueAsOf).mockResolvedValueOnce([]);
      const result = await svc.listDueAsOf(new Date(), 'client_001');
      expect(result).toEqual([]);
    });

    it('response contains no vault fields', async () => {
      const result = await svc.listDueAsOf(new Date(), 'client_001');
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
      expect(json).not.toContain('encryptedKeyRef');
    });
  });

  describe('getById', () => {
    it('returns follow-up record', async () => {
      const result = await svc.getById('fu_001');
      expect(result.ok).toBe(true);
    });

    it('returns FOLLOW_UP_NOT_FOUND for missing follow-up', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.getById('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FOLLOW_UP_NOT_FOUND');
    });
  });
});
