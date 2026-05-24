import type {
  RemovalPlaybookRepository,
  TaskWorkflowRunRepository,
  CleanupTaskRepository,
  PlaybookWithSteps,
  WorkflowRunStatus,
  WorkflowStepKind,
} from '@celator/db';
import type { RemovalPlaybook, RemovalPlaybookStep, TaskWorkflowRun, TaskWorkflowStepRun } from '@celator/db';
import type { SourceType } from '@celator/db';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { CaseTimelineService } from './case-timeline.service.js';

// ─── Input types ─────────────────────────────────────────────────────────────

export interface CreatePlaybookStepInput {
  stepOrder: number;
  stepKind: WorkflowStepKind;
  title: string;
  instructions: string;
  requiresApproval?: boolean | undefined;
  requiresManualSubmission?: boolean | undefined;
  requiredEvidenceType?: string | undefined;
}

export interface CreatePlaybookInput {
  name: string;
  version: string;
  sourceType?: SourceType | undefined;
  dataSourceTargetId?: string | undefined;
  description?: string | undefined;
  steps: CreatePlaybookStepInput[];
}

export interface StartWorkflowInput {
  taskId: string;
  clientId: string;
  playbookId?: string | undefined;
}

export interface AdvanceStepInput {
  operatorNotes?: string | undefined;
  safeResultSummary?: string | undefined;
}

export interface BlockStepInput {
  reason: string;
}

export interface AttachManualSubmissionInput {
  manualSubmissionId: string;
}

// ─── Safe return types — no ciphertext, no vault fields ──────────────────────

export interface SafePlaybook {
  id: string;
  name: string;
  version: string;
  sourceType: SourceType | null;
  dataSourceTargetId: string | null;
  status: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafePlaybookStep {
  id: string;
  playbookId: string;
  stepOrder: number;
  stepKind: WorkflowStepKind;
  title: string;
  instructions: string;
  requiresApproval: boolean;
  requiresManualSubmission: boolean;
  requiredEvidenceType: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafePlaybookWithSteps extends SafePlaybook {
  steps: SafePlaybookStep[];
}

export interface SafeWorkflowStepRun {
  id: string;
  workflowRunId: string;
  playbookStepId: string;
  stepOrder: number;
  stepKind: WorkflowStepKind;
  title: string;
  instructions: string;
  status: string;
  operatorNotes: string | null;
  safeResultSummary: string | null;
  evidenceRecordId: string | null;
  manualSubmissionId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafeWorkflowState {
  run: {
    id: string;
    taskId: string;
    clientId: string;
    playbookId: string;
    status: WorkflowRunStatus;
    currentStepOrder: number | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  steps: SafeWorkflowStepRun[];
}

// ─── Allowed step kinds for submission attachment ─────────────────────────────
const SUBMISSION_LINKABLE_KINDS: WorkflowStepKind[] = ['MANUAL_SUBMISSION', 'RECORD_OUTCOME'];

// ─── Terminal run statuses ────────────────────────────────────────────────────
const TERMINAL_RUN_STATUSES: WorkflowRunStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

// ─── Helper mappers ───────────────────────────────────────────────────────────

function toSafePlaybook(p: RemovalPlaybook): SafePlaybook {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    sourceType: p.sourceType,
    dataSourceTargetId: p.dataSourceTargetId,
    status: p.status,
    description: p.description,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function toSafeStep(s: RemovalPlaybookStep): SafePlaybookStep {
  return {
    id: s.id,
    playbookId: s.playbookId,
    stepOrder: s.stepOrder,
    stepKind: s.stepKind,
    title: s.title,
    instructions: s.instructions,
    requiresApproval: s.requiresApproval,
    requiresManualSubmission: s.requiresManualSubmission,
    requiredEvidenceType: s.requiredEvidenceType,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function toSafePlaybookWithSteps(p: PlaybookWithSteps): SafePlaybookWithSteps {
  return { ...toSafePlaybook(p), steps: p.steps.map(toSafeStep) };
}

function mergeStepRunWithPlaybookStep(
  sr: TaskWorkflowStepRun,
  playbookStep: RemovalPlaybookStep,
): SafeWorkflowStepRun {
  return {
    id: sr.id,
    workflowRunId: sr.workflowRunId,
    playbookStepId: sr.playbookStepId,
    stepOrder: sr.stepOrder,
    stepKind: sr.stepKind,
    title: playbookStep.title,
    instructions: playbookStep.instructions,
    status: sr.status,
    operatorNotes: sr.operatorNotes,
    safeResultSummary: sr.safeResultSummary,
    evidenceRecordId: sr.evidenceRecordId,
    manualSubmissionId: sr.manualSubmissionId,
    startedAt: sr.startedAt,
    completedAt: sr.completedAt,
    createdAt: sr.createdAt,
    updatedAt: sr.updatedAt,
  };
}

function toSafeRun(run: TaskWorkflowRun): SafeWorkflowState['run'] {
  return {
    id: run.id,
    taskId: run.taskId,
    clientId: run.clientId,
    playbookId: run.playbookId,
    status: run.status,
    currentStepOrder: run.currentStepOrder,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function checkText(text: string | undefined): string | null {
  if (text === undefined) return null;
  return checkRedactedPreview(text);
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class WorkflowEngineService {
  constructor(
    private readonly playbookRepo: RemovalPlaybookRepository,
    private readonly runRepo: TaskWorkflowRunRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly audit: AuditService,
    private readonly timeline: CaseTimelineService,
  ) {}

  async createPlaybook(
    input: CreatePlaybookInput,
    actorId: string,
  ): Promise<Result<SafePlaybookWithSteps, ErrorCode>> {
    if (!input.steps || input.steps.length === 0) {
      return err('VALIDATION_ERROR', 'A playbook must have at least one step');
    }

    // Validate instructions PII safety
    for (const step of input.steps) {
      const violation = checkText(step.instructions);
      if (violation) {
        return err('WORKFLOW_UNSAFE_TEXT', `Step ${step.stepOrder} instructions rejected: ${violation}`);
      }
      const titleViolation = checkText(step.title);
      if (titleViolation) {
        return err('WORKFLOW_UNSAFE_TEXT', `Step ${step.stepOrder} title rejected: ${titleViolation}`);
      }
    }

    // Check for duplicate stepOrder
    const orders = input.steps.map((s) => s.stepOrder);
    if (new Set(orders).size !== orders.length) {
      return err('VALIDATION_ERROR', 'Duplicate stepOrder values in steps');
    }

    const playbook = await this.playbookRepo.create({
      name: input.name,
      version: input.version,
      ...(input.sourceType !== undefined ? { sourceType: input.sourceType } : {}),
      ...(input.dataSourceTargetId !== undefined ? { dataSourceTargetId: input.dataSourceTargetId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });

    const sortedSteps = [...input.steps].sort((a, b) => a.stepOrder - b.stepOrder);
    const createdSteps: RemovalPlaybookStep[] = [];
    for (const step of sortedSteps) {
      const s = await this.playbookRepo.addStep({
        playbookId: playbook.id,
        stepOrder: step.stepOrder,
        stepKind: step.stepKind,
        title: step.title,
        instructions: step.instructions,
        ...(step.requiresApproval !== undefined ? { requiresApproval: step.requiresApproval } : {}),
        ...(step.requiresManualSubmission !== undefined ? { requiresManualSubmission: step.requiresManualSubmission } : {}),
        ...(step.requiredEvidenceType !== undefined ? { requiredEvidenceType: step.requiredEvidenceType } : {}),
      });
      createdSteps.push(s);
    }

    const auditResult = await this.audit.write({
      eventType: 'WORKFLOW_PLAYBOOK_CREATED',
      actorId,
      actorType: 'OPERATOR',
      resourceId: playbook.id,
      resourceType: 'RemovalPlaybook',
      outcome: 'ALLOWED',
      metadata: { playbookName: input.name, version: input.version, stepCount: createdSteps.length },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafePlaybookWithSteps({ ...playbook, steps: createdSteps }));
  }

  async startWorkflowForTask(
    input: StartWorkflowInput,
    actorId: string,
  ): Promise<Result<SafeWorkflowState, ErrorCode>> {
    const task = await this.taskRepo.findById(input.taskId);
    if (!task) return err('NOT_FOUND', `Task ${input.taskId} not found`);

    let playbook: PlaybookWithSteps | null = null;

    if (input.playbookId) {
      playbook = await this.playbookRepo.findByIdWithSteps(input.playbookId);
      if (!playbook) return err('PLAYBOOK_NOT_FOUND', `Playbook ${input.playbookId} not found`);
      if (playbook.status !== 'ACTIVE') {
        return err('PLAYBOOK_NOT_FOUND', `Playbook "${playbook.name}" is not active`);
      }
    } else {
      // Auto-select: target-specific → source-type → error
      if (task.dataSourceTargetId) {
        const targetPlaybook = await this.playbookRepo.findActiveForTarget(task.dataSourceTargetId);
        if (targetPlaybook) {
          playbook = await this.playbookRepo.findByIdWithSteps(targetPlaybook.id);
        }
      }

      if (!playbook && task.dataSourceTargetId) {
        // Try to look up the source type from the task's target
        // We can't do a DB join here without a targetRepo, so we skip sourceType fallback
        // unless the caller provides a playbookId. This is intentional design simplicity.
      }

      if (!playbook) {
        return err('PLAYBOOK_NOT_FOUND', 'No active playbook found for task — provide an explicit playbookId');
      }
    }

    if (!playbook.steps || playbook.steps.length === 0) {
      return err('VALIDATION_ERROR', `Playbook "${playbook.name}" has no steps`);
    }

    const sortedSteps = [...playbook.steps].sort((a, b) => a.stepOrder - b.stepOrder);
    const firstStep = sortedSteps[0]!;

    const run = await this.runRepo.create({
      taskId: input.taskId,
      clientId: input.clientId,
      playbookId: playbook.id,
      currentStepOrder: firstStep.stepOrder,
      startedAt: new Date(),
    });

    const createdStepRuns: TaskWorkflowStepRun[] = [];
    for (const step of sortedSteps) {
      const sr = await this.runRepo.createStepRun({
        workflowRunId: run.id,
        playbookStepId: step.id,
        stepOrder: step.stepOrder,
        stepKind: step.stepKind,
        status: step.stepOrder === firstStep.stepOrder ? 'READY' : 'PENDING',
      });
      createdStepRuns.push(sr);
    }

    const auditResult = await this.audit.write({
      eventType: 'WORKFLOW_STARTED',
      actorId,
      actorType: 'OPERATOR',
      clientId: input.clientId,
      resourceId: run.id,
      resourceType: 'TaskWorkflowRun',
      outcome: 'ALLOWED',
      metadata: { taskId: input.taskId, playbookId: playbook.id, stepCount: sortedSteps.length },
    });
    if (!auditResult.ok) return auditResult;

    await this.timeline.append({
      caseId: task.caseId,
      taskId: input.taskId,
      eventType: 'WORKFLOW_STARTED',
      actorId,
      actorType: 'OPERATOR',
      note: `Workflow started using playbook "${playbook.name}" v${playbook.version}`,
    });

    const stepMap = new Map(sortedSteps.map((s) => [s.id, s]));
    const safeSteps = createdStepRuns.map((sr) => {
      const ps = stepMap.get(sr.playbookStepId)!;
      return mergeStepRunWithPlaybookStep(sr, ps);
    });

    return ok({ run: toSafeRun(run), steps: safeSteps });
  }

  async advanceStep(
    workflowRunId: string,
    stepRunId: string,
    input: AdvanceStepInput,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafeWorkflowState, ErrorCode>> {
    const run = await this.runRepo.findById(workflowRunId);
    if (!run) return err('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${workflowRunId} not found`);

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      return err('WORKFLOW_INVALID_TRANSITION', `Workflow run is in terminal status "${run.status}"`);
    }

    const stepRun = await this.runRepo.findStepRunById(stepRunId);
    if (!stepRun || stepRun.workflowRunId !== workflowRunId) {
      return err('WORKFLOW_STEP_NOT_FOUND', `Step run ${stepRunId} not found in run ${workflowRunId}`);
    }

    if (stepRun.status !== 'READY' && stepRun.status !== 'IN_PROGRESS') {
      return err(
        'WORKFLOW_INVALID_TRANSITION',
        `Step is in status "${stepRun.status}" — can only advance READY or IN_PROGRESS steps`,
      );
    }

    if (input.operatorNotes !== undefined) {
      const v = checkText(input.operatorNotes);
      if (v) return err('WORKFLOW_UNSAFE_TEXT', `operatorNotes rejected: ${v}`);
    }
    if (input.safeResultSummary !== undefined) {
      const v = checkText(input.safeResultSummary);
      if (v) return err('WORKFLOW_UNSAFE_TEXT', `safeResultSummary rejected: ${v}`);
    }

    const now = new Date();
    await this.runRepo.updateStepStatus(stepRunId, {
      status: 'COMPLETED',
      ...(input.operatorNotes !== undefined ? { operatorNotes: input.operatorNotes } : {}),
      ...(input.safeResultSummary !== undefined ? { safeResultSummary: input.safeResultSummary } : {}),
      completedAt: now,
    });

    // Find next pending step
    const allStepRuns = await this.runRepo.listStepRunsForRun(workflowRunId);
    const pendingSteps = allStepRuns
      .filter((sr) => sr.id !== stepRunId && sr.status === 'PENDING')
      .sort((a, b) => a.stepOrder - b.stepOrder);

    let newStatus: WorkflowRunStatus = 'IN_PROGRESS';
    let nextStepOrder: number | null = run.currentStepOrder;

    if (pendingSteps.length > 0) {
      const nextStep = pendingSteps[0]!;
      await this.runRepo.updateStepStatus(nextStep.id, { status: 'READY' });
      nextStepOrder = nextStep.stepOrder;
    } else {
      // No more pending steps — check if all are done
      const nonDone = allStepRuns.filter(
        (sr) => sr.id !== stepRunId && !['COMPLETED', 'SKIPPED'].includes(sr.status),
      );
      if (nonDone.length === 0) {
        newStatus = 'COMPLETED';
        nextStepOrder = null;
      }
    }

    const updatedRun = await this.runRepo.updateRunStatus(workflowRunId, {
      status: newStatus,
      ...(nextStepOrder !== run.currentStepOrder ? { currentStepOrder: nextStepOrder ?? undefined } : {}),
      ...(newStatus === 'COMPLETED' ? { completedAt: now } : {}),
    });

    const task = await this.taskRepo.findById(run.taskId);
    const eventType = newStatus === 'COMPLETED' ? 'WORKFLOW_COMPLETED' : 'WORKFLOW_STEP_ADVANCED';

    const auditResult = await this.audit.write({
      eventType,
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: workflowRunId,
      resourceType: 'TaskWorkflowRun',
      outcome: 'ALLOWED',
      metadata: { taskId: run.taskId, stepRunId, completedStep: stepRun.stepOrder, workflowStatus: newStatus },
    });
    if (!auditResult.ok) return auditResult;

    if (task) {
      await this.timeline.append({
        caseId: task.caseId,
        taskId: run.taskId,
        eventType,
        actorId,
        actorType: 'OPERATOR',
        note: newStatus === 'COMPLETED'
          ? `Workflow completed (step ${stepRun.stepOrder} was final step)`
          : `Step ${stepRun.stepOrder} completed — next step: ${nextStepOrder ?? 'none'}`,
      });
    }

    return this._buildWorkflowState(updatedRun);
  }

  async blockStep(
    workflowRunId: string,
    stepRunId: string,
    input: BlockStepInput,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafeWorkflowState, ErrorCode>> {
    const run = await this.runRepo.findById(workflowRunId);
    if (!run) return err('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${workflowRunId} not found`);

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      return err('WORKFLOW_INVALID_TRANSITION', `Workflow run is in terminal status "${run.status}"`);
    }

    const stepRun = await this.runRepo.findStepRunById(stepRunId);
    if (!stepRun || stepRun.workflowRunId !== workflowRunId) {
      return err('WORKFLOW_STEP_NOT_FOUND', `Step run ${stepRunId} not found in run ${workflowRunId}`);
    }

    if (['COMPLETED', 'SKIPPED', 'FAILED', 'BLOCKED'].includes(stepRun.status)) {
      return err('WORKFLOW_INVALID_TRANSITION', `Cannot block step in status "${stepRun.status}"`);
    }

    const reasonViolation = checkText(input.reason);
    if (reasonViolation) return err('WORKFLOW_UNSAFE_TEXT', `reason rejected: ${reasonViolation}`);

    await this.runRepo.updateStepStatus(stepRunId, {
      status: 'BLOCKED',
      operatorNotes: input.reason,
    });

    const updatedRun = await this.runRepo.updateRunStatus(workflowRunId, { status: 'BLOCKED' });

    const task = await this.taskRepo.findById(run.taskId);

    const auditResult = await this.audit.write({
      eventType: 'WORKFLOW_STEP_BLOCKED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: workflowRunId,
      resourceType: 'TaskWorkflowRun',
      outcome: 'BLOCKED',
      metadata: { taskId: run.taskId, stepRunId, stepOrder: stepRun.stepOrder },
    });
    if (!auditResult.ok) return auditResult;

    if (task) {
      await this.timeline.append({
        caseId: task.caseId,
        taskId: run.taskId,
        eventType: 'WORKFLOW_STEP_BLOCKED',
        actorId,
        actorType: 'OPERATOR',
        note: `Step ${stepRun.stepOrder} blocked`,
      });
    }

    return this._buildWorkflowState(updatedRun);
  }

  async attachManualSubmission(
    workflowRunId: string,
    stepRunId: string,
    input: AttachManualSubmissionInput,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafeWorkflowState, ErrorCode>> {
    const run = await this.runRepo.findById(workflowRunId);
    if (!run) return err('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${workflowRunId} not found`);

    const stepRun = await this.runRepo.findStepRunById(stepRunId);
    if (!stepRun || stepRun.workflowRunId !== workflowRunId) {
      return err('WORKFLOW_STEP_NOT_FOUND', `Step run ${stepRunId} not found in run ${workflowRunId}`);
    }

    if (!SUBMISSION_LINKABLE_KINDS.includes(stepRun.stepKind)) {
      return err(
        'WORKFLOW_INVALID_TRANSITION',
        `Cannot link a manual submission to a step of kind "${stepRun.stepKind}" — allowed: ${SUBMISSION_LINKABLE_KINDS.join(', ')}`,
      );
    }

    await this.runRepo.attachManualSubmission(stepRunId, input.manualSubmissionId);

    const task = await this.taskRepo.findById(run.taskId);

    const auditResult = await this.audit.write({
      eventType: 'WORKFLOW_MANUAL_SUBMISSION_LINKED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: workflowRunId,
      resourceType: 'TaskWorkflowRun',
      outcome: 'ALLOWED',
      metadata: { taskId: run.taskId, stepRunId, manualSubmissionId: input.manualSubmissionId },
    });
    if (!auditResult.ok) return auditResult;

    if (task) {
      await this.timeline.append({
        caseId: task.caseId,
        taskId: run.taskId,
        eventType: 'WORKFLOW_MANUAL_SUBMISSION_LINKED',
        actorId,
        actorType: 'OPERATOR',
        note: `Manual submission linked to step ${stepRun.stepOrder}`,
      });
    }

    const updatedRun = await this.runRepo.findById(workflowRunId);
    return this._buildWorkflowState(updatedRun!);
  }

  async getWorkflowState(workflowRunId: string): Promise<Result<SafeWorkflowState, ErrorCode>> {
    const run = await this.runRepo.findById(workflowRunId);
    if (!run) return err('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${workflowRunId} not found`);
    return this._buildWorkflowState(run);
  }

  async getWorkflowStateByTaskId(taskId: string): Promise<Result<SafeWorkflowState, ErrorCode>> {
    const run = await this.runRepo.findActiveByTaskId(taskId);
    const resolved = run ?? (await this.runRepo.findLatestByTaskId(taskId));
    if (!resolved) return err('WORKFLOW_RUN_NOT_FOUND', `No workflow run found for task ${taskId}`);
    return this._buildWorkflowState(resolved);
  }

  async listPlaybooks(): Promise<SafePlaybook[]> {
    const playbooks = await this.playbookRepo.listActive();
    return playbooks.map(toSafePlaybook);
  }

  async getPlaybook(playbookId: string): Promise<Result<SafePlaybookWithSteps, ErrorCode>> {
    const playbook = await this.playbookRepo.findByIdWithSteps(playbookId);
    if (!playbook) return err('PLAYBOOK_NOT_FOUND', `Playbook ${playbookId} not found`);
    return ok(toSafePlaybookWithSteps(playbook));
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _buildWorkflowState(run: TaskWorkflowRun): Promise<Result<SafeWorkflowState, ErrorCode>> {
    const stepRuns = await this.runRepo.listStepRunsForRun(run.id);
    const playbook = await this.playbookRepo.findByIdWithSteps(run.playbookId);
    if (!playbook) return err('PLAYBOOK_NOT_FOUND', `Playbook ${run.playbookId} not found`);

    const stepMap = new Map(playbook.steps.map((s) => [s.id, s]));
    const safeSteps = stepRuns.map((sr) => {
      const ps = stepMap.get(sr.playbookStepId);
      if (!ps) {
        // Defensive: playbook step deleted after run was created
        return mergeStepRunWithPlaybookStep(sr, {
          id: sr.playbookStepId,
          playbookId: run.playbookId,
          stepOrder: sr.stepOrder,
          stepKind: sr.stepKind,
          title: '(removed)',
          instructions: '(removed)',
          requiresApproval: false,
          requiresManualSubmission: false,
          requiredEvidenceType: null,
          createdAt: sr.createdAt,
          updatedAt: sr.updatedAt,
        });
      }
      return mergeStepRunWithPlaybookStep(sr, ps);
    });

    return ok({ run: toSafeRun(run), steps: safeSteps });
  }
}
