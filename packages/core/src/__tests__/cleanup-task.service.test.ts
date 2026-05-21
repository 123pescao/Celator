import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CleanupTaskService } from '../services/cleanup-task.service.js';
import type { CleanupTaskRepository } from '@celator/db';
import type { AuditService } from '../services/audit.service.js';
import type { CaseTimelineService } from '../services/case-timeline.service.js';

const FAKE_TASK = {
  id: 'task_001',
  caseId: 'case_001',
  status: 'FOUND' as const,
  matchStatus: 'NEEDS_OPERATOR_REVIEW' as const,
  riskTier: 'STANDARD' as const,
  actionType: null,
  sourceRef: 'broker-a',
  findingUrl: null,
  preparedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRepo(): CleanupTaskRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_TASK),
    findById: vi.fn().mockResolvedValue(FAKE_TASK),
    listForCase: vi.fn().mockResolvedValue([FAKE_TASK]),
    updateStatus: vi.fn().mockImplementation((_id, status) => Promise.resolve({ ...FAKE_TASK, status })),
    update: vi.fn().mockResolvedValue(FAKE_TASK),
    bulkUpdateStatus: vi.fn().mockResolvedValue(1),
  } as unknown as CleanupTaskRepository;
}

function makeAudit(): AuditService {
  return { write: vi.fn().mockResolvedValue({ ok: true }) } as unknown as AuditService;
}

function makeTimeline(): CaseTimelineService {
  return { append: vi.fn().mockResolvedValue({}) } as unknown as CaseTimelineService;
}

describe('CleanupTaskService', () => {
  let repo: CleanupTaskRepository;
  let svc: CleanupTaskService;

  beforeEach(() => {
    repo = makeRepo();
    svc = new CleanupTaskService(repo, makeAudit(), makeTimeline());
  });

  describe('create', () => {
    it('creates a task with FOUND status', async () => {
      const result = await svc.create({ caseId: 'case_001', sourceRef: 'broker-a' }, 'client_001', 'op_001');
      expect(result.ok).toBe(true);
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'FOUND' }));
    });
  });

  describe('transition', () => {
    it('allows valid FOUND → CLASSIFIED transition', async () => {
      const result = await svc.transition('task_001', 'CLASSIFIED', 'client_001', 'op_001');
      expect(result.ok).toBe(true);
      expect(repo.updateStatus).toHaveBeenCalledWith('task_001', 'CLASSIFIED');
    });

    it('blocks invalid FOUND → SUBMITTED transition', async () => {
      const result = await svc.transition('task_001', 'SUBMITTED', 'client_001', 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('TRANSITION_NOT_ALLOWED');
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('blocks unknown status as target', async () => {
      const result = await svc.transition(
        'task_001',
        'NONEXISTENT_STATUS' as Parameters<typeof svc.transition>[1],
        'client_001',
        'op_001',
      );
      expect(result.ok).toBe(false);
    });

    it('returns NOT_FOUND for missing task', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.transition('missing', 'CLASSIFIED', 'client_001', 'op_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });

    it('writes timeline event on successful transition', async () => {
      const timeline = makeTimeline();
      const svc2 = new CleanupTaskService(repo, makeAudit(), timeline);
      await svc2.transition('task_001', 'CLASSIFIED', 'client_001', 'op_001');
      expect(timeline.append).toHaveBeenCalledWith(expect.objectContaining({
        fromStatus: 'FOUND',
        toStatus: 'CLASSIFIED',
      }));
    });

    it('writes audit block entry on invalid transition', async () => {
      const audit = makeAudit();
      const svc2 = new CleanupTaskService(repo, audit, makeTimeline());
      await svc2.transition('task_001', 'SUBMITTED', 'client_001', 'op_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'TASK_TRANSITION_BLOCKED',
        outcome: 'BLOCKED',
      }));
    });
  });

  describe('getAllowedTransitions', () => {
    it('returns non-empty list for FOUND', () => {
      const transitions = svc.getAllowedTransitions('FOUND');
      expect(transitions.length).toBeGreaterThan(0);
      expect(transitions).toContain('CLASSIFIED');
    });
  });
});
