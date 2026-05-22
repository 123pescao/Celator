import type { CleanupTaskRepository } from '@celator/db';
import type { CleanupTask, TaskStatus, RiskTier, MatchStatus, ActionType } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import { CleanupTaskStatusService } from '@celator/security/state-machine';
import type { AuditService } from './audit.service.js';
import type { CaseTimelineService } from './case-timeline.service.js';

export interface CreateTaskInput {
  caseId: string;
  sourceRef?: string;
  findingUrl?: string;
  actionType?: ActionType;
  riskTier?: RiskTier;
  matchStatus?: MatchStatus;
  preparedByUserId?: string;
}

export class CleanupTaskService {
  private readonly statusService = new CleanupTaskStatusService();

  constructor(
    private readonly repo: CleanupTaskRepository,
    private readonly audit: AuditService,
    private readonly timeline: CaseTimelineService,
  ) {}

  async create(input: CreateTaskInput, clientId: string, actorId: string): Promise<Result<CleanupTask, ErrorCode>> {
    const task = await this.repo.create({
      case: { connect: { id: input.caseId } },
      sourceRef: input.sourceRef ?? null,
      findingUrl: input.findingUrl ?? null,
      actionType: input.actionType ?? null,
      riskTier: input.riskTier ?? 'STANDARD',
      matchStatus: input.matchStatus ?? 'NEEDS_OPERATOR_REVIEW',
      preparedByUserId: input.preparedByUserId ?? null,
      status: 'FOUND',
    });

    const auditResult = await this.audit.write({
      eventType: 'TASK_CREATED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: task.id,
      resourceType: 'CleanupTask',
      outcome: 'ALLOWED',
      metadata: { sourceRef: input.sourceRef, riskTier: input.riskTier },
    });
    if (!auditResult.ok) return auditResult;

    await this.timeline.append({
      caseId: input.caseId,
      taskId: task.id,
      eventType: 'TASK_CREATED',
      toStatus: 'FOUND',
      actorId,
      actorType: 'OPERATOR',
    });

    return ok(task);
  }

  async getById(id: string): Promise<Result<CleanupTask, ErrorCode>> {
    const task = await this.repo.findById(id);
    if (!task) return err('NOT_FOUND', `Task ${id} not found`);
    return ok(task);
  }

  async listForCase(caseId: string, status?: TaskStatus): Promise<CleanupTask[]> {
    return this.repo.listForCase(caseId, status);
  }

  async transition(
    taskId: string,
    toStatus: TaskStatus,
    clientId: string,
    actorId: string,
    note?: string,
  ): Promise<Result<CleanupTask, ErrorCode>> {
    const task = await this.repo.findById(taskId);
    if (!task) return err('NOT_FOUND', `Task ${taskId} not found`);

    const allowed = this.statusService.isTransitionAllowed(task.status, toStatus);
    if (!allowed) {
      // BLOCKED audit — not fail-closed; transition is already denied
      await this.audit.write({
        eventType: 'TASK_TRANSITION_BLOCKED',
        actorId,
        actorType: 'OPERATOR',
        clientId,
        resourceId: taskId,
        resourceType: 'CleanupTask',
        outcome: 'BLOCKED',
        blockedBy: [`TRANSITION_${task.status}_to_${toStatus}_not_allowed`],
        metadata: { fromStatus: task.status, toStatus },
      });
      return err('TRANSITION_NOT_ALLOWED', `Transition from ${task.status} to ${toStatus} is not permitted`);
    }

    const updated = await this.repo.updateStatus(taskId, toStatus);

    const auditResult = await this.audit.write({
      eventType: 'TASK_STATUS_CHANGED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: taskId,
      resourceType: 'CleanupTask',
      outcome: 'ALLOWED',
      metadata: { fromStatus: task.status, toStatus, note },
    });
    if (!auditResult.ok) return auditResult;

    await this.timeline.append({
      caseId: task.caseId,
      taskId,
      eventType: 'TASK_STATUS_CHANGED',
      fromStatus: task.status,
      toStatus,
      actorId,
      actorType: 'OPERATOR',
      ...(note !== undefined ? { note } : {}),
    });

    return ok(updated);
  }

  async pauseTasksForRevocation(caseId: string, authorizationId: string, actorId: string): Promise<void> {
    const activeTasks = await this.repo.listForCase(caseId);
    const pausable: TaskStatus[] = [
      'FOUND', 'CLASSIFIED', 'READY_FOR_OPERATOR_REVIEW', 'OPERATOR_APPROVED',
      'READY_TO_SUBMIT', 'MATCH_REVIEW_REQUIRED', 'CLIENT_CONFIRMATION_REQUIRED',
    ];
    const toBlock = activeTasks.filter((t) => pausable.includes(t.status));

    for (const task of toBlock) {
      await this.repo.updateStatus(task.id, 'BLOCKED_CONSENT_SCOPE');
      await this.timeline.append({
        caseId,
        taskId: task.id,
        eventType: 'TASK_BLOCKED_CONSENT_REVOKED',
        fromStatus: task.status,
        toStatus: 'BLOCKED_CONSENT_SCOPE',
        actorId,
        actorType: 'SYSTEM',
        note: `Authorization ${authorizationId} was revoked`,
      });
    }
  }

  getAllowedTransitions(from: TaskStatus): TaskStatus[] {
    return this.statusService.getAllowedNextStatuses(from);
  }
}
