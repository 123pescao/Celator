import type {
  PrismaClient,
  TaskWorkflowRun,
  TaskWorkflowStepRun,
  WorkflowRunStatus,
  WorkflowStepStatus,
  WorkflowStepKind,
} from '../../generated/client/index.js';

export interface WorkflowRunWithSteps extends TaskWorkflowRun {
  stepRuns: TaskWorkflowStepRun[];
}

export class TaskWorkflowRunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    taskId: string;
    clientId: string;
    playbookId: string;
    currentStepOrder?: number | undefined;
    startedAt?: Date | undefined;
  }): Promise<TaskWorkflowRun> {
    return this.prisma.taskWorkflowRun.create({
      data: {
        task: { connect: { id: data.taskId } },
        client: { connect: { id: data.clientId } },
        playbook: { connect: { id: data.playbookId } },
        status: 'IN_PROGRESS',
        ...(data.currentStepOrder !== undefined ? { currentStepOrder: data.currentStepOrder } : {}),
        ...(data.startedAt !== undefined ? { startedAt: data.startedAt } : {}),
      },
    });
  }

  async createStepRun(data: {
    workflowRunId: string;
    playbookStepId: string;
    stepOrder: number;
    stepKind: WorkflowStepKind;
    status: WorkflowStepStatus;
  }): Promise<TaskWorkflowStepRun> {
    return this.prisma.taskWorkflowStepRun.create({
      data: {
        workflowRun: { connect: { id: data.workflowRunId } },
        playbookStep: { connect: { id: data.playbookStepId } },
        stepOrder: data.stepOrder,
        stepKind: data.stepKind,
        status: data.status,
      },
    });
  }

  async findById(workflowRunId: string): Promise<TaskWorkflowRun | null> {
    return this.prisma.taskWorkflowRun.findUnique({ where: { id: workflowRunId } });
  }

  async findByIdWithSteps(workflowRunId: string): Promise<WorkflowRunWithSteps | null> {
    return this.prisma.taskWorkflowRun.findUnique({
      where: { id: workflowRunId },
      include: { stepRuns: { orderBy: { stepOrder: 'asc' } } },
    }) as Promise<WorkflowRunWithSteps | null>;
  }

  async findActiveByTaskId(taskId: string): Promise<TaskWorkflowRun | null> {
    return this.prisma.taskWorkflowRun.findFirst({
      where: {
        taskId,
        status: { in: ['IN_PROGRESS', 'WAITING', 'BLOCKED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findLatestByTaskId(taskId: string): Promise<TaskWorkflowRun | null> {
    return this.prisma.taskWorkflowRun.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForClient(clientId: string): Promise<TaskWorkflowRun[]> {
    return this.prisma.taskWorkflowRun.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findStepRunById(stepRunId: string): Promise<TaskWorkflowStepRun | null> {
    return this.prisma.taskWorkflowStepRun.findUnique({ where: { id: stepRunId } });
  }

  async listStepRunsForRun(workflowRunId: string): Promise<TaskWorkflowStepRun[]> {
    return this.prisma.taskWorkflowStepRun.findMany({
      where: { workflowRunId },
      orderBy: { stepOrder: 'asc' },
    });
  }

  async updateRunStatus(
    workflowRunId: string,
    data: {
      status: WorkflowRunStatus;
      currentStepOrder?: number | undefined;
      completedAt?: Date | undefined;
    },
  ): Promise<TaskWorkflowRun> {
    return this.prisma.taskWorkflowRun.update({
      where: { id: workflowRunId },
      data: {
        status: data.status,
        ...(data.currentStepOrder !== undefined ? { currentStepOrder: data.currentStepOrder } : {}),
        ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
      },
    });
  }

  async updateStepStatus(
    stepRunId: string,
    data: {
      status: WorkflowStepStatus;
      operatorNotes?: string | undefined;
      safeResultSummary?: string | undefined;
      startedAt?: Date | undefined;
      completedAt?: Date | undefined;
    },
  ): Promise<TaskWorkflowStepRun> {
    return this.prisma.taskWorkflowStepRun.update({
      where: { id: stepRunId },
      data: {
        status: data.status,
        ...(data.operatorNotes !== undefined ? { operatorNotes: data.operatorNotes } : {}),
        ...(data.safeResultSummary !== undefined ? { safeResultSummary: data.safeResultSummary } : {}),
        ...(data.startedAt !== undefined ? { startedAt: data.startedAt } : {}),
        ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
      },
    });
  }

  async attachManualSubmission(stepRunId: string, manualSubmissionId: string): Promise<TaskWorkflowStepRun> {
    return this.prisma.taskWorkflowStepRun.update({
      where: { id: stepRunId },
      data: { manualSubmissionId },
    });
  }

  async attachEvidence(stepRunId: string, evidenceRecordId: string): Promise<TaskWorkflowStepRun> {
    return this.prisma.taskWorkflowStepRun.update({
      where: { id: stepRunId },
      data: { evidenceRecordId },
    });
  }
}

export type { TaskWorkflowRun, TaskWorkflowStepRun, WorkflowRunStatus, WorkflowStepStatus, WorkflowStepKind };
