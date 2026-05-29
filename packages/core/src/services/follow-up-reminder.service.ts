import type { FollowUpReminderRepository, FollowUpStatus, CleanupTaskRepository } from '@celator/db';
import type { FollowUpReminder } from '@celator/db';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { CaseTimelineService } from './case-timeline.service.js';

// ─── Terminal follow-up statuses ──────────────────────────────────────────────
const TERMINAL_FOLLOW_UP_STATUSES: FollowUpStatus[] = ['COMPLETED', 'CANCELLED'];

// ─── Input/output types ───────────────────────────────────────────────────────

export interface CreateFollowUpInput {
  taskId: string;
  clientId: string;
  dueAt: Date;
  safeNote?: string;
  createdByUserId?: string;
}

export interface SafeFollowUp {
  id: string;
  taskId: string;
  clientId: string;
  status: string;
  dueAt: Date;
  safeNote: string | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function toSafe(f: FollowUpReminder): SafeFollowUp {
  return {
    id: f.id,
    taskId: f.taskId,
    clientId: f.clientId,
    status: f.status,
    dueAt: f.dueAt,
    safeNote: f.safeNote,
    completedAt: f.completedAt,
    cancelledAt: f.cancelledAt,
    createdByUserId: f.createdByUserId,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class FollowUpReminderService {
  constructor(
    private readonly followUpRepo: FollowUpReminderRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly audit: AuditService,
    private readonly timeline: CaseTimelineService,
  ) {}

  async create(
    input: CreateFollowUpInput,
    actorId: string,
  ): Promise<Result<SafeFollowUp, ErrorCode>> {
    if (input.safeNote !== undefined) {
      const v = checkRedactedPreview(input.safeNote);
      if (v) return err('WORKFLOW_UNSAFE_TEXT', `safeNote rejected: ${v}`);
    }

    const task = await this.taskRepo.findById(input.taskId);
    if (!task) return err('NOT_FOUND', `Task ${input.taskId} not found`);

    const followUp = await this.followUpRepo.create({
      task: { connect: { id: input.taskId } },
      client: { connect: { id: input.clientId } },
      dueAt: input.dueAt,
      ...(input.safeNote !== undefined ? { safeNote: input.safeNote } : {}),
      ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
    });

    // Audit metadata must NOT include dueAt — ISO date matches DOB pattern in checkAuditMetadata
    const auditResult = await this.audit.write({
      eventType: 'FOLLOW_UP_SCHEDULED',
      actorId,
      actorType: 'OPERATOR',
      clientId: input.clientId,
      resourceId: followUp.id,
      resourceType: 'FollowUpReminder',
      outcome: 'ALLOWED',
      metadata: { taskId: input.taskId, followUpId: followUp.id },
    });
    if (!auditResult.ok) return auditResult;

    await this.timeline.append({
      caseId: task.caseId,
      taskId: input.taskId,
      eventType: 'FOLLOW_UP_SCHEDULED',
      actorId,
      actorType: 'OPERATOR',
      note: 'Follow-up scheduled',
    });

    return ok(toSafe(followUp));
  }

  async complete(
    followUpId: string,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafeFollowUp, ErrorCode>> {
    const followUp = await this.followUpRepo.findById(followUpId);
    if (!followUp) return err('FOLLOW_UP_NOT_FOUND', `Follow-up ${followUpId} not found`);

    if (followUp.clientId !== clientId) {
      return err('FORBIDDEN', 'Access denied — follow-up belongs to a different client');
    }

    if (TERMINAL_FOLLOW_UP_STATUSES.includes(followUp.status)) {
      return err('FOLLOW_UP_INVALID_STATUS', `Cannot complete a follow-up in terminal status "${followUp.status}"`);
    }

    const now = new Date();
    const updated = await this.followUpRepo.updateStatus(followUpId, 'COMPLETED', { completedAt: now });

    const task = await this.taskRepo.findById(followUp.taskId);

    const auditResult = await this.audit.write({
      eventType: 'FOLLOW_UP_COMPLETED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: followUpId,
      resourceType: 'FollowUpReminder',
      outcome: 'ALLOWED',
      metadata: { taskId: followUp.taskId, followUpId },
    });
    if (!auditResult.ok) return auditResult;

    if (task) {
      await this.timeline.append({
        caseId: task.caseId,
        taskId: followUp.taskId,
        eventType: 'FOLLOW_UP_COMPLETED',
        actorId,
        actorType: 'OPERATOR',
        note: 'Follow-up completed',
      });
    }

    return ok(toSafe(updated));
  }

  async cancel(
    followUpId: string,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafeFollowUp, ErrorCode>> {
    const followUp = await this.followUpRepo.findById(followUpId);
    if (!followUp) return err('FOLLOW_UP_NOT_FOUND', `Follow-up ${followUpId} not found`);

    if (followUp.clientId !== clientId) {
      return err('FORBIDDEN', 'Access denied — follow-up belongs to a different client');
    }

    if (TERMINAL_FOLLOW_UP_STATUSES.includes(followUp.status)) {
      return err('FOLLOW_UP_INVALID_STATUS', `Cannot cancel a follow-up in terminal status "${followUp.status}"`);
    }

    const now = new Date();
    const updated = await this.followUpRepo.updateStatus(followUpId, 'CANCELLED', { cancelledAt: now });

    const auditResult = await this.audit.write({
      eventType: 'FOLLOW_UP_CANCELLED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: followUpId,
      resourceType: 'FollowUpReminder',
      outcome: 'ALLOWED',
      metadata: { taskId: followUp.taskId, followUpId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async getById(followUpId: string): Promise<Result<SafeFollowUp, ErrorCode>> {
    const followUp = await this.followUpRepo.findById(followUpId);
    if (!followUp) return err('FOLLOW_UP_NOT_FOUND', `Follow-up ${followUpId} not found`);
    return ok(toSafe(followUp));
  }

  async listForTask(taskId: string): Promise<SafeFollowUp[]> {
    const followUps = await this.followUpRepo.listForTask(taskId);
    return followUps.map(toSafe);
  }

  async listForClient(clientId: string): Promise<SafeFollowUp[]> {
    const followUps = await this.followUpRepo.listForClient(clientId);
    return followUps.map(toSafe);
  }

  async listDueAsOf(asOf: Date, clientId: string): Promise<SafeFollowUp[]> {
    const followUps = await this.followUpRepo.listDueAsOf(asOf, clientId);
    return followUps.map(toSafe);
  }
}
