import type { PrismaClient, CleanupTask, TaskStatus, Prisma } from '../../generated/client/index.js';

export class CleanupTaskRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.CleanupTaskCreateInput): Promise<CleanupTask> {
    return this.db.cleanupTask.create({ data });
  }

  async findById(id: string): Promise<CleanupTask | null> {
    return this.db.cleanupTask.findUnique({ where: { id } });
  }

  async listForCase(caseId: string, status?: TaskStatus): Promise<CleanupTask[]> {
    return this.db.cleanupTask.findMany({
      where: { caseId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateStatus(id: string, status: TaskStatus): Promise<CleanupTask> {
    return this.db.cleanupTask.update({ where: { id }, data: { status } });
  }

  async update(id: string, data: Prisma.CleanupTaskUpdateInput): Promise<CleanupTask> {
    return this.db.cleanupTask.update({ where: { id }, data });
  }

  async bulkUpdateStatus(caseId: string, fromStatuses: TaskStatus[], toStatus: TaskStatus): Promise<number> {
    const result = await this.db.cleanupTask.updateMany({
      where: { caseId, status: { in: fromStatuses } },
      data: { status: toStatus },
    });
    return result.count;
  }

  async listForClientId(clientId: string, status?: TaskStatus): Promise<CleanupTask[]> {
    return this.db.cleanupTask.findMany({
      where: { case: { is: { clientId } }, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }
}
