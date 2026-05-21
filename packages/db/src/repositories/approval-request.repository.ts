import type {
  PrismaClient,
  ApprovalRequest,
  ApprovalRequestStatus,
  Prisma,
} from '../../generated/client/index.js';

export class ApprovalRequestRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.ApprovalRequestCreateInput): Promise<ApprovalRequest> {
    return this.db.approvalRequest.create({ data });
  }

  async findById(id: string): Promise<ApprovalRequest | null> {
    return this.db.approvalRequest.findUnique({ where: { id } });
  }

  async findPendingForTask(taskId: string): Promise<ApprovalRequest | null> {
    return this.db.approvalRequest.findFirst({
      where: { taskId, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForTask(taskId: string): Promise<ApprovalRequest[]> {
    return this.db.approvalRequest.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, status: ApprovalRequestStatus): Promise<ApprovalRequest> {
    return this.db.approvalRequest.update({ where: { id }, data: { status } });
  }

  async cancelPendingForTask(taskId: string): Promise<number> {
    const result = await this.db.approvalRequest.updateMany({
      where: { taskId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    return result.count;
  }
}
