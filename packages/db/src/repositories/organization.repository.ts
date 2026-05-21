import type { PrismaClient, Organization, Prisma } from '../../generated/client/index.js';

export class OrganizationRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.OrganizationCreateInput): Promise<Organization> {
    return this.db.organization.create({ data });
  }

  async findById(id: string): Promise<Organization | null> {
    return this.db.organization.findUnique({ where: { id } });
  }

  async list(activeOnly = true): Promise<Organization[]> {
    return this.db.organization.findMany({
      ...(activeOnly ? { where: { isActive: true } } : {}),
      orderBy: { createdAt: 'asc' },
    });
  }

  async setActive(id: string, isActive: boolean): Promise<Organization> {
    return this.db.organization.update({ where: { id }, data: { isActive } });
  }
}
