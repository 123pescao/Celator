import type { PrismaClient, RemovalRequestPacket, RemovalRequestPacketItem, PacketStatus, Prisma } from '../../generated/client/index.js';

export interface PacketWithItems extends RemovalRequestPacket {
  items: RemovalRequestPacketItem[];
}

export class RemovalRequestPacketRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.RemovalRequestPacketCreateInput): Promise<RemovalRequestPacket> {
    return this.db.removalRequestPacket.create({ data });
  }

  async createItem(data: Prisma.RemovalRequestPacketItemCreateInput): Promise<RemovalRequestPacketItem> {
    return this.db.removalRequestPacketItem.create({ data });
  }

  async findById(id: string): Promise<RemovalRequestPacket | null> {
    return this.db.removalRequestPacket.findUnique({ where: { id } });
  }

  async findByIdWithItems(id: string): Promise<PacketWithItems | null> {
    return this.db.removalRequestPacket.findUnique({
      where: { id },
      include: { items: { orderBy: { itemOrder: 'asc' } } },
    });
  }

  async findItemById(itemId: string): Promise<RemovalRequestPacketItem | null> {
    return this.db.removalRequestPacketItem.findUnique({ where: { id: itemId } });
  }

  async listForTask(taskId: string): Promise<RemovalRequestPacket[]> {
    return this.db.removalRequestPacket.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForClient(clientId: string): Promise<RemovalRequestPacket[]> {
    return this.db.removalRequestPacket.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, status: PacketStatus): Promise<RemovalRequestPacket> {
    return this.db.removalRequestPacket.update({ where: { id }, data: { status } });
  }

  async updateItemStatus(
    itemId: string,
    status: 'COMPLETED' | 'BLOCKED' | 'SKIPPED',
    extra?: { operatorNotes?: string; completedAt?: Date },
  ): Promise<RemovalRequestPacketItem> {
    return this.db.removalRequestPacketItem.update({
      where: { id: itemId },
      data: {
        status,
        ...(extra?.operatorNotes !== undefined ? { operatorNotes: extra.operatorNotes } : {}),
        ...(extra?.completedAt !== undefined ? { completedAt: extra.completedAt } : {}),
      },
    });
  }
}

export type { RemovalRequestPacket, RemovalRequestPacketItem, PacketStatus };
