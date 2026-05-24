import type {
  PrismaClient,
  RemovalPlaybook,
  RemovalPlaybookStep,
  PlaybookStatus,
  WorkflowStepKind,
  SourceType,
} from '../../generated/client/index.js';

export interface PlaybookWithSteps extends RemovalPlaybook {
  steps: RemovalPlaybookStep[];
}

export class RemovalPlaybookRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    name: string;
    version: string;
    sourceType?: SourceType | undefined;
    dataSourceTargetId?: string | undefined;
    description?: string | undefined;
  }): Promise<RemovalPlaybook> {
    return this.prisma.removalPlaybook.create({
      data: {
        name: data.name,
        version: data.version,
        ...(data.sourceType !== undefined ? { sourceType: data.sourceType } : {}),
        ...(data.dataSourceTargetId !== undefined ? { dataSourceTargetId: data.dataSourceTargetId } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
    });
  }

  async addStep(data: {
    playbookId: string;
    stepOrder: number;
    stepKind: WorkflowStepKind;
    title: string;
    instructions: string;
    requiresApproval?: boolean | undefined;
    requiresManualSubmission?: boolean | undefined;
    requiredEvidenceType?: string | undefined;
  }): Promise<RemovalPlaybookStep> {
    return this.prisma.removalPlaybookStep.create({
      data: {
        playbook: { connect: { id: data.playbookId } },
        stepOrder: data.stepOrder,
        stepKind: data.stepKind,
        title: data.title,
        instructions: data.instructions,
        ...(data.requiresApproval !== undefined ? { requiresApproval: data.requiresApproval } : {}),
        ...(data.requiresManualSubmission !== undefined ? { requiresManualSubmission: data.requiresManualSubmission } : {}),
        ...(data.requiredEvidenceType !== undefined ? { requiredEvidenceType: data.requiredEvidenceType } : {}),
      },
    });
  }

  async findById(id: string): Promise<RemovalPlaybook | null> {
    return this.prisma.removalPlaybook.findUnique({ where: { id } });
  }

  async findByIdWithSteps(id: string): Promise<PlaybookWithSteps | null> {
    return this.prisma.removalPlaybook.findUnique({
      where: { id },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
  }

  async findActiveForTarget(dataSourceTargetId: string): Promise<RemovalPlaybook | null> {
    return this.prisma.removalPlaybook.findFirst({
      where: { dataSourceTargetId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findActiveForSourceType(sourceType: SourceType): Promise<RemovalPlaybook | null> {
    return this.prisma.removalPlaybook.findFirst({
      where: {
        sourceType,
        dataSourceTargetId: null,
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listActive(): Promise<RemovalPlaybook[]> {
    return this.prisma.removalPlaybook.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ name: 'asc' }, { version: 'desc' }],
    });
  }

  async listActiveWithSteps(): Promise<PlaybookWithSteps[]> {
    return this.prisma.removalPlaybook.findMany({
      where: { status: 'ACTIVE' },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
      orderBy: [{ name: 'asc' }, { version: 'desc' }],
    }) as Promise<PlaybookWithSteps[]>;
  }

  async setStatus(id: string, status: PlaybookStatus): Promise<RemovalPlaybook> {
    return this.prisma.removalPlaybook.update({ where: { id }, data: { status } });
  }
}

export type { RemovalPlaybook, RemovalPlaybookStep, PlaybookStatus, WorkflowStepKind };
