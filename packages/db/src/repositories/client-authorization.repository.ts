import type { PrismaClient, ClientAuthorization, Prisma } from '../../generated/client/index.js';

export class ClientAuthorizationRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.ClientAuthorizationCreateInput): Promise<ClientAuthorization> {
    return this.db.clientAuthorization.create({ data });
  }

  async findById(id: string): Promise<ClientAuthorization | null> {
    return this.db.clientAuthorization.findUnique({ where: { id } });
  }

  async findActiveForClient(clientId: string): Promise<ClientAuthorization[]> {
    const now = new Date();
    return this.db.clientAuthorization.findMany({
      where: {
        clientId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { signedAt: 'desc' },
    });
  }

  async listForClient(clientId: string): Promise<ClientAuthorization[]> {
    return this.db.clientAuthorization.findMany({
      where: { clientId },
      orderBy: { signedAt: 'desc' },
    });
  }

  async revoke(id: string, reason: string, revokedAt: Date): Promise<ClientAuthorization> {
    return this.db.clientAuthorization.update({
      where: { id },
      data: { revokedAt, revocationReason: reason },
    });
  }
}
