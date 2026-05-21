import type { PrismaClient, OperatorApproval, Prisma } from '../../generated/client/index.js';

export class OperatorApprovalRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.OperatorApprovalCreateInput): Promise<OperatorApproval> {
    return this.db.operatorApproval.create({ data });
  }

  async findById(id: string): Promise<OperatorApproval | null> {
    return this.db.operatorApproval.findUnique({ where: { id } });
  }

  async findByApprovalRequest(approvalRequestId: string): Promise<OperatorApproval | null> {
    return this.db.operatorApproval.findUnique({ where: { approvalRequestId } });
  }

  async countByOperatorInWindow(operatorId: string, since: Date): Promise<number> {
    return this.db.operatorApproval.count({
      where: { operatorId, approvedAt: { gte: since } },
    });
  }

  async listByOperator(operatorId: string, limit = 50): Promise<OperatorApproval[]> {
    return this.db.operatorApproval.findMany({
      where: { operatorId },
      orderBy: { approvedAt: 'desc' },
      take: limit,
    });
  }
}
