import type {
  PrismaClient,
  ManualRemovalSubmission,
  SubmissionMethod,
  SubmissionStatus,
  Prisma,
} from '../../generated/client/index.js';

export class ManualRemovalSubmissionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: Prisma.ManualRemovalSubmissionCreateInput): Promise<ManualRemovalSubmission> {
    return this.prisma.manualRemovalSubmission.create({ data });
  }

  async findById(id: string): Promise<ManualRemovalSubmission | null> {
    return this.prisma.manualRemovalSubmission.findUnique({ where: { id } });
  }

  async findByTaskId(taskId: string): Promise<ManualRemovalSubmission[]> {
    return this.prisma.manualRemovalSubmission.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listForClient(clientId: string): Promise<ManualRemovalSubmission[]> {
    return this.prisma.manualRemovalSubmission.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, status: SubmissionStatus): Promise<ManualRemovalSubmission> {
    return this.prisma.manualRemovalSubmission.update({ where: { id }, data: { submissionStatus: status } });
  }

  async updateSubmitted(
    id: string,
    data: {
      submittedAt: Date;
      confirmationCode?: string | undefined;
      confirmationUrl?: string | undefined;
      operatorNotes?: string | undefined;
    },
  ): Promise<ManualRemovalSubmission> {
    return this.prisma.manualRemovalSubmission.update({
      where: { id },
      data: {
        submissionStatus: 'SUBMITTED',
        submittedAt: data.submittedAt,
        ...(data.confirmationCode !== undefined ? { confirmationCode: data.confirmationCode } : {}),
        ...(data.confirmationUrl !== undefined ? { confirmationUrl: data.confirmationUrl } : {}),
        ...(data.operatorNotes !== undefined ? { operatorNotes: data.operatorNotes } : {}),
      },
    });
  }

  async updateOutcome(
    id: string,
    data: {
      status: SubmissionStatus;
      confirmationCode?: string | undefined;
      confirmationUrl?: string | undefined;
      operatorNotes?: string | undefined;
    },
  ): Promise<ManualRemovalSubmission> {
    return this.prisma.manualRemovalSubmission.update({
      where: { id },
      data: {
        submissionStatus: data.status,
        ...(data.confirmationCode !== undefined ? { confirmationCode: data.confirmationCode } : {}),
        ...(data.confirmationUrl !== undefined ? { confirmationUrl: data.confirmationUrl } : {}),
        ...(data.operatorNotes !== undefined ? { operatorNotes: data.operatorNotes } : {}),
      },
    });
  }
}

export type { ManualRemovalSubmission, SubmissionMethod, SubmissionStatus };
