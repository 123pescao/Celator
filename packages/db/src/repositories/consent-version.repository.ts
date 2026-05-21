import type { PrismaClient, ConsentVersion, Prisma } from '../../generated/client/index.js';

export class ConsentVersionRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.ConsentVersionCreateInput): Promise<ConsentVersion> {
    return this.db.consentVersion.create({ data });
  }

  async findById(id: string): Promise<ConsentVersion | null> {
    return this.db.consentVersion.findUnique({ where: { id } });
  }

  async findByVersion(version: string): Promise<ConsentVersion | null> {
    return this.db.consentVersion.findUnique({ where: { version } });
  }

  async findCurrent(): Promise<ConsentVersion | null> {
    const now = new Date();
    return this.db.consentVersion.findFirst({
      where: {
        effectiveFrom: { lte: now },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  async list(): Promise<ConsentVersion[]> {
    return this.db.consentVersion.findMany({ orderBy: { effectiveFrom: 'desc' } });
  }
}
