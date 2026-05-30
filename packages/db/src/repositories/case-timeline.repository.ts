import type { PrismaClient, CaseTimelineEvent, Prisma } from '../../generated/client/index.js';

export class CaseTimelineRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.CaseTimelineEventCreateInput): Promise<CaseTimelineEvent> {
    return this.db.caseTimelineEvent.create({ data });
  }

  async listForCase(caseId: string): Promise<CaseTimelineEvent[]> {
    return this.db.caseTimelineEvent.findMany({
      where: { caseId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listForTask(taskId: string): Promise<CaseTimelineEvent[]> {
    return this.db.caseTimelineEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listRecentForClient(clientId: string, limit: number): Promise<CaseTimelineEvent[]> {
    return this.db.caseTimelineEvent.findMany({
      where: { case: { is: { clientId } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
