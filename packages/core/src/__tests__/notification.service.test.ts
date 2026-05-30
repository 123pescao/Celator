import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../services/notification.service.js';
import type { ScheduledNotificationRepository, FollowUpReminderRepository, CleanupTaskRepository } from '@celator/db';
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

const FAKE_FOLLOW_UP = {
  id: 'fu_001',
  taskId: 'task_001',
  clientId: 'client_001',
  status: 'PENDING' as const,
  dueAt: new Date(Date.now() - 1000 * 60 * 60),
  safeNote: null,
  completedAt: null,
  cancelledAt: null,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_NOTIFICATION = {
  id: 'notif_001',
  clientId: 'client_001',
  caseId: null,
  taskId: 'task_001',
  followUpReminderId: null,
  channel: 'DRY_RUN' as const,
  status: 'PENDING' as const,
  subjectSafe: 'Reminder: your request is pending review',
  bodySafe: 'Your cleanup request has been queued for review.',
  scheduledFor: new Date(Date.now() + 86400000),
  deliveredAt: null,
  failedAt: null,
  cancelledAt: null,
  failureReason: null,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeNotifRepo(overrides?: Partial<ScheduledNotificationRepository>): ScheduledNotificationRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_NOTIFICATION),
    findById: vi.fn().mockResolvedValue(FAKE_NOTIFICATION),
    listForClient: vi.fn().mockResolvedValue([FAKE_NOTIFICATION]),
    listForTask: vi.fn().mockResolvedValue([FAKE_NOTIFICATION]),
    listForFollowUp: vi.fn().mockResolvedValue([]),
    listDueAsOf: vi.fn().mockResolvedValue([FAKE_NOTIFICATION]),
    updateStatus: vi.fn().mockResolvedValue({ ...FAKE_NOTIFICATION, status: 'SCHEDULED' }),
    ...overrides,
  } as unknown as ScheduledNotificationRepository;
}

function makeFollowUpRepo(): FollowUpReminderRepository {
  return {
    findById: vi.fn().mockResolvedValue(FAKE_FOLLOW_UP),
    create: vi.fn(),
    listForTask: vi.fn(),
    listForClient: vi.fn(),
    listDueAsOf: vi.fn(),
    updateStatus: vi.fn(),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NotificationService', () => {
  let notifRepo: ScheduledNotificationRepository;
  let followUpRepo: FollowUpReminderRepository;
  let taskRepo: CleanupTaskRepository;
  let audit: AuditService;
  let svc: NotificationService;

  beforeEach(() => {
    notifRepo = makeNotifRepo();
    followUpRepo = makeFollowUpRepo();
    taskRepo = makeTaskRepo();
    audit = makeAudit();
    svc = new NotificationService(notifRepo, followUpRepo, taskRepo, audit);
  });

  describe('schedule', () => {
    it('creates notification with PENDING status and DRY_RUN channel', async () => {
      const result = await svc.schedule(
        { clientId: 'client_001', taskId: 'task_001', subjectSafe: 'Review pending', bodySafe: 'Your request is under review.', scheduledFor: new Date() },
        'actor_001',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('PENDING');
      expect(result.value.channel).toBe('DRY_RUN');
    });

    it('returns NOTIFICATION_SUBJECT_UNSAFE when subjectSafe contains raw email', async () => {
      const result = await svc.schedule(
        { clientId: 'client_001', subjectSafe: 'Contact admin@example.com', bodySafe: 'Safe body.', scheduledFor: new Date() },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOTIFICATION_SUBJECT_UNSAFE');
      expect(notifRepo.create).not.toHaveBeenCalled();
    });

    it('returns NOTIFICATION_BODY_UNSAFE when bodySafe contains raw phone number', async () => {
      const result = await svc.schedule(
        { clientId: 'client_001', subjectSafe: 'Safe subject', bodySafe: 'Call 555-123-4567 for info.', scheduledFor: new Date() },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOTIFICATION_BODY_UNSAFE');
      expect(notifRepo.create).not.toHaveBeenCalled();
    });

    it('returns FOLLOW_UP_NOT_FOUND when followUpReminderId points to missing record', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.schedule(
        { clientId: 'client_001', followUpReminderId: 'fu_missing', subjectSafe: 'Safe', bodySafe: 'Safe.', scheduledFor: new Date() },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FOLLOW_UP_NOT_FOUND');
    });

    it('returns NOT_FOUND when taskId points to missing task', async () => {
      vi.mocked(taskRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.schedule(
        { clientId: 'client_001', taskId: 'task_missing', subjectSafe: 'Safe', bodySafe: 'Safe.', scheduledFor: new Date() },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });

    it('writes NOTIFICATION_SCHEDULED audit event with IDs only — no text in metadata', async () => {
      await svc.schedule(
        { clientId: 'client_001', taskId: 'task_001', subjectSafe: 'Safe subject', bodySafe: 'Safe body.', scheduledFor: new Date() },
        'actor_001',
      );
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'NOTIFICATION_SCHEDULED' }));
      const call = vi.mocked(audit.write).mock.calls[0]![0];
      const meta = JSON.stringify(call.metadata);
      expect(meta).not.toContain('Safe subject');
      expect(meta).not.toContain('Safe body');
    });

    it('fails closed when audit.write returns an error', async () => {
      vi.mocked(audit.write).mockResolvedValueOnce({ ok: false, error: 'AUDIT_LOG_FAILED', message: 'DB down' });
      const result = await svc.schedule(
        { clientId: 'client_001', subjectSafe: 'Safe', bodySafe: 'Safe.', scheduledFor: new Date() },
        'actor_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });
  });

  describe('markScheduled', () => {
    it('transitions PENDING to SCHEDULED', async () => {
      vi.mocked(notifRepo.updateStatus).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'SCHEDULED' as const });
      const result = await svc.markScheduled('notif_001', 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(notifRepo.updateStatus).toHaveBeenCalledWith('notif_001', 'SCHEDULED');
    });

    it('returns NOTIFICATION_NOT_FOUND when notification does not exist', async () => {
      vi.mocked(notifRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.markScheduled('notif_missing', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOTIFICATION_NOT_FOUND');
    });

    it('returns NOTIFICATION_INVALID_STATUS when status is not PENDING', async () => {
      vi.mocked(notifRepo.findById).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'DELIVERED' as const });
      const result = await svc.markScheduled('notif_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOTIFICATION_INVALID_STATUS');
    });
  });

  describe('deliverDryRun', () => {
    it('transitions SCHEDULED to DELIVERED and sets deliveredAt', async () => {
      vi.mocked(notifRepo.findById).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'SCHEDULED' as const });
      vi.mocked(notifRepo.updateStatus).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'DELIVERED' as const, deliveredAt: new Date() });
      const result = await svc.deliverDryRun('notif_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(notifRepo.updateStatus).toHaveBeenCalledWith('notif_001', 'DELIVERED', expect.objectContaining({ deliveredAt: expect.any(Date) }));
    });

    it('returns NOTIFICATION_INVALID_STATUS when status is not SCHEDULED', async () => {
      vi.mocked(notifRepo.findById).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'PENDING' as const });
      const result = await svc.deliverDryRun('notif_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOTIFICATION_INVALID_STATUS');
    });

    it('writes NOTIFICATION_DRY_RUN_DELIVERED audit event', async () => {
      vi.mocked(notifRepo.findById).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'SCHEDULED' as const });
      vi.mocked(notifRepo.updateStatus).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'DELIVERED' as const, deliveredAt: new Date() });
      await svc.deliverDryRun('notif_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'NOTIFICATION_DRY_RUN_DELIVERED' }));
    });
  });

  describe('markFailed', () => {
    it('transitions PENDING to FAILED with failureReason', async () => {
      vi.mocked(notifRepo.updateStatus).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'FAILED' as const, failedAt: new Date(), failureReason: 'Channel unavailable' });
      const result = await svc.markFailed('notif_001', 'Channel unavailable', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('returns NOTIFICATION_INVALID_STATUS when notification is already in terminal state', async () => {
      vi.mocked(notifRepo.findById).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'DELIVERED' as const });
      const result = await svc.markFailed('notif_001', 'Too late', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOTIFICATION_INVALID_STATUS');
    });

    it('returns NOTIFICATION_BODY_UNSAFE when failureReason contains PII', async () => {
      const result = await svc.markFailed('notif_001', 'Failed for user@example.com', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOTIFICATION_BODY_UNSAFE');
    });
  });

  describe('cancel', () => {
    it('transitions PENDING to CANCELLED and sets cancelledAt', async () => {
      vi.mocked(notifRepo.updateStatus).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'CANCELLED' as const, cancelledAt: new Date() });
      const result = await svc.cancel('notif_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(notifRepo.updateStatus).toHaveBeenCalledWith('notif_001', 'CANCELLED', expect.objectContaining({ cancelledAt: expect.any(Date) }));
    });

    it('transitions SCHEDULED to CANCELLED', async () => {
      vi.mocked(notifRepo.findById).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'SCHEDULED' as const });
      vi.mocked(notifRepo.updateStatus).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'CANCELLED' as const, cancelledAt: new Date() });
      const result = await svc.cancel('notif_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('returns NOTIFICATION_INVALID_STATUS when notification is already DELIVERED', async () => {
      vi.mocked(notifRepo.findById).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'DELIVERED' as const });
      const result = await svc.cancel('notif_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOTIFICATION_INVALID_STATUS');
    });

    it('returns NOTIFICATION_INVALID_STATUS when notification is already CANCELLED', async () => {
      vi.mocked(notifRepo.findById).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, status: 'CANCELLED' as const });
      const result = await svc.cancel('notif_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOTIFICATION_INVALID_STATUS');
    });
  });

  describe('scheduleForOverdueReminder', () => {
    it('loads reminder and delegates to schedule() with correct clientId and taskId', async () => {
      vi.mocked(notifRepo.create).mockResolvedValueOnce({ ...FAKE_NOTIFICATION, followUpReminderId: 'fu_001' });
      const result = await svc.scheduleForOverdueReminder('fu_001', 'Reminder', 'Your follow-up is overdue.', new Date(), 'actor_001');
      expect(result.ok).toBe(true);
      const createCall = vi.mocked(notifRepo.create).mock.calls[0]![0];
      expect(createCall).toMatchObject(
        expect.objectContaining({ client: { connect: { id: 'client_001' } } }),
      );
    });

    it('returns FOLLOW_UP_NOT_FOUND when reminder does not exist', async () => {
      vi.mocked(followUpRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.scheduleForOverdueReminder('fu_missing', 'Subject', 'Body.', new Date(), 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FOLLOW_UP_NOT_FOUND');
    });
  });

  describe('listForClient', () => {
    it('returns array of SafeNotification for the given clientId', async () => {
      const result = await svc.listForClient('client_001');
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]!.clientId).toBe('client_001');
    });

    it('returns empty array when client has no notifications', async () => {
      vi.mocked(notifRepo.listForClient).mockResolvedValueOnce([]);
      const result = await svc.listForClient('client_001');
      expect(result).toEqual([]);
    });
  });

  describe('listDueAsOf', () => {
    it('returns pending notifications due by the given date', async () => {
      const asOf = new Date();
      await svc.listDueAsOf(asOf);
      expect(notifRepo.listDueAsOf).toHaveBeenCalledWith(asOf);
    });

    it('response does not include vault or cipher fields', async () => {
      const result = await svc.listDueAsOf(new Date());
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
      expect(json).not.toContain('storageKey');
    });
  });
});
