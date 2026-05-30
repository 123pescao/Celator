import type { AutomationPlanRepository, AutomationPlanStatus, AutomationPlan, CleanupTaskRepository, EmergencyPauseRepository, Prisma } from '@celator/db';
import { checkAuditMetadata } from '@celator/security';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';

// ─── Terminal plan statuses ───────────────────────────────────────────────────

const TERMINAL_PLAN_STATUSES: AutomationPlanStatus[] = ['REJECTED', 'DRY_RUN_COMPLETE', 'CANCELLED'];
const CANCELLABLE_PLAN_STATUSES: AutomationPlanStatus[] = ['PENDING_APPROVAL', 'APPROVED'];

// ─── Input / output types ────────────────────────────────────────────────────

export interface CreateAutomationPlanInput {
  taskId: string;
  clientId: string;
  intentJson: Record<string, unknown>;
  createdByUserId?: string;
}

export interface SafeAutomationPlan {
  id: string;
  taskId: string;
  clientId: string;
  status: string;
  intentJson: Record<string, unknown>;
  dryRunResultJson: Record<string, unknown> | null;
  approvedByUserId: string | null;
  rejectedByUserId: string | null;
  rejectionReason: string | null;
  cancelledByUserId: string | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  dryRunStartedAt: Date | null;
  dryRunCompletedAt: Date | null;
  cancelledAt: Date | null;
  emergencyPauseBlockedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function toSafe(p: AutomationPlan): SafeAutomationPlan {
  return {
    id: p.id,
    taskId: p.taskId,
    clientId: p.clientId,
    status: p.status,
    intentJson: p.intentJson as Record<string, unknown>,
    dryRunResultJson: p.dryRunResultJson as Record<string, unknown> | null,
    approvedByUserId: p.approvedByUserId,
    rejectedByUserId: p.rejectedByUserId,
    rejectionReason: p.rejectionReason,
    cancelledByUserId: p.cancelledByUserId,
    approvedAt: p.approvedAt,
    rejectedAt: p.rejectedAt,
    dryRunStartedAt: p.dryRunStartedAt,
    dryRunCompletedAt: p.dryRunCompletedAt,
    cancelledAt: p.cancelledAt,
    emergencyPauseBlockedAt: p.emergencyPauseBlockedAt,
    createdByUserId: p.createdByUserId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AutomationPlanService {
  constructor(
    private readonly planRepo: AutomationPlanRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly emergencyPauseRepo: EmergencyPauseRepository,
    private readonly audit: AuditService,
  ) {}

  private async checkEmergencyPause(clientId: string): Promise<boolean> {
    const globalPause = await this.emergencyPauseRepo.findActiveGlobal();
    if (globalPause) return true;
    const clientPause = await this.emergencyPauseRepo.findActiveForScope('CLIENT', clientId);
    return clientPause !== null;
  }

  async createPlan(
    input: CreateAutomationPlanInput,
    actorId: string,
  ): Promise<Result<SafeAutomationPlan, ErrorCode>> {
    // Validate intentJson has no PII field names or patterns
    const intentViolation = checkAuditMetadata(input.intentJson);
    if (intentViolation) {
      return err('AUTOMATION_PLAN_INTENT_UNSAFE', `intentJson rejected: ${intentViolation}`);
    }

    const task = await this.taskRepo.findById(input.taskId);
    if (!task) return err('NOT_FOUND', `Task ${input.taskId} not found`);

    const isPaused = await this.checkEmergencyPause(input.clientId);
    if (isPaused) {
      return err('AUTOMATION_PLAN_PAUSED', `Automation blocked: emergency pause is active for client ${input.clientId}`);
    }

    const plan = await this.planRepo.create({
      task: { connect: { id: input.taskId } },
      client: { connect: { id: input.clientId } },
      intentJson: input.intentJson as Prisma.InputJsonValue,
      ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
    });

    const auditResult = await this.audit.write({
      eventType: 'AUTOMATION_PLAN_CREATED',
      actorId,
      actorType: 'OPERATOR',
      clientId: input.clientId,
      resourceId: plan.id,
      resourceType: 'AutomationPlan',
      outcome: 'ALLOWED',
      metadata: { planId: plan.id, taskId: input.taskId, clientId: input.clientId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(plan));
  }

  async approvePlan(
    planId: string,
    approvedByUserId: string,
    actorId: string,
  ): Promise<Result<SafeAutomationPlan, ErrorCode>> {
    const plan = await this.planRepo.findById(planId);
    if (!plan) return err('AUTOMATION_PLAN_NOT_FOUND', `AutomationPlan ${planId} not found`);

    if (plan.status !== 'PENDING_APPROVAL') {
      return err('AUTOMATION_PLAN_INVALID_STATUS', `Cannot approve plan with status "${plan.status}" — must be PENDING_APPROVAL`);
    }

    const isPaused = await this.checkEmergencyPause(plan.clientId);
    if (isPaused) {
      await this.planRepo.update(planId, { emergencyPauseBlockedAt: new Date() });
      return err('AUTOMATION_PLAN_PAUSED', `Approval blocked: emergency pause is active for client ${plan.clientId}`);
    }

    const now = new Date();
    const updated = await this.planRepo.update(planId, {
      status: 'APPROVED',
      approvedByUserId,
      approvedAt: now,
    });

    const auditResult = await this.audit.write({
      eventType: 'AUTOMATION_PLAN_APPROVED',
      actorId,
      actorType: 'OPERATOR',
      clientId: plan.clientId,
      resourceId: planId,
      resourceType: 'AutomationPlan',
      outcome: 'ALLOWED',
      metadata: { planId, taskId: plan.taskId, clientId: plan.clientId, approvedByUserId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async rejectPlan(
    planId: string,
    rejectedByUserId: string,
    rejectionReason: string,
    actorId: string,
  ): Promise<Result<SafeAutomationPlan, ErrorCode>> {
    const plan = await this.planRepo.findById(planId);
    if (!plan) return err('AUTOMATION_PLAN_NOT_FOUND', `AutomationPlan ${planId} not found`);

    if (plan.status !== 'PENDING_APPROVAL') {
      return err('AUTOMATION_PLAN_INVALID_STATUS', `Cannot reject plan with status "${plan.status}" — must be PENDING_APPROVAL`);
    }

    const reasonViolation = checkRedactedPreview(rejectionReason);
    if (reasonViolation) {
      return err('AUTOMATION_PLAN_INTENT_UNSAFE', `rejectionReason rejected: ${reasonViolation}`);
    }

    const now = new Date();
    const updated = await this.planRepo.update(planId, {
      status: 'REJECTED',
      rejectedByUserId,
      rejectionReason,
      rejectedAt: now,
    });

    const auditResult = await this.audit.write({
      eventType: 'AUTOMATION_PLAN_REJECTED',
      actorId,
      actorType: 'OPERATOR',
      clientId: plan.clientId,
      resourceId: planId,
      resourceType: 'AutomationPlan',
      outcome: 'BLOCKED',
      metadata: { planId, taskId: plan.taskId, clientId: plan.clientId, rejectedByUserId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async executeDryRun(
    planId: string,
    actorId: string,
  ): Promise<Result<SafeAutomationPlan, ErrorCode>> {
    const plan = await this.planRepo.findById(planId);
    if (!plan) return err('AUTOMATION_PLAN_NOT_FOUND', `AutomationPlan ${planId} not found`);

    if (plan.status !== 'APPROVED') {
      return err('AUTOMATION_PLAN_INVALID_STATUS', `Cannot execute dry run from status "${plan.status}" — must be APPROVED`);
    }

    const isPaused = await this.checkEmergencyPause(plan.clientId);
    if (isPaused) {
      await this.planRepo.update(planId, { emergencyPauseBlockedAt: new Date() });
      return err('AUTOMATION_PLAN_PAUSED', `Dry run blocked: emergency pause is active for client ${plan.clientId}`);
    }

    const now = new Date();

    // DRY_RUN only — static stub result, no real execution, no network calls
    const dryRunResultJson = {
      dryRun: true,
      wouldHaveExecuted: planId,
      intentSummary: 'DRY_RUN_ONLY — no real execution performed',
    };

    const updated = await this.planRepo.update(planId, {
      status: 'DRY_RUN_COMPLETE',
      dryRunStartedAt: now,
      dryRunCompletedAt: now,
      dryRunResultJson: dryRunResultJson as Prisma.InputJsonValue,
    });

    const auditResult = await this.audit.write({
      eventType: 'AUTOMATION_PLAN_DRY_RUN_COMPLETE',
      actorId,
      actorType: 'OPERATOR',
      clientId: plan.clientId,
      resourceId: planId,
      resourceType: 'AutomationPlan',
      outcome: 'ALLOWED',
      metadata: { planId, taskId: plan.taskId, clientId: plan.clientId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async cancelPlan(
    planId: string,
    cancelledByUserId: string,
    actorId: string,
  ): Promise<Result<SafeAutomationPlan, ErrorCode>> {
    const plan = await this.planRepo.findById(planId);
    if (!plan) return err('AUTOMATION_PLAN_NOT_FOUND', `AutomationPlan ${planId} not found`);

    if (!CANCELLABLE_PLAN_STATUSES.includes(plan.status as AutomationPlanStatus)) {
      return err('AUTOMATION_PLAN_INVALID_STATUS', `Cannot cancel plan with status "${plan.status}"`);
    }

    const now = new Date();
    const updated = await this.planRepo.update(planId, {
      status: 'CANCELLED',
      cancelledByUserId,
      cancelledAt: now,
    });

    const auditResult = await this.audit.write({
      eventType: 'AUTOMATION_PLAN_CANCELLED',
      actorId,
      actorType: 'OPERATOR',
      clientId: plan.clientId,
      resourceId: planId,
      resourceType: 'AutomationPlan',
      outcome: 'ALLOWED',
      metadata: { planId, taskId: plan.taskId, clientId: plan.clientId, cancelledByUserId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async getById(planId: string): Promise<Result<SafeAutomationPlan, ErrorCode>> {
    const plan = await this.planRepo.findById(planId);
    if (!plan) return err('AUTOMATION_PLAN_NOT_FOUND', `AutomationPlan ${planId} not found`);
    return ok(toSafe(plan));
  }

  async listForTask(taskId: string): Promise<SafeAutomationPlan[]> {
    const plans = await this.planRepo.listForTask(taskId);
    return plans.map(toSafe);
  }

  async listForClient(clientId: string): Promise<SafeAutomationPlan[]> {
    const plans = await this.planRepo.listForClient(clientId);
    return plans.map(toSafe);
  }
}
