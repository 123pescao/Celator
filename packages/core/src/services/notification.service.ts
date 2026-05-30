import type { ScheduledNotificationRepository, NotificationStatus, ScheduledNotification, FollowUpReminderRepository, CleanupTaskRepository } from '@celator/db';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';

// ─── Terminal statuses ────────────────────────────────────────────────────────

const TERMINAL_NOTIFICATION_STATUSES: NotificationStatus[] = ['DELIVERED', 'FAILED', 'CANCELLED'];

// ─── Input / output types ─────────────────────────────────────────────────────

export interface ScheduleNotificationInput {
  clientId: string;
  caseId?: string;
  taskId?: string;
  followUpReminderId?: string;
  subjectSafe: string;
  bodySafe: string;
  scheduledFor: Date;
  createdByUserId?: string;
}

export interface SafeNotification {
  id: string;
  clientId: string;
  caseId: string | null;
  taskId: string | null;
  followUpReminderId: string | null;
  channel: string;
  status: string;
  subjectSafe: string;
  bodySafe: string;
  scheduledFor: Date;
  deliveredAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
  failureReason: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function toSafe(n: ScheduledNotification): SafeNotification {
  return {
    id: n.id,
    clientId: n.clientId,
    caseId: n.caseId,
    taskId: n.taskId,
    followUpReminderId: n.followUpReminderId,
    channel: n.channel,
    status: n.status,
    subjectSafe: n.subjectSafe,
    bodySafe: n.bodySafe,
    scheduledFor: n.scheduledFor,
    deliveredAt: n.deliveredAt,
    failedAt: n.failedAt,
    cancelledAt: n.cancelledAt,
    failureReason: n.failureReason,
    createdByUserId: n.createdByUserId,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class NotificationService {
  constructor(
    private readonly notificationRepo: ScheduledNotificationRepository,
    private readonly followUpRepo: FollowUpReminderRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly audit: AuditService,
  ) {}

  async schedule(
    input: ScheduleNotificationInput,
    actorId: string,
  ): Promise<Result<SafeNotification, ErrorCode>> {
    const subjectViolation = checkRedactedPreview(input.subjectSafe);
    if (subjectViolation) {
      return err('NOTIFICATION_SUBJECT_UNSAFE', `subjectSafe rejected: ${subjectViolation}`);
    }
    const bodyViolation = checkRedactedPreview(input.bodySafe);
    if (bodyViolation) {
      return err('NOTIFICATION_BODY_UNSAFE', `bodySafe rejected: ${bodyViolation}`);
    }

    if (input.followUpReminderId !== undefined) {
      const followUp = await this.followUpRepo.findById(input.followUpReminderId);
      if (!followUp) return err('FOLLOW_UP_NOT_FOUND', `FollowUpReminder ${input.followUpReminderId} not found`);
    }

    if (input.taskId !== undefined) {
      const task = await this.taskRepo.findById(input.taskId);
      if (!task) return err('NOT_FOUND', `Task ${input.taskId} not found`);
    }

    const notification = await this.notificationRepo.create({
      client: { connect: { id: input.clientId } },
      ...(input.caseId !== undefined ? { case: { connect: { id: input.caseId } } } : {}),
      ...(input.taskId !== undefined ? { task: { connect: { id: input.taskId } } } : {}),
      ...(input.followUpReminderId !== undefined ? { followUp: { connect: { id: input.followUpReminderId } } } : {}),
      channel: 'DRY_RUN',
      subjectSafe: input.subjectSafe,
      bodySafe: input.bodySafe,
      scheduledFor: input.scheduledFor,
      ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
    });

    // Audit metadata: IDs only — no text fields
    const auditResult = await this.audit.write({
      eventType: 'NOTIFICATION_SCHEDULED',
      actorId,
      actorType: 'OPERATOR',
      clientId: input.clientId,
      resourceId: notification.id,
      resourceType: 'ScheduledNotification',
      outcome: 'ALLOWED',
      metadata: {
        notificationId: notification.id,
        clientId: input.clientId,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.followUpReminderId !== undefined ? { followUpReminderId: input.followUpReminderId } : {}),
      },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(notification));
  }

  async markScheduled(
    notificationId: string,
    actorId: string,
  ): Promise<Result<SafeNotification, ErrorCode>> {
    const notification = await this.notificationRepo.findById(notificationId);
    if (!notification) return err('NOTIFICATION_NOT_FOUND', `Notification ${notificationId} not found`);

    if (notification.status !== 'PENDING') {
      return err('NOTIFICATION_INVALID_STATUS', `Cannot mark SCHEDULED from status "${notification.status}"`);
    }

    const updated = await this.notificationRepo.updateStatus(notificationId, 'SCHEDULED');

    const auditResult = await this.audit.write({
      eventType: 'NOTIFICATION_MARKED_SCHEDULED',
      actorId,
      actorType: 'OPERATOR',
      clientId: notification.clientId,
      resourceId: notificationId,
      resourceType: 'ScheduledNotification',
      outcome: 'ALLOWED',
      metadata: { notificationId, clientId: notification.clientId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async deliverDryRun(
    notificationId: string,
    actorId: string,
  ): Promise<Result<SafeNotification, ErrorCode>> {
    const notification = await this.notificationRepo.findById(notificationId);
    if (!notification) return err('NOTIFICATION_NOT_FOUND', `Notification ${notificationId} not found`);

    if (notification.status !== 'SCHEDULED') {
      return err('NOTIFICATION_INVALID_STATUS', `Cannot deliver from status "${notification.status}" — must be SCHEDULED`);
    }

    const now = new Date();
    // DRY_RUN: no real dispatch — mark as DELIVERED immediately
    const updated = await this.notificationRepo.updateStatus(notificationId, 'DELIVERED', { deliveredAt: now });

    const auditResult = await this.audit.write({
      eventType: 'NOTIFICATION_DRY_RUN_DELIVERED',
      actorId,
      actorType: 'OPERATOR',
      clientId: notification.clientId,
      resourceId: notificationId,
      resourceType: 'ScheduledNotification',
      outcome: 'ALLOWED',
      metadata: { notificationId, clientId: notification.clientId, channel: 'DRY_RUN' },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async markFailed(
    notificationId: string,
    failureReason: string,
    actorId: string,
  ): Promise<Result<SafeNotification, ErrorCode>> {
    const notification = await this.notificationRepo.findById(notificationId);
    if (!notification) return err('NOTIFICATION_NOT_FOUND', `Notification ${notificationId} not found`);

    if (TERMINAL_NOTIFICATION_STATUSES.includes(notification.status as NotificationStatus)) {
      return err('NOTIFICATION_INVALID_STATUS', `Cannot mark FAILED from terminal status "${notification.status}"`);
    }

    const reasonViolation = checkRedactedPreview(failureReason);
    if (reasonViolation) {
      return err('NOTIFICATION_BODY_UNSAFE', `failureReason rejected: ${reasonViolation}`);
    }

    const now = new Date();
    const updated = await this.notificationRepo.updateStatus(notificationId, 'FAILED', {
      failedAt: now,
      failureReason,
    });

    const auditResult = await this.audit.write({
      eventType: 'NOTIFICATION_FAILED',
      actorId,
      actorType: 'OPERATOR',
      clientId: notification.clientId,
      resourceId: notificationId,
      resourceType: 'ScheduledNotification',
      outcome: 'BLOCKED',
      metadata: { notificationId, clientId: notification.clientId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async cancel(
    notificationId: string,
    actorId: string,
  ): Promise<Result<SafeNotification, ErrorCode>> {
    const notification = await this.notificationRepo.findById(notificationId);
    if (!notification) return err('NOTIFICATION_NOT_FOUND', `Notification ${notificationId} not found`);

    const status = notification.status as NotificationStatus;
    if (status !== 'PENDING' && status !== 'SCHEDULED') {
      return err('NOTIFICATION_INVALID_STATUS', `Cannot cancel from status "${notification.status}"`);
    }

    const now = new Date();
    const updated = await this.notificationRepo.updateStatus(notificationId, 'CANCELLED', { cancelledAt: now });

    const auditResult = await this.audit.write({
      eventType: 'NOTIFICATION_CANCELLED',
      actorId,
      actorType: 'OPERATOR',
      clientId: notification.clientId,
      resourceId: notificationId,
      resourceType: 'ScheduledNotification',
      outcome: 'ALLOWED',
      metadata: { notificationId, clientId: notification.clientId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async scheduleForOverdueReminder(
    followUpReminderId: string,
    subjectSafe: string,
    bodySafe: string,
    scheduledFor: Date,
    actorId: string,
  ): Promise<Result<SafeNotification, ErrorCode>> {
    const followUp = await this.followUpRepo.findById(followUpReminderId);
    if (!followUp) return err('FOLLOW_UP_NOT_FOUND', `FollowUpReminder ${followUpReminderId} not found`);

    return this.schedule(
      {
        clientId: followUp.clientId,
        taskId: followUp.taskId,
        followUpReminderId,
        subjectSafe,
        bodySafe,
        scheduledFor,
      },
      actorId,
    );
  }

  async listForClient(clientId: string): Promise<SafeNotification[]> {
    const records = await this.notificationRepo.listForClient(clientId);
    return records.map(toSafe);
  }

  async listForTask(taskId: string): Promise<SafeNotification[]> {
    const records = await this.notificationRepo.listForTask(taskId);
    return records.map(toSafe);
  }

  async listDueAsOf(asOf: Date): Promise<SafeNotification[]> {
    const records = await this.notificationRepo.listDueAsOf(asOf);
    return records.map(toSafe);
  }
}
