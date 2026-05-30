import type {
  PrismaClient,
  ClientIntakeSession,
  ClientIntakeStatus,
  Prisma,
} from '../../generated/client/index.js';

export class ClientIntakeSessionRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.ClientIntakeSessionCreateInput): Promise<ClientIntakeSession> {
    return this.db.clientIntakeSession.create({ data });
  }

  async findById(id: string): Promise<ClientIntakeSession | null> {
    return this.db.clientIntakeSession.findUnique({ where: { id } });
  }

  async listForOrg(orgId: string): Promise<ClientIntakeSession[]> {
    return this.db.clientIntakeSession.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForClient(clientId: string): Promise<ClientIntakeSession[]> {
    return this.db.clientIntakeSession.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, data: Prisma.ClientIntakeSessionUpdateInput): Promise<ClientIntakeSession> {
    return this.db.clientIntakeSession.update({ where: { id }, data });
  }

  async updateStatus(
    id: string,
    status: ClientIntakeStatus,
    extra?: { completedAt?: Date; expiresAt?: Date },
  ): Promise<ClientIntakeSession> {
    return this.db.clientIntakeSession.update({
      where: { id },
      data: {
        status,
        ...(extra?.completedAt !== undefined ? { completedAt: extra.completedAt } : {}),
        ...(extra?.expiresAt !== undefined ? { expiresAt: extra.expiresAt } : {}),
      },
    });
  }
}

export type { ClientIntakeStatus };
