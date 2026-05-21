import type {
  PrismaClient,
  ApprovalPayloadSnapshot,
  SnapshotStatus,
  Prisma,
} from '../../generated/client/index.js';

export class ApprovalPayloadSnapshotRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.ApprovalPayloadSnapshotCreateInput): Promise<ApprovalPayloadSnapshot> {
    return this.db.approvalPayloadSnapshot.create({ data });
  }

  async findById(id: string): Promise<ApprovalPayloadSnapshot | null> {
    return this.db.approvalPayloadSnapshot.findUnique({ where: { id } });
  }

  async findActiveForTask(taskId: string): Promise<ApprovalPayloadSnapshot | null> {
    return this.db.approvalPayloadSnapshot.findFirst({
      where: { taskId, snapshotStatus: 'ACTIVE', snapshotExpiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, snapshotStatus: SnapshotStatus, invalidationReason?: string): Promise<ApprovalPayloadSnapshot> {
    return this.db.approvalPayloadSnapshot.update({
      where: { id },
      data: { snapshotStatus, ...(invalidationReason ? { invalidationReason } : {}) },
    });
  }

  async invalidateForTask(taskId: string, reason: string): Promise<number> {
    const result = await this.db.approvalPayloadSnapshot.updateMany({
      where: { taskId, snapshotStatus: 'ACTIVE' },
      data: { snapshotStatus: 'INVALIDATED', invalidationReason: reason },
    });
    return result.count;
  }
}
