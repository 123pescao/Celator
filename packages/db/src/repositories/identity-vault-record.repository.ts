import type { PrismaClient, IdentityVaultRecord } from '../../generated/client/index.js';

export class IdentityVaultRecordRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    clientId: string;
    fieldType: string;
    ciphertext: string;
    iv: string;
    authTag: string;
    keyId: string;
    keyVersion: string;
    encryptedKeyRef?: string;
    redactedDisplay?: string;
  }): Promise<IdentityVaultRecord> {
    return this.prisma.identityVaultRecord.create({ data });
  }

  async findById(id: string): Promise<IdentityVaultRecord | null> {
    return this.prisma.identityVaultRecord.findUnique({ where: { id } });
  }

  async listByClient(clientId: string): Promise<IdentityVaultRecord[]> {
    return this.prisma.identityVaultRecord.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markCryptoShredded(id: string): Promise<IdentityVaultRecord> {
    return this.prisma.identityVaultRecord.update({
      where: { id },
      data: { isCryptoShredded: true },
    });
  }
}
