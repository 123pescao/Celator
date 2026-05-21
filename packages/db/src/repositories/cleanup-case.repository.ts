import type { PrismaClient, CleanupCase, Prisma } from '../../generated/client/index.js';

export class CleanupCaseRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.CleanupCaseCreateInput): Promise<CleanupCase> {
    return this.db.cleanupCase.create({ data });
  }

  async findById(id: string): Promise<CleanupCase | null> {
    return this.db.cleanupCase.findUnique({ where: { id } });
  }

  async listForClient(clientId: string, includeClosed = false): Promise<CleanupCase[]> {
    return this.db.cleanupCase.findMany({
      where: { clientId, ...(includeClosed ? {} : { closedAt: null }) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async close(id: string, closedAt: Date): Promise<CleanupCase> {
    return this.db.cleanupCase.update({ where: { id }, data: { closedAt } });
  }

  async update(id: string, data: Prisma.CleanupCaseUpdateInput): Promise<CleanupCase> {
    return this.db.cleanupCase.update({ where: { id }, data });
  }
}
