import type { PrismaClient, EvidenceRecord, Prisma } from '../../generated/client/index.js';

export class EvidenceRecordRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.EvidenceRecordCreateInput): Promise<EvidenceRecord> {
    return this.db.evidenceRecord.create({ data });
  }

  async findById(id: string): Promise<EvidenceRecord | null> {
    return this.db.evidenceRecord.findUnique({ where: { id } });
  }

  async listForTask(taskId: string): Promise<EvidenceRecord[]> {
    return this.db.evidenceRecord.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findManyByIds(ids: string[]): Promise<EvidenceRecord[]> {
    return this.db.evidenceRecord.findMany({ where: { id: { in: ids } } });
  }

  async listForTaskScoped(taskId: string, clientId: string): Promise<EvidenceRecord[]> {
    return this.db.evidenceRecord.findMany({
      where: { taskId, clientId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async markImmutable(id: string): Promise<EvidenceRecord> {
    return this.db.evidenceRecord.update({ where: { id }, data: { isImmutable: true } });
  }
}
