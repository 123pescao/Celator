import type { PrismaClient, CaseReport, ReportType, ExportFormat, ReportStatus, Prisma } from '../../generated/client/index.js';

export class CaseReportRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.CaseReportCreateInput): Promise<CaseReport> {
    return this.db.caseReport.create({ data });
  }

  async findById(id: string): Promise<CaseReport | null> {
    return this.db.caseReport.findUnique({ where: { id } });
  }

  async listForClient(clientId: string): Promise<CaseReport[]> {
    return this.db.caseReport.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForCase(caseId: string): Promise<CaseReport[]> {
    return this.db.caseReport.findMany({
      where: { caseId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(
    id: string,
    status: ReportStatus,
    extra?: {
      generatedAt?: Date;
      failedAt?: Date;
      expiresAt?: Date;
      failureReason?: string;
      vaultAccessLogId?: string;
    },
  ): Promise<CaseReport> {
    return this.db.caseReport.update({
      where: { id },
      data: {
        status,
        ...(extra?.generatedAt !== undefined ? { generatedAt: extra.generatedAt } : {}),
        ...(extra?.failedAt !== undefined ? { failedAt: extra.failedAt } : {}),
        ...(extra?.expiresAt !== undefined ? { expiresAt: extra.expiresAt } : {}),
        ...(extra?.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
        ...(extra?.vaultAccessLogId !== undefined ? { vaultAccessLogId: extra.vaultAccessLogId } : {}),
      },
    });
  }
}

export type { CaseReport, ReportType, ExportFormat, ReportStatus };
