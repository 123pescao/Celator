import type { PrismaClient, User, Prisma } from '../../generated/client/index.js';

export class UserRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.UserCreateInput): Promise<User> {
    return this.db.user.create({ data });
  }

  async findById(id: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { email } });
  }

  async listByOrg(organizationId: string, activeOnly = true): Promise<User[]> {
    return this.db.user.findMany({
      where: { organizationId, ...(activeOnly ? { isActive: true } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.db.user.update({ where: { id }, data });
  }

  async countActiveInOrg(organizationId: string): Promise<number> {
    return this.db.user.count({ where: { organizationId, isActive: true } });
  }
}
