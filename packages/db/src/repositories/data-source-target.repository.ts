import type { PrismaClient, DataSourceTarget, SourceType, ActionType, Prisma } from '../../generated/client/index.js';

export class DataSourceTargetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    sourceName: string;
    sourceType: SourceType;
    baseDomain?: string | undefined;
    jurisdiction?: string | undefined;
    supportedActionTypes?: ActionType[] | undefined;
    requiresLogin?: boolean | undefined;
    requiresCaptcha?: boolean | undefined;
    manualOnly?: boolean | undefined;
    piiRequiredFields?: string[] | undefined;
    notes?: string | undefined;
    isActive?: boolean | undefined;
  }): Promise<DataSourceTarget> {
    return this.prisma.dataSourceTarget.create({
      data: {
        sourceName: data.sourceName,
        sourceType: data.sourceType,
        ...(data.baseDomain !== undefined ? { baseDomain: data.baseDomain } : {}),
        ...(data.jurisdiction !== undefined ? { jurisdiction: data.jurisdiction } : {}),
        ...(data.supportedActionTypes !== undefined ? { supportedActionTypes: data.supportedActionTypes } : {}),
        ...(data.requiresLogin !== undefined ? { requiresLogin: data.requiresLogin } : {}),
        ...(data.requiresCaptcha !== undefined ? { requiresCaptcha: data.requiresCaptcha } : {}),
        ...(data.manualOnly !== undefined ? { manualOnly: data.manualOnly } : {}),
        ...(data.piiRequiredFields !== undefined ? { piiRequiredFields: data.piiRequiredFields } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
  }

  async findById(id: string): Promise<DataSourceTarget | null> {
    return this.prisma.dataSourceTarget.findUnique({ where: { id } });
  }

  async findBySourceName(sourceName: string): Promise<DataSourceTarget | null> {
    return this.prisma.dataSourceTarget.findUnique({ where: { sourceName } });
  }

  async listActive(sourceType?: SourceType): Promise<DataSourceTarget[]> {
    return this.prisma.dataSourceTarget.findMany({
      where: { isActive: true, ...(sourceType ? { sourceType } : {}) },
      orderBy: { sourceName: 'asc' },
    });
  }

  async list(isActive?: boolean): Promise<DataSourceTarget[]> {
    return this.prisma.dataSourceTarget.findMany({
      ...(isActive !== undefined ? { where: { isActive } } : {}),
      orderBy: { sourceName: 'asc' },
    });
  }

  async update(id: string, data: Prisma.DataSourceTargetUpdateInput): Promise<DataSourceTarget> {
    return this.prisma.dataSourceTarget.update({ where: { id }, data });
  }

  async setActive(id: string, isActive: boolean): Promise<DataSourceTarget> {
    return this.prisma.dataSourceTarget.update({ where: { id }, data: { isActive } });
  }
}
