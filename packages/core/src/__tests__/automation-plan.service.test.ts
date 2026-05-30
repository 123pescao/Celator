import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationPlanService } from '../services/automation-plan.service.js';
import type { AutomationPlanRepository, CleanupTaskRepository, EmergencyPauseRepository } from '@celator/db';
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

const FAKE_PLAN = {
  id: 'plan_001',
  taskId: 'task_001',
  clientId: 'client_001',
  status: 'PENDING_APPROVAL' as const,
  intentJson: { action: 'OPT_OUT', targetId: 'dst_001' },
  dryRunResultJson: null,
  approvedByUserId: null,
  rejectedByUserId: null,
  rejectionReason: null,
  cancelledByUserId: null,
  approvedAt: null,
  rejectedAt: null,
  dryRunStartedAt: null,
  dryRunCompletedAt: null,
  cancelledAt: null,
  emergencyPauseBlockedAt: null,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_PAUSE = {
  id: 'pause_001',
  scope: 'GLOBAL' as const,
  scopeRef: null,
  status: 'ACTIVE' as const,
  reason: 'Regulatory hold',
  triggeredBy: 'admin_001',
  requiresDualAdmin: false,
  triggeredAt: new Date(),
  resolvedBy: null,
  resolvedAt: null,
  resolutionSummary: null,
  secondAdminApprovedBy: null,
  secondAdminApprovedAt: null,
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePlanRepo(overrides?: Partial<AutomationPlanRepository>): AutomationPlanRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_PLAN),
    findById: vi.fn().mockResolvedValue(FAKE_PLAN),
    listForTask: vi.fn().mockResolvedValue([FAKE_PLAN]),
    listForClient: vi.fn().mockResolvedValue([FAKE_PLAN]),
    listByStatus: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ ...FAKE_PLAN, status: 'APPROVED' }),
    ...overrides,
  } as unknown as AutomationPlanRepository;
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

function makePauseRepo(activeGlobal: typeof FAKE_PAUSE | null = null): EmergencyPauseRepository {
  return {
    findActiveGlobal: vi.fn().mockResolvedValue(activeGlobal),
    findActiveForScope: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    findById: vi.fn(),
    listActive: vi.fn(),
    resolve: vi.fn(),
  } as unknown as EmergencyPauseRepository;
}

function makeAudit(): AuditService {
  return { write: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as unknown as AuditService;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AutomationPlanService', () => {
  let planRepo: AutomationPlanRepository;
  let taskRepo: CleanupTaskRepository;
  let pauseRepo: EmergencyPauseRepository;
  let audit: AuditService;
  let svc: AutomationPlanService;

  beforeEach(() => {
    planRepo = makePlanRepo();
    taskRepo = makeTaskRepo();
    pauseRepo = makePauseRepo();
    audit = makeAudit();
    svc = new AutomationPlanService(planRepo, taskRepo, pauseRepo, audit);
  });

  describe('createPlan', () => {
    it('creates plan with PENDING_APPROVAL status for safe intentJson', async () => {
      const result = await svc.createPlan(
        { taskId: 'task_001', clientId: 'client_001', intentJson: { action: 'OPT_OUT', targetId: 'dst_001' } },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('PENDING_APPROVAL');
      expect(planRepo.create).toHaveBeenCalledOnce();
    });

    it('returns AUTOMATION_PLAN_INTENT_UNSAFE when intentJson contains PII field name', async () => {
      const result = await svc.createPlan(
        { taskId: 'task_001', clientId: 'client_001', intentJson: { email: 'some@value.com', action: 'OPT_OUT' } },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_INTENT_UNSAFE');
      expect(planRepo.create).not.toHaveBeenCalled();
    });

    it('returns NOT_FOUND when task does not exist', async () => {
      vi.mocked(taskRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.createPlan(
        { taskId: 'task_missing', clientId: 'client_001', intentJson: { action: 'OPT_OUT' } },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });

    it('returns AUTOMATION_PLAN_PAUSED when global emergency pause is active', async () => {
      pauseRepo = makePauseRepo(FAKE_PAUSE);
      svc = new AutomationPlanService(planRepo, taskRepo, pauseRepo, audit);
      const result = await svc.createPlan(
        { taskId: 'task_001', clientId: 'client_001', intentJson: { action: 'OPT_OUT' } },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_PAUSED');
      expect(planRepo.create).not.toHaveBeenCalled();
    });

    it('returns AUTOMATION_PLAN_PAUSED when client-scoped pause is active', async () => {
      vi.mocked(pauseRepo.findActiveForScope).mockResolvedValueOnce({ ...FAKE_PAUSE, scope: 'CLIENT' as const, scopeRef: 'client_001' });
      const result = await svc.createPlan(
        { taskId: 'task_001', clientId: 'client_001', intentJson: { action: 'OPT_OUT' } },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_PAUSED');
    });

    it('writes AUTOMATION_PLAN_CREATED audit event with IDs only', async () => {
      await svc.createPlan(
        { taskId: 'task_001', clientId: 'client_001', intentJson: { action: 'OPT_OUT' } },
        'actor_001',
      );
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'AUTOMATION_PLAN_CREATED' }));
      const call = vi.mocked(audit.write).mock.calls[0]![0];
      const meta = JSON.stringify(call.metadata);
      expect(meta).not.toContain('OPT_OUT');
    });

    it('fails closed when audit.write returns an error', async () => {
      vi.mocked(audit.write).mockResolvedValueOnce({ ok: false, error: 'AUDIT_LOG_FAILED', message: 'DB down' });
      const result = await svc.createPlan(
        { taskId: 'task_001', clientId: 'client_001', intentJson: { action: 'OPT_OUT' } },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });
  });

  describe('approvePlan', () => {
    it('transitions PENDING_APPROVAL to APPROVED and sets approvedByUserId and approvedAt', async () => {
      vi.mocked(planRepo.update).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'APPROVED' as const, approvedByUserId: 'approver_001', approvedAt: new Date() });
      const result = await svc.approvePlan('plan_001', 'approver_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(planRepo.update).toHaveBeenCalledWith('plan_001', expect.objectContaining({ status: 'APPROVED', approvedByUserId: 'approver_001' }));
    });

    it('returns AUTOMATION_PLAN_NOT_FOUND when plan does not exist', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.approvePlan('missing', 'approver_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_NOT_FOUND');
    });

    it('returns AUTOMATION_PLAN_INVALID_STATUS when plan is not PENDING_APPROVAL', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'APPROVED' as const });
      const result = await svc.approvePlan('plan_001', 'approver_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_INVALID_STATUS');
      expect(planRepo.update).not.toHaveBeenCalled();
    });

    it('returns AUTOMATION_PLAN_PAUSED when pause activates between create and approve', async () => {
      vi.mocked(pauseRepo.findActiveGlobal).mockResolvedValueOnce(FAKE_PAUSE);
      const result = await svc.approvePlan('plan_001', 'approver_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_PAUSED');
    });

    it('stores emergencyPauseBlockedAt when pause blocks approval', async () => {
      vi.mocked(pauseRepo.findActiveGlobal).mockResolvedValueOnce(FAKE_PAUSE);
      await svc.approvePlan('plan_001', 'approver_001', 'actor_001');
      expect(planRepo.update).toHaveBeenCalledWith('plan_001', expect.objectContaining({ emergencyPauseBlockedAt: expect.any(Date) }));
    });
  });

  describe('rejectPlan', () => {
    it('transitions PENDING_APPROVAL to REJECTED with rejectionReason', async () => {
      vi.mocked(planRepo.update).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'REJECTED' as const, rejectedByUserId: 'reviewer_001', rejectionReason: 'Not authorized', rejectedAt: new Date() });
      const result = await svc.rejectPlan('plan_001', 'reviewer_001', 'Not authorized', 'actor_001');
      expect(result.ok).toBe(true);
      expect(planRepo.update).toHaveBeenCalledWith('plan_001', expect.objectContaining({ status: 'REJECTED', rejectionReason: 'Not authorized' }));
    });

    it('returns AUTOMATION_PLAN_INVALID_STATUS when plan is not PENDING_APPROVAL', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'APPROVED' as const });
      const result = await svc.rejectPlan('plan_001', 'reviewer_001', 'Not allowed', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_INVALID_STATUS');
    });

    it('returns AUTOMATION_PLAN_INTENT_UNSAFE when rejectionReason contains raw PII', async () => {
      const result = await svc.rejectPlan('plan_001', 'reviewer_001', 'Rejected because user@example.com flagged', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_INTENT_UNSAFE');
    });
  });

  describe('executeDryRun', () => {
    it('transitions APPROVED to DRY_RUN_COMPLETE with stub dryRunResultJson', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'APPROVED' as const });
      vi.mocked(planRepo.update).mockResolvedValueOnce({
        ...FAKE_PLAN,
        status: 'DRY_RUN_COMPLETE' as const,
        dryRunStartedAt: new Date(),
        dryRunCompletedAt: new Date(),
        dryRunResultJson: { dryRun: true, wouldHaveExecuted: 'plan_001', intentSummary: 'DRY_RUN_ONLY — no real execution performed' },
      });
      const result = await svc.executeDryRun('plan_001', 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.dryRunResultJson).toMatchObject({ dryRun: true });
    });

    it('dry run result contains dryRun: true sentinel — no real execution', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'APPROVED' as const });
      vi.mocked(planRepo.update).mockResolvedValueOnce({
        ...FAKE_PLAN,
        status: 'DRY_RUN_COMPLETE' as const,
        dryRunResultJson: { dryRun: true, wouldHaveExecuted: 'plan_001', intentSummary: 'DRY_RUN_ONLY — no real execution performed' },
        dryRunStartedAt: new Date(),
        dryRunCompletedAt: new Date(),
      });
      await svc.executeDryRun('plan_001', 'actor_001');
      const updateCall = vi.mocked(planRepo.update).mock.calls[0]![1];
      const result = updateCall.dryRunResultJson as Record<string, unknown>;
      expect(result['dryRun']).toBe(true);
      expect(result['intentSummary']).toContain('DRY_RUN_ONLY');
    });

    it('returns AUTOMATION_PLAN_INVALID_STATUS when plan is not APPROVED', async () => {
      const result = await svc.executeDryRun('plan_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_INVALID_STATUS');
    });

    it('returns AUTOMATION_PLAN_PAUSED when pause activates before dry run', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'APPROVED' as const });
      vi.mocked(pauseRepo.findActiveGlobal).mockResolvedValueOnce(FAKE_PAUSE);
      const result = await svc.executeDryRun('plan_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_PAUSED');
    });

    it('writes AUTOMATION_PLAN_DRY_RUN_COMPLETE audit event', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'APPROVED' as const });
      vi.mocked(planRepo.update).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'DRY_RUN_COMPLETE' as const, dryRunResultJson: { dryRun: true }, dryRunStartedAt: new Date(), dryRunCompletedAt: new Date() });
      await svc.executeDryRun('plan_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'AUTOMATION_PLAN_DRY_RUN_COMPLETE' }));
    });
  });

  describe('cancelPlan', () => {
    it('transitions PENDING_APPROVAL to CANCELLED', async () => {
      vi.mocked(planRepo.update).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'CANCELLED' as const, cancelledByUserId: 'user_001', cancelledAt: new Date() });
      const result = await svc.cancelPlan('plan_001', 'user_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(planRepo.update).toHaveBeenCalledWith('plan_001', expect.objectContaining({ status: 'CANCELLED' }));
    });

    it('transitions APPROVED to CANCELLED', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'APPROVED' as const });
      vi.mocked(planRepo.update).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'CANCELLED' as const, cancelledAt: new Date() });
      const result = await svc.cancelPlan('plan_001', 'user_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('returns AUTOMATION_PLAN_INVALID_STATUS when plan is already in terminal state', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'DRY_RUN_COMPLETE' as const });
      const result = await svc.cancelPlan('plan_001', 'user_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_INVALID_STATUS');
    });

    it('returns AUTOMATION_PLAN_INVALID_STATUS when plan is REJECTED', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce({ ...FAKE_PLAN, status: 'REJECTED' as const });
      const result = await svc.cancelPlan('plan_001', 'user_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_INVALID_STATUS');
    });
  });

  describe('getById', () => {
    it('returns SafeAutomationPlan when plan exists', async () => {
      const result = await svc.getById('plan_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('plan_001');
    });

    it('returns AUTOMATION_PLAN_NOT_FOUND when plan does not exist', async () => {
      vi.mocked(planRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.getById('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTOMATION_PLAN_NOT_FOUND');
    });
  });

  describe('listForTask', () => {
    it('returns array of SafeAutomationPlan for the given taskId', async () => {
      const result = await svc.listForTask('task_001');
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]!.taskId).toBe('task_001');
    });

    it('returns empty array when task has no plans', async () => {
      vi.mocked(planRepo.listForTask).mockResolvedValueOnce([]);
      const result = await svc.listForTask('task_001');
      expect(result).toEqual([]);
    });
  });
});
