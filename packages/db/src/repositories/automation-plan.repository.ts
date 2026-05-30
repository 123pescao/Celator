import type { PrismaClient, AutomationPlan, AutomationPlanStatus, Prisma } from '../../generated/client/index.js';

export class AutomationPlanRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.AutomationPlanCreateInput): Promise<AutomationPlan> {
    return this.db.automationPlan.create({ data });
  }

  async findById(id: string): Promise<AutomationPlan | null> {
    return this.db.automationPlan.findUnique({ where: { id } });
  }

  async listForTask(taskId: string): Promise<AutomationPlan[]> {
    return this.db.automationPlan.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForClient(clientId: string): Promise<AutomationPlan[]> {
    return this.db.automationPlan.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listByStatus(status: AutomationPlanStatus): Promise<AutomationPlan[]> {
    return this.db.automationPlan.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, data: Prisma.AutomationPlanUpdateInput): Promise<AutomationPlan> {
    return this.db.automationPlan.update({ where: { id }, data });
  }
}

export type { AutomationPlan, AutomationPlanStatus };
