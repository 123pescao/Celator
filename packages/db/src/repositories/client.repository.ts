import type { PrismaClient, Client, ClientStatus, Prisma } from '../../generated/client/index.js';

export class ClientRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.ClientCreateInput): Promise<Client> {
    return this.db.client.create({ data });
  }

  async findById(id: string): Promise<Client | null> {
    return this.db.client.findUnique({ where: { id } });
  }

  async listByOrg(organizationId: string): Promise<Client[]> {
    return this.db.client.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, status: ClientStatus): Promise<Client> {
    return this.db.client.update({ where: { id }, data: { status } });
  }

  async update(id: string, data: Prisma.ClientUpdateInput): Promise<Client> {
    return this.db.client.update({ where: { id }, data });
  }
}
