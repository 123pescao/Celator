import type { PrismaClient, AuditLog, Prisma } from '../../generated/client/index.js';

export class AuditLogRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.AuditLogCreateInput): Promise<AuditLog> {
    return this.db.auditLog.create({ data });
  }

  async listByClient(clientId: string, limit = 100): Promise<AuditLog[]> {
    return this.db.auditLog.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async listByActor(actorId: string, limit = 100): Promise<AuditLog[]> {
    return this.db.auditLog.findMany({
      where: { actorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async listByResource(resourceId: string, resourceType?: string): Promise<AuditLog[]> {
    return this.db.auditLog.findMany({
      where: { resourceId, ...(resourceType ? { resourceType } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listByEventType(eventType: string, since?: Date, limit = 200): Promise<AuditLog[]> {
    return this.db.auditLog.findMany({
      where: { eventType, ...(since ? { createdAt: { gte: since } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
