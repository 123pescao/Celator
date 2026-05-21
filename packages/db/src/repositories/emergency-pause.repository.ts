import type {
  PrismaClient,
  EmergencyPauseEvent,
  EmergencyPauseScope,
  Prisma,
} from '../../generated/client/index.js';

export class EmergencyPauseRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.EmergencyPauseEventCreateInput): Promise<EmergencyPauseEvent> {
    return this.db.emergencyPauseEvent.create({ data });
  }

  async findById(id: string): Promise<EmergencyPauseEvent | null> {
    return this.db.emergencyPauseEvent.findUnique({ where: { id } });
  }

  async findActiveGlobal(): Promise<EmergencyPauseEvent | null> {
    return this.db.emergencyPauseEvent.findFirst({
      where: { scope: 'GLOBAL', status: 'ACTIVE' },
      orderBy: { triggeredAt: 'desc' },
    });
  }

  async findActiveForScope(scope: EmergencyPauseScope, scopeRef?: string): Promise<EmergencyPauseEvent | null> {
    return this.db.emergencyPauseEvent.findFirst({
      where: { scope, scopeRef: scopeRef ?? null, status: 'ACTIVE' },
      orderBy: { triggeredAt: 'desc' },
    });
  }

  async listActive(): Promise<EmergencyPauseEvent[]> {
    return this.db.emergencyPauseEvent.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { triggeredAt: 'desc' },
    });
  }

  async resolve(
    id: string,
    resolvedBy: string,
    resolutionSummary: string,
    resolvedAt: Date,
  ): Promise<EmergencyPauseEvent> {
    return this.db.emergencyPauseEvent.update({
      where: { id },
      data: { status: 'RESOLVED', resolvedBy, resolutionSummary, resolvedAt },
    });
  }
}
