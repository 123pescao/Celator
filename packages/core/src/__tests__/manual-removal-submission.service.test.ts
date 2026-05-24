import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManualRemovalSubmissionService } from '../services/manual-removal-submission.service.js';
import type { ManualRemovalSubmissionRepository, DataSourceTargetRepository, CleanupTaskRepository } from '@celator/db';
import type { ActionType } from '@celator/db';
import type { AuditService } from '../services/audit.service.js';
import type { CaseTimelineService } from '../services/case-timeline.service.js';

const FAKE_TARGET = {
  id: 'dst_001',
  sourceName: 'Example Data Broker',
  sourceType: 'DATA_BROKER' as const,
  baseDomain: 'databroker.invalid',
  jurisdiction: null,
  supportedActionTypes: ['OPT_OUT'] as ActionType[],
  requiresLogin: false,
  requiresCaptcha: false,
  manualOnly: false,
  piiRequiredFields: ['EMAIL'],
  notes: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_TASK = {
  id: 'task_001',
  caseId: 'case_001',
  dataSourceTargetId: 'dst_001',
  status: 'OPERATOR_APPROVED' as const,
  actionType: 'OPT_OUT' as const,
  matchStatus: 'CONFIRMED_MATCH' as const,
  riskTier: 'STANDARD' as const,
  sourceRef: 'smoke-broker',
  findingUrl: null,
  preparedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_SUBMISSION = {
  id: 'sub_001',
  taskId: 'task_001',
  dataSourceTargetId: 'dst_001',
  clientId: 'client_001',
  submittedByUserId: null,
  submissionMethod: 'WEB_FORM' as const,
  submissionStatus: 'DRAFTED' as const,
  submittedAt: null,
  confirmationCode: null,
  confirmationUrl: null,
  operatorNotes: null,
  redactedSummary: 'OPT_OUT to Example Data Broker — EMAIL: j***@example.com',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRepo(overrides?: Partial<ManualRemovalSubmissionRepository>): ManualRemovalSubmissionRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_SUBMISSION),
    findById: vi.fn().mockResolvedValue(FAKE_SUBMISSION),
    findByTaskId: vi.fn().mockResolvedValue([FAKE_SUBMISSION]),
    listForClient: vi.fn().mockResolvedValue([FAKE_SUBMISSION]),
    updateStatus: vi.fn().mockResolvedValue({ ...FAKE_SUBMISSION, submissionStatus: 'READY_FOR_MANUAL_SUBMISSION' }),
    updateSubmitted: vi.fn().mockResolvedValue({ ...FAKE_SUBMISSION, submissionStatus: 'SUBMITTED', submittedAt: new Date() }),
    updateOutcome: vi.fn().mockResolvedValue({ ...FAKE_SUBMISSION, submissionStatus: 'COMPLETED' }),
    ...overrides,
  } as unknown as ManualRemovalSubmissionRepository;
}

function makeTaskRepo(overrides?: Partial<CleanupTaskRepository>): CleanupTaskRepository {
  return {
    findById: vi.fn().mockResolvedValue(FAKE_TASK),
    create: vi.fn(),
    listForCase: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn(),
    update: vi.fn(),
    bulkUpdateStatus: vi.fn(),
    ...overrides,
  } as unknown as CleanupTaskRepository;
}

function makeTargetRepo(overrides?: Partial<DataSourceTargetRepository>): DataSourceTargetRepository {
  return {
    findById: vi.fn().mockResolvedValue(FAKE_TARGET),
    findBySourceName: vi.fn().mockResolvedValue(null),
    listActive: vi.fn().mockResolvedValue([FAKE_TARGET]),
    list: vi.fn().mockResolvedValue([FAKE_TARGET]),
    create: vi.fn(),
    update: vi.fn(),
    setActive: vi.fn(),
    ...overrides,
  } as unknown as DataSourceTargetRepository;
}

function makeAudit(): AuditService {
  return { write: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as unknown as AuditService;
}

function makeTimeline(): CaseTimelineService {
  return { append: vi.fn().mockResolvedValue({}), listForCase: vi.fn(), listForTask: vi.fn() } as unknown as CaseTimelineService;
}

describe('ManualRemovalSubmissionService', () => {
  let repo: ManualRemovalSubmissionRepository;
  let taskRepo: CleanupTaskRepository;
  let targetRepo: DataSourceTargetRepository;
  let audit: AuditService;
  let timeline: CaseTimelineService;
  let svc: ManualRemovalSubmissionService;

  beforeEach(() => {
    repo = makeRepo();
    taskRepo = makeTaskRepo();
    targetRepo = makeTargetRepo();
    audit = makeAudit();
    timeline = makeTimeline();
    svc = new ManualRemovalSubmissionService(repo, taskRepo, targetRepo, audit, timeline);
  });

  describe('createForTask', () => {
    it('creates a submission for a task with a linked target', async () => {
      const result = await svc.createForTask(
        { taskId: 'task_001', clientId: 'client_001', submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT to Example Data Broker — EMAIL: j***@example.com' },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskId).toBe('task_001');
      expect(result.value.submissionMethod).toBe('WEB_FORM');
    });

    it('rejects task without dataSourceTargetId', async () => {
      vi.mocked(taskRepo.findById).mockResolvedValueOnce({ ...FAKE_TASK, dataSourceTargetId: null });
      const result = await svc.createForTask(
        { taskId: 'task_001', clientId: 'client_001', submissionMethod: 'EMAIL', redactedSummary: 'OPT_OUT — EMAIL: j***@example.com' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('rejects missing task', async () => {
      vi.mocked(taskRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.createForTask(
        { taskId: 'missing', clientId: 'client_001', submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: j***@example.com' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });

    it('rejects inactive target', async () => {
      vi.mocked(targetRepo.findById).mockResolvedValueOnce({ ...FAKE_TARGET, isActive: false });
      const result = await svc.createForTask(
        { taskId: 'task_001', clientId: 'client_001', submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: j***@example.com' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('rejects redactedSummary containing raw email PII', async () => {
      const result = await svc.createForTask(
        { taskId: 'task_001', clientId: 'client_001', submissionMethod: 'WEB_FORM', redactedSummary: 'Remove john@example.com from Example Data Broker' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PII_FORBIDDEN_IN_REDACTED_PREVIEW');
    });

    it('rejects operatorNotes containing raw email PII', async () => {
      const result = await svc.createForTask(
        {
          taskId: 'task_001',
          clientId: 'client_001',
          submissionMethod: 'WEB_FORM',
          redactedSummary: 'OPT_OUT — EMAIL: j***@example.com',
          operatorNotes: 'Contact user@example.com to confirm',
        },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PII_FORBIDDEN_IN_REDACTED_PREVIEW');
    });

    it('writes audit log on creation', async () => {
      await svc.createForTask(
        { taskId: 'task_001', clientId: 'client_001', submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: j***@example.com' },
        'actor_001',
      );
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MANUAL_SUBMISSION_CREATED', outcome: 'ALLOWED' }));
    });

    it('appends timeline event on creation', async () => {
      await svc.createForTask(
        { taskId: 'task_001', clientId: 'client_001', submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: j***@example.com' },
        'actor_001',
      );
      expect(timeline.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MANUAL_SUBMISSION_CREATED' }));
    });

    it('response does not include plaintext PII', async () => {
      const result = await svc.createForTask(
        { taskId: 'task_001', clientId: 'client_001', submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: j***@example.com' },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const json = JSON.stringify(result.value);
      expect(json).not.toContain('john@example.com');
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
    });
  });

  describe('recordSubmitted', () => {
    it('marks submission as submitted', async () => {
      const result = await svc.recordSubmitted('sub_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.submissionStatus).toBe('SUBMITTED');
      expect(result.value.submittedAt).not.toBeNull();
    });

    it('rejects submission already in terminal status', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce({ ...FAKE_SUBMISSION, submissionStatus: 'COMPLETED' });
      const result = await svc.recordSubmitted('sub_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('MANUAL_SUBMISSION_INVALID_STATUS');
    });

    it('rejects missing submission', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.recordSubmitted('missing', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('MANUAL_SUBMISSION_NOT_FOUND');
    });

    it('writes audit log and appends timeline', async () => {
      await svc.recordSubmitted('sub_001', {}, 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MANUAL_SUBMISSION_SUBMITTED' }));
      expect(timeline.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MANUAL_SUBMISSION_SUBMITTED' }));
    });
  });

  describe('recordOutcome', () => {
    it('records completed outcome', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce({ ...FAKE_SUBMISSION, submissionStatus: 'SUBMITTED' });
      const result = await svc.recordOutcome('sub_001', { status: 'COMPLETED' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.submissionStatus).toBe('COMPLETED');
    });

    it('rejects outcome on already-terminal submission', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce({ ...FAKE_SUBMISSION, submissionStatus: 'FAILED' });
      const result = await svc.recordOutcome('sub_001', { status: 'COMPLETED' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('MANUAL_SUBMISSION_INVALID_STATUS');
    });

    it('writes audit log and appends timeline', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce({ ...FAKE_SUBMISSION, submissionStatus: 'SUBMITTED' });
      await svc.recordOutcome('sub_001', { status: 'ACKNOWLEDGED' }, 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MANUAL_SUBMISSION_OUTCOME_RECORDED' }));
      expect(timeline.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MANUAL_SUBMISSION_OUTCOME_RECORDED' }));
    });
  });

  describe('getById', () => {
    it('returns submission by id', async () => {
      const result = await svc.getById('sub_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('sub_001');
    });

    it('returns MANUAL_SUBMISSION_NOT_FOUND for missing id', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.getById('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('MANUAL_SUBMISSION_NOT_FOUND');
    });
  });

  describe('listForTask / listForClient', () => {
    it('lists submissions for a task', async () => {
      const result = await svc.listForTask('task_001');
      expect(result).toHaveLength(1);
      expect(result[0]?.taskId).toBe('task_001');
    });

    it('lists submissions for a client', async () => {
      const result = await svc.listForClient('client_001');
      expect(result).toHaveLength(1);
      expect(result[0]?.clientId).toBe('client_001');
    });
  });
});
