import type {
  PrismaClient,
  IdentityVaultAccessLog,
  VaultPurposeCode,
  ActorType,
} from '../../generated/client/index.js';

export class IdentityVaultAccessLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    recordId: string;
    clientId: string;
    purposeCode: VaultPurposeCode;
    actorId: string;
    actorType: ActorType;
  }): Promise<IdentityVaultAccessLog> {
    return this.prisma.identityVaultAccessLog.create({ data });
  }

  async listByRecord(recordId: string): Promise<IdentityVaultAccessLog[]> {
    return this.prisma.identityVaultAccessLog.findMany({
      where: { recordId },
      orderBy: { accessedAt: 'desc' },
    });
  }

  async listByClient(clientId: string, limit = 100): Promise<IdentityVaultAccessLog[]> {
    return this.prisma.identityVaultAccessLog.findMany({
      where: { clientId },
      orderBy: { accessedAt: 'desc' },
      take: limit,
    });
  }
}
