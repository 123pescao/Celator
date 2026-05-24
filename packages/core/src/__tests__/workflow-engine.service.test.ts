import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowEngineService } from '../services/workflow-engine.service.js';
import type {
  RemovalPlaybookRepository,
  TaskWorkflowRunRepository,
  CleanupTaskRepository,
  PlaybookWithSteps,
  WorkflowRunWithSteps,
} from '@celator/db';
import type { AuditService } from '../services/audit.service.js';
import type { CaseTimelineService } from '../services/case-timeline.service.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_TASK = {
  id: 'task_001',
  caseId: 'case_001',
  dataSourceTargetId: 'dst_001',
  status: 'OPERATOR_APPROVED' as const,
  actionType: 'OPT_OUT' as const,
  matchStatus: 'CONFIRMED_MATCH' as const,
  riskTier: 'STANDARD' as const,
  sourceRef: 'test-broker',
  findingUrl: null,
  preparedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_STEP_1 = {
  id: 'step_001',
  playbookId: 'pb_001',
  stepOrder: 1,
  stepKind: 'VERIFY_TARGET_REQUIREMENTS' as const,
  title: 'Verify Requirements',
  instructions: 'Check the target is active and requirements are met.',
  requiresApproval: false,
  requiresManualSubmission: false,
  requiredEvidenceType: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_STEP_2 = {
  id: 'step_002',
  playbookId: 'pb_001',
  stepOrder: 2,
  stepKind: 'MANUAL_SUBMISSION' as const,
  title: 'Submit Request',
  instructions: 'Submit the removal request manually.',
  requiresApproval: false,
  requiresManualSubmission: true,
  requiredEvidenceType: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_PLAYBOOK: PlaybookWithSteps = {
  id: 'pb_001',
  name: 'Test Playbook',
  version: '1.0.0',
  sourceType: 'DATA_BROKER',
  dataSourceTargetId: null,
  status: 'ACTIVE',
  description: 'A test playbook',
  createdAt: new Date(),
  updatedAt: new Date(),
  steps: [FAKE_STEP_1, FAKE_STEP_2],
};

const FAKE_RUN = {
  id: 'run_001',
  taskId: 'task_001',
  clientId: 'client_001',
  playbookId: 'pb_001',
  status: 'IN_PROGRESS' as const,
  currentStepOrder: 1,
  startedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_STEP_RUN_1 = {
  id: 'sr_001',
  workflowRunId: 'run_001',
  playbookStepId: 'step_001',
  stepOrder: 1,
  stepKind: 'VERIFY_TARGET_REQUIREMENTS' as const,
  status: 'READY' as const,
  operatorNotes: null,
  safeResultSummary: null,
  evidenceRecordId: null,
  manualSubmissionId: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_STEP_RUN_2 = {
  id: 'sr_002',
  workflowRunId: 'run_001',
  playbookStepId: 'step_002',
  stepOrder: 2,
  stepKind: 'MANUAL_SUBMISSION' as const,
  status: 'PENDING' as const,
  operatorNotes: null,
  safeResultSummary: null,
  evidenceRecordId: null,
  manualSubmissionId: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePlaybookRepo(overrides?: Partial<RemovalPlaybookRepository>): RemovalPlaybookRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_PLAYBOOK),
    addStep: vi.fn().mockResolvedValueOnce(FAKE_STEP_1).mockResolvedValueOnce(FAKE_STEP_2),
    findById: vi.fn().mockResolvedValue(FAKE_PLAYBOOK),
    findByIdWithSteps: vi.fn().mockResolvedValue(FAKE_PLAYBOOK),
    findActiveForTarget: vi.fn().mockResolvedValue(FAKE_PLAYBOOK),
    findActiveForSourceType: vi.fn().mockResolvedValue(null),
    listActive: vi.fn().mockResolvedValue([FAKE_PLAYBOOK]),
    listActiveWithSteps: vi.fn().mockResolvedValue([FAKE_PLAYBOOK]),
    setStatus: vi.fn().mockResolvedValue({ ...FAKE_PLAYBOOK, status: 'INACTIVE' }),
    ...overrides,
  } as unknown as RemovalPlaybookRepository;
}

function makeRunRepo(overrides?: Partial<TaskWorkflowRunRepository>): TaskWorkflowRunRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_RUN),
    createStepRun: vi.fn()
      .mockResolvedValueOnce(FAKE_STEP_RUN_1)
      .mockResolvedValueOnce(FAKE_STEP_RUN_2),
    findById: vi.fn().mockResolvedValue(FAKE_RUN),
    findByIdWithSteps: vi.fn().mockResolvedValue({ ...FAKE_RUN, stepRuns: [FAKE_STEP_RUN_1, FAKE_STEP_RUN_2] } as unknown as WorkflowRunWithSteps),
    findActiveByTaskId: vi.fn().mockResolvedValue(FAKE_RUN),
    findLatestByTaskId: vi.fn().mockResolvedValue(FAKE_RUN),
    listForClient: vi.fn().mockResolvedValue([FAKE_RUN]),
    findStepRunById: vi.fn().mockResolvedValue(FAKE_STEP_RUN_1),
    listStepRunsForRun: vi.fn().mockResolvedValue([FAKE_STEP_RUN_1, FAKE_STEP_RUN_2]),
    updateRunStatus: vi.fn().mockResolvedValue(FAKE_RUN),
    updateStepStatus: vi.fn().mockResolvedValue(FAKE_STEP_RUN_1),
    attachManualSubmission: vi.fn().mockResolvedValue({ ...FAKE_STEP_RUN_1, manualSubmissionId: 'sub_001' }),
    attachEvidence: vi.fn().mockResolvedValue({ ...FAKE_STEP_RUN_1, evidenceRecordId: 'ev_001' }),
    ...overrides,
  } as unknown as TaskWorkflowRunRepository;
}

function makeTaskRepo(): CleanupTaskRepository {
  return {
    findById: vi.fn().mockResolvedValue(FAKE_TASK),
    create: vi.fn(),
    listForCase: vi.fn().mockResolvedValue([]),
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

describe('WorkflowEngineService', () => {
  let playbookRepo: RemovalPlaybookRepository;
  let runRepo: TaskWorkflowRunRepository;
  let taskRepo: CleanupTaskRepository;
  let audit: AuditService;
  let timeline: CaseTimelineService;
  let svc: WorkflowEngineService;

  beforeEach(() => {
    playbookRepo = makePlaybookRepo();
    runRepo = makeRunRepo();
    taskRepo = makeTaskRepo();
    audit = makeAudit();
    timeline = makeTimeline();
    svc = new WorkflowEngineService(playbookRepo, runRepo, taskRepo, audit, timeline);
  });

  describe('createPlaybook', () => {
    it('creates a playbook with ordered steps', async () => {
      const result = await svc.createPlaybook(
        {
          name: 'Test Playbook',
          version: '1.0.0',
          sourceType: 'DATA_BROKER',
          steps: [
            { stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Verify', instructions: 'Check requirements.' },
            { stepOrder: 2, stepKind: 'MANUAL_SUBMISSION', title: 'Submit', instructions: 'Submit the request.' },
          ],
        },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe('Test Playbook');
      expect(result.value.steps).toHaveLength(2);
    });

    it('rejects duplicate stepOrder values', async () => {
      const result = await svc.createPlaybook(
        {
          name: 'Bad Playbook',
          version: '1.0.0',
          steps: [
            { stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'A', instructions: 'Do A.' },
            { stepOrder: 1, stepKind: 'MANUAL_SUBMISSION', title: 'B', instructions: 'Do B.' },
          ],
        },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('rejects empty steps array', async () => {
      const result = await svc.createPlaybook(
        { name: 'Empty', version: '1.0.0', steps: [] },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('rejects PII in instructions', async () => {
      const result = await svc.createPlaybook(
        {
          name: 'PII Playbook',
          version: '1.0.0',
          steps: [
            { stepOrder: 1, stepKind: 'MANUAL_SUBMISSION', title: 'Submit', instructions: 'Email john@example.com for confirmation.' },
          ],
        },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_UNSAFE_TEXT');
    });

    it('writes audit event on creation', async () => {
      await svc.createPlaybook(
        {
          name: 'Test',
          version: '1.0.0',
          steps: [{ stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Check', instructions: 'Verify requirements.' }],
        },
        'actor_001',
      );
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'WORKFLOW_PLAYBOOK_CREATED' }));
    });
  });

  describe('startWorkflowForTask', () => {
    it('creates workflow run and step runs for task', async () => {
      const result = await svc.startWorkflowForTask(
        { taskId: 'task_001', clientId: 'client_001', playbookId: 'pb_001' },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.run.taskId).toBe('task_001');
      expect(result.value.steps).toHaveLength(2);
    });

    it('marks first step as READY', async () => {
      const result = await svc.startWorkflowForTask(
        { taskId: 'task_001', clientId: 'client_001', playbookId: 'pb_001' },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const first = result.value.steps[0];
      expect(first?.status).toBe('READY');
    });

    it('returns PLAYBOOK_NOT_FOUND for inactive playbook', async () => {
      vi.mocked(playbookRepo.findByIdWithSteps).mockResolvedValueOnce({ ...FAKE_PLAYBOOK, status: 'INACTIVE' });
      const result = await svc.startWorkflowForTask(
        { taskId: 'task_001', clientId: 'client_001', playbookId: 'pb_001' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PLAYBOOK_NOT_FOUND');
    });

    it('auto-selects playbook by target when no playbookId provided', async () => {
      const result = await svc.startWorkflowForTask(
        { taskId: 'task_001', clientId: 'client_001' },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      expect(playbookRepo.findActiveForTarget).toHaveBeenCalledWith('dst_001');
    });

    it('returns PLAYBOOK_NOT_FOUND when no auto-selected playbook exists', async () => {
      vi.mocked(playbookRepo.findActiveForTarget).mockResolvedValueOnce(null);
      const result = await svc.startWorkflowForTask(
        { taskId: 'task_001', clientId: 'client_001' },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PLAYBOOK_NOT_FOUND');
    });

    it('writes audit and timeline events on start', async () => {
      await svc.startWorkflowForTask(
        { taskId: 'task_001', clientId: 'client_001', playbookId: 'pb_001' },
        'actor_001',
      );
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'WORKFLOW_STARTED' }));
      expect(timeline.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'WORKFLOW_STARTED' }));
    });
  });

  describe('advanceStep', () => {
    it('marks step COMPLETED and advances next step to READY', async () => {
      vi.mocked(runRepo.listStepRunsForRun).mockResolvedValueOnce([
        { ...FAKE_STEP_RUN_1, status: 'READY' },
        { ...FAKE_STEP_RUN_2, status: 'PENDING' },
      ]);
      vi.mocked(runRepo.updateRunStatus).mockResolvedValueOnce(FAKE_RUN);
      const result = await svc.advanceStep('run_001', 'sr_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(runRepo.updateStepStatus).toHaveBeenCalledWith('sr_001', expect.objectContaining({ status: 'COMPLETED' }));
      expect(runRepo.updateStepStatus).toHaveBeenCalledWith('sr_002', expect.objectContaining({ status: 'READY' }));
    });

    it('marks workflow COMPLETED when final step advances', async () => {
      vi.mocked(runRepo.listStepRunsForRun).mockResolvedValueOnce([
        { ...FAKE_STEP_RUN_1, status: 'READY' },
        { ...FAKE_STEP_RUN_2, status: 'COMPLETED' },
      ]);
      const completedRun = { ...FAKE_RUN, status: 'COMPLETED' as const };
      vi.mocked(runRepo.updateRunStatus).mockResolvedValueOnce(completedRun);
      const result = await svc.advanceStep('run_001', 'sr_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(runRepo.updateRunStatus).toHaveBeenCalledWith('run_001', expect.objectContaining({ status: 'COMPLETED' }));
    });

    it('rejects advance on terminal workflow', async () => {
      vi.mocked(runRepo.findById).mockResolvedValueOnce({ ...FAKE_RUN, status: 'COMPLETED' });
      const result = await svc.advanceStep('run_001', 'sr_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_INVALID_TRANSITION');
    });

    it('rejects unsafe operatorNotes', async () => {
      const result = await svc.advanceStep(
        'run_001',
        'sr_001',
        { operatorNotes: 'Contact user@example.com for next steps' },
        'client_001',
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_UNSAFE_TEXT');
    });

    it('writes WORKFLOW_COMPLETED audit event on final step', async () => {
      vi.mocked(runRepo.listStepRunsForRun).mockResolvedValueOnce([
        { ...FAKE_STEP_RUN_1, status: 'READY' },
        { ...FAKE_STEP_RUN_2, status: 'COMPLETED' },
      ]);
      vi.mocked(runRepo.updateRunStatus).mockResolvedValueOnce({ ...FAKE_RUN, status: 'COMPLETED' });
      await svc.advanceStep('run_001', 'sr_001', {}, 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'WORKFLOW_COMPLETED' }));
    });
  });

  describe('blockStep', () => {
    it('marks step and run as BLOCKED', async () => {
      vi.mocked(runRepo.updateRunStatus).mockResolvedValueOnce({ ...FAKE_RUN, status: 'BLOCKED' });
      const result = await svc.blockStep('run_001', 'sr_001', { reason: 'Broker portal is down' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(runRepo.updateStepStatus).toHaveBeenCalledWith('sr_001', expect.objectContaining({ status: 'BLOCKED' }));
      expect(runRepo.updateRunStatus).toHaveBeenCalledWith('run_001', expect.objectContaining({ status: 'BLOCKED' }));
    });

    it('rejects unsafe reason', async () => {
      const result = await svc.blockStep('run_001', 'sr_001', { reason: 'Contact admin@example.com' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_UNSAFE_TEXT');
    });

    it('writes WORKFLOW_STEP_BLOCKED audit event', async () => {
      vi.mocked(runRepo.updateRunStatus).mockResolvedValueOnce({ ...FAKE_RUN, status: 'BLOCKED' });
      await svc.blockStep('run_001', 'sr_001', { reason: 'Blocked due to missing evidence' }, 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'WORKFLOW_STEP_BLOCKED', outcome: 'BLOCKED' }));
    });
  });

  describe('attachManualSubmission', () => {
    it('links manual submission to MANUAL_SUBMISSION step', async () => {
      vi.mocked(runRepo.findStepRunById).mockResolvedValueOnce({ ...FAKE_STEP_RUN_1, stepKind: 'MANUAL_SUBMISSION' });
      const result = await svc.attachManualSubmission('run_001', 'sr_001', { manualSubmissionId: 'sub_001' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(runRepo.attachManualSubmission).toHaveBeenCalledWith('sr_001', 'sub_001');
    });

    it('links manual submission to RECORD_OUTCOME step', async () => {
      vi.mocked(runRepo.findStepRunById).mockResolvedValueOnce({ ...FAKE_STEP_RUN_1, stepKind: 'RECORD_OUTCOME' });
      const result = await svc.attachManualSubmission('run_001', 'sr_001', { manualSubmissionId: 'sub_001' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('rejects attachment to disallowed step kind', async () => {
      vi.mocked(runRepo.findStepRunById).mockResolvedValueOnce({ ...FAKE_STEP_RUN_1, stepKind: 'VERIFY_TARGET_REQUIREMENTS' });
      const result = await svc.attachManualSubmission('run_001', 'sr_001', { manualSubmissionId: 'sub_001' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_INVALID_TRANSITION');
    });

    it('writes WORKFLOW_MANUAL_SUBMISSION_LINKED audit event', async () => {
      vi.mocked(runRepo.findStepRunById).mockResolvedValueOnce({ ...FAKE_STEP_RUN_1, stepKind: 'MANUAL_SUBMISSION' });
      await svc.attachManualSubmission('run_001', 'sr_001', { manualSubmissionId: 'sub_001' }, 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'WORKFLOW_MANUAL_SUBMISSION_LINKED' }));
    });
  });

  describe('getWorkflowState', () => {
    it('returns safe workflow state with steps', async () => {
      vi.mocked(runRepo.listStepRunsForRun).mockResolvedValueOnce([FAKE_STEP_RUN_1, FAKE_STEP_RUN_2]);
      const result = await svc.getWorkflowState('run_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.run.id).toBe('run_001');
      expect(result.value.steps).toHaveLength(2);
      // No ciphertext or raw PII in response
      const json = JSON.stringify(result.value);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
      expect(json).not.toContain('@example.com');
    });

    it('returns WORKFLOW_RUN_NOT_FOUND for missing run', async () => {
      vi.mocked(runRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.getWorkflowState('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_RUN_NOT_FOUND');
    });

    it('merges playbook step titles and instructions into step runs', async () => {
      vi.mocked(runRepo.listStepRunsForRun).mockResolvedValueOnce([FAKE_STEP_RUN_1]);
      const result = await svc.getWorkflowState('run_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.steps[0]?.title).toBe('Verify Requirements');
      expect(result.value.steps[0]?.instructions).toContain('Check the target');
    });
  });
});
