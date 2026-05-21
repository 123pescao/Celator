import type {
  PrismaClient,
  ClientIdentityVerification,
  IdentityVerificationStatus,
  Prisma,
} from '../../generated/client/index.js';

export class ClientIdentityVerificationRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.ClientIdentityVerificationCreateInput): Promise<ClientIdentityVerification> {
    return this.db.clientIdentityVerification.create({ data });
  }

  async findById(id: string): Promise<ClientIdentityVerification | null> {
    return this.db.clientIdentityVerification.findUnique({ where: { id } });
  }

  async findLatestForClient(clientId: string): Promise<ClientIdentityVerification | null> {
    return this.db.clientIdentityVerification.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForClient(clientId: string): Promise<ClientIdentityVerification[]> {
    return this.db.clientIdentityVerification.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, data: Prisma.ClientIdentityVerificationUpdateInput): Promise<ClientIdentityVerification> {
    return this.db.clientIdentityVerification.update({ where: { id }, data });
  }

  async updateStatus(
    id: string,
    status: IdentityVerificationStatus,
    extra?: Partial<Pick<ClientIdentityVerification, 'verifiedAt' | 'rejectedAt' | 'rejectionReason'>>,
  ): Promise<ClientIdentityVerification> {
    return this.db.clientIdentityVerification.update({
      where: { id },
      data: { status, ...extra },
    });
  }
}
