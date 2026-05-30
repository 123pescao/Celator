import type { PrismaClient, ScheduledNotification, NotificationStatus, NotificationChannel, Prisma } from '../../generated/client/index.js';

export class ScheduledNotificationRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.ScheduledNotificationCreateInput): Promise<ScheduledNotification> {
    return this.db.scheduledNotification.create({ data });
  }

  async findById(id: string): Promise<ScheduledNotification | null> {
    return this.db.scheduledNotification.findUnique({ where: { id } });
  }

  async listForClient(clientId: string): Promise<ScheduledNotification[]> {
    return this.db.scheduledNotification.findMany({
      where: { clientId },
      orderBy: { scheduledFor: 'asc' },
    });
  }

  async listForTask(taskId: string): Promise<ScheduledNotification[]> {
    return this.db.scheduledNotification.findMany({
      where: { taskId },
      orderBy: { scheduledFor: 'asc' },
    });
  }

  async listForFollowUp(followUpReminderId: string): Promise<ScheduledNotification[]> {
    return this.db.scheduledNotification.findMany({
      where: { followUpReminderId },
      orderBy: { scheduledFor: 'asc' },
    });
  }

  async listDueAsOf(asOf: Date): Promise<ScheduledNotification[]> {
    return this.db.scheduledNotification.findMany({
      where: {
        status: 'PENDING',
        scheduledFor: { lte: asOf },
      },
      orderBy: { scheduledFor: 'asc' },
    });
  }

  async updateStatus(
    id: string,
    status: NotificationStatus,
    extra?: {
      deliveredAt?: Date;
      failedAt?: Date;
      cancelledAt?: Date;
      failureReason?: string;
    },
  ): Promise<ScheduledNotification> {
    return this.db.scheduledNotification.update({
      where: { id },
      data: {
        status,
        ...(extra?.deliveredAt !== undefined ? { deliveredAt: extra.deliveredAt } : {}),
        ...(extra?.failedAt !== undefined ? { failedAt: extra.failedAt } : {}),
        ...(extra?.cancelledAt !== undefined ? { cancelledAt: extra.cancelledAt } : {}),
        ...(extra?.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
      },
    });
  }
}

export type { ScheduledNotification, NotificationStatus, NotificationChannel };
