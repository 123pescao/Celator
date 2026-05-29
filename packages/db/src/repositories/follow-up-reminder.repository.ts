import type { PrismaClient, FollowUpReminder, FollowUpStatus, Prisma } from '../../generated/client/index.js';

export class FollowUpReminderRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.FollowUpReminderCreateInput): Promise<FollowUpReminder> {
    return this.db.followUpReminder.create({ data });
  }

  async findById(id: string): Promise<FollowUpReminder | null> {
    return this.db.followUpReminder.findUnique({ where: { id } });
  }

  async listForTask(taskId: string): Promise<FollowUpReminder[]> {
    return this.db.followUpReminder.findMany({
      where: { taskId },
      orderBy: { dueAt: 'asc' },
    });
  }

  async listForClient(clientId: string): Promise<FollowUpReminder[]> {
    return this.db.followUpReminder.findMany({
      where: { clientId },
      orderBy: { dueAt: 'asc' },
    });
  }

  async listDueAsOf(asOf: Date, clientId: string): Promise<FollowUpReminder[]> {
    return this.db.followUpReminder.findMany({
      where: {
        clientId,
        status: 'PENDING',
        dueAt: { lte: asOf },
      },
      orderBy: { dueAt: 'asc' },
    });
  }

  async updateStatus(
    id: string,
    status: FollowUpStatus,
    extra?: { completedAt?: Date; cancelledAt?: Date },
  ): Promise<FollowUpReminder> {
    return this.db.followUpReminder.update({
      where: { id },
      data: {
        status,
        ...(extra?.completedAt !== undefined ? { completedAt: extra.completedAt } : {}),
        ...(extra?.cancelledAt !== undefined ? { cancelledAt: extra.cancelledAt } : {}),
      },
    });
  }
}

export type { FollowUpReminder, FollowUpStatus };
