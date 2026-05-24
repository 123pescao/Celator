import type { ManualRemovalSubmissionRepository, DataSourceTargetRepository, CleanupTaskRepository } from '@celator/db';
import type { ManualRemovalSubmission, SubmissionMethod, SubmissionStatus } from '@celator/db';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { CaseTimelineService } from './case-timeline.service.js';

export interface CreateManualSubmissionInput {
  taskId: string;
  clientId: string;
  submissionMethod: SubmissionMethod;
  redactedSummary: string;
  submittedByUserId?: string | undefined;
  operatorNotes?: string | undefined;
}

export interface RecordSubmittedInput {
  confirmationCode?: string | undefined;
  confirmationUrl?: string | undefined;
  operatorNotes?: string | undefined;
}

export interface RecordOutcomeInput {
  status: 'ACKNOWLEDGED' | 'REJECTED' | 'NEEDS_MORE_INFO' | 'COMPLETED' | 'FAILED';
  confirmationCode?: string | undefined;
  confirmationUrl?: string | undefined;
  operatorNotes?: string | undefined;
}

export interface SafeManualSubmission {
  id: string;
  taskId: string;
  dataSourceTargetId: string;
  clientId: string;
  submittedByUserId: string | null;
  submissionMethod: SubmissionMethod;
  submissionStatus: SubmissionStatus;
  submittedAt: Date | null;
  confirmationCode: string | null;
  confirmationUrl: string | null;
  operatorNotes: string | null;
  redactedSummary: string;
  createdAt: Date;
  updatedAt: Date;
}

function toSafe(sub: ManualRemovalSubmission): SafeManualSubmission {
  return {
    id: sub.id,
    taskId: sub.taskId,
    dataSourceTargetId: sub.dataSourceTargetId,
    clientId: sub.clientId,
    submittedByUserId: sub.submittedByUserId,
    submissionMethod: sub.submissionMethod,
    submissionStatus: sub.submissionStatus,
    submittedAt: sub.submittedAt,
    confirmationCode: sub.confirmationCode,
    confirmationUrl: sub.confirmationUrl,
    operatorNotes: sub.operatorNotes,
    redactedSummary: sub.redactedSummary,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

const TERMINAL_STATUSES: SubmissionStatus[] = ['COMPLETED', 'FAILED', 'REJECTED'];
const SUBMITTABLE_STATUSES: SubmissionStatus[] = ['DRAFTED', 'READY_FOR_MANUAL_SUBMISSION'];

export class ManualRemovalSubmissionService {
  constructor(
    private readonly repo: ManualRemovalSubmissionRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly targetRepo: DataSourceTargetRepository,
    private readonly audit: AuditService,
    private readonly timeline: CaseTimelineService,
  ) {}

  async createForTask(
    input: CreateManualSubmissionInput,
    actorId: string,
  ): Promise<Result<SafeManualSubmission, ErrorCode>> {
    const summaryViolation = checkRedactedPreview(input.redactedSummary);
    if (summaryViolation) {
      return err('PII_FORBIDDEN_IN_REDACTED_PREVIEW', `redactedSummary rejected: ${summaryViolation}`);
    }

    if (input.operatorNotes !== undefined) {
      const notesViolation = checkRedactedPreview(input.operatorNotes);
      if (notesViolation) {
        return err('PII_FORBIDDEN_IN_REDACTED_PREVIEW', `operatorNotes rejected: ${notesViolation}`);
      }
    }

    const task = await this.taskRepo.findById(input.taskId);
    if (!task) return err('NOT_FOUND', `Task ${input.taskId} not found`);
    if (!task.dataSourceTargetId) {
      return err('VALIDATION_ERROR', `Task ${input.taskId} has no dataSourceTargetId — link task to a target first`);
    }

    const target = await this.targetRepo.findById(task.dataSourceTargetId);
    if (!target) return err('DATA_SOURCE_TARGET_NOT_FOUND', `DataSourceTarget ${task.dataSourceTargetId} not found`);
    if (!target.isActive) {
      return err('VALIDATION_ERROR', `DataSourceTarget "${target.sourceName}" is not active`);
    }

    const submission = await this.repo.create({
      task: { connect: { id: input.taskId } },
      dataSourceTarget: { connect: { id: task.dataSourceTargetId } },
      client: { connect: { id: input.clientId } },
      submissionMethod: input.submissionMethod,
      submissionStatus: 'DRAFTED',
      redactedSummary: input.redactedSummary,
      ...(input.submittedByUserId !== undefined ? { submittedByUserId: input.submittedByUserId } : {}),
      ...(input.operatorNotes !== undefined ? { operatorNotes: input.operatorNotes } : {}),
    });

    const auditResult = await this.audit.write({
      eventType: 'MANUAL_SUBMISSION_CREATED',
      actorId,
      actorType: 'OPERATOR',
      clientId: input.clientId,
      resourceId: submission.id,
      resourceType: 'ManualRemovalSubmission',
      outcome: 'ALLOWED',
      metadata: {
        taskId: input.taskId,
        dataSourceTargetId: task.dataSourceTargetId,
        submissionMethod: input.submissionMethod,
      },
    });
    if (!auditResult.ok) return auditResult;

    await this.timeline.append({
      caseId: task.caseId,
      taskId: input.taskId,
      eventType: 'MANUAL_SUBMISSION_CREATED',
      actorId,
      actorType: 'OPERATOR',
      note: `Manual submission created via ${input.submissionMethod}`,
    });

    return ok(toSafe(submission));
  }

  async recordSubmitted(
    submissionId: string,
    input: RecordSubmittedInput,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafeManualSubmission, ErrorCode>> {
    const submission = await this.repo.findById(submissionId);
    if (!submission) return err('MANUAL_SUBMISSION_NOT_FOUND', `Submission ${submissionId} not found`);

    if (!SUBMITTABLE_STATUSES.includes(submission.submissionStatus)) {
      return err(
        'MANUAL_SUBMISSION_INVALID_STATUS',
        `Submission is in status "${submission.submissionStatus}" — can only mark submitted from DRAFTED or READY_FOR_MANUAL_SUBMISSION`,
      );
    }

    if (input.operatorNotes !== undefined) {
      const notesViolation = checkRedactedPreview(input.operatorNotes);
      if (notesViolation) {
        return err('PII_FORBIDDEN_IN_REDACTED_PREVIEW', `operatorNotes rejected: ${notesViolation}`);
      }
    }

    const updated = await this.repo.updateSubmitted(submissionId, {
      submittedAt: new Date(),
      ...(input.confirmationCode !== undefined ? { confirmationCode: input.confirmationCode } : {}),
      ...(input.confirmationUrl !== undefined ? { confirmationUrl: input.confirmationUrl } : {}),
      ...(input.operatorNotes !== undefined ? { operatorNotes: input.operatorNotes } : {}),
    });

    const task = await this.taskRepo.findById(submission.taskId);
    const auditResult = await this.audit.write({
      eventType: 'MANUAL_SUBMISSION_SUBMITTED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: submissionId,
      resourceType: 'ManualRemovalSubmission',
      outcome: 'ALLOWED',
      metadata: { taskId: submission.taskId, hasConfirmationCode: input.confirmationCode !== undefined },
    });
    if (!auditResult.ok) return auditResult;

    if (task) {
      await this.timeline.append({
        caseId: task.caseId,
        taskId: task.id,
        eventType: 'MANUAL_SUBMISSION_SUBMITTED',
        actorId,
        actorType: 'OPERATOR',
        note: `Submission marked as submitted`,
      });
    }

    return ok(toSafe(updated));
  }

  async recordOutcome(
    submissionId: string,
    input: RecordOutcomeInput,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafeManualSubmission, ErrorCode>> {
    const submission = await this.repo.findById(submissionId);
    if (!submission) return err('MANUAL_SUBMISSION_NOT_FOUND', `Submission ${submissionId} not found`);

    if (TERMINAL_STATUSES.includes(submission.submissionStatus)) {
      return err(
        'MANUAL_SUBMISSION_INVALID_STATUS',
        `Submission is already in terminal status "${submission.submissionStatus}"`,
      );
    }

    if (input.operatorNotes !== undefined) {
      const notesViolation = checkRedactedPreview(input.operatorNotes);
      if (notesViolation) {
        return err('PII_FORBIDDEN_IN_REDACTED_PREVIEW', `operatorNotes rejected: ${notesViolation}`);
      }
    }

    const updated = await this.repo.updateOutcome(submissionId, {
      status: input.status,
      ...(input.confirmationCode !== undefined ? { confirmationCode: input.confirmationCode } : {}),
      ...(input.confirmationUrl !== undefined ? { confirmationUrl: input.confirmationUrl } : {}),
      ...(input.operatorNotes !== undefined ? { operatorNotes: input.operatorNotes } : {}),
    });

    const task = await this.taskRepo.findById(submission.taskId);
    const auditResult = await this.audit.write({
      eventType: 'MANUAL_SUBMISSION_OUTCOME_RECORDED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: submissionId,
      resourceType: 'ManualRemovalSubmission',
      outcome: 'ALLOWED',
      metadata: { taskId: submission.taskId, outcomeStatus: input.status },
    });
    if (!auditResult.ok) return auditResult;

    if (task) {
      await this.timeline.append({
        caseId: task.caseId,
        taskId: task.id,
        eventType: 'MANUAL_SUBMISSION_OUTCOME_RECORDED',
        actorId,
        actorType: 'OPERATOR',
        note: `Outcome recorded: ${input.status}`,
      });
    }

    return ok(toSafe(updated));
  }

  async getById(id: string): Promise<Result<SafeManualSubmission, ErrorCode>> {
    const submission = await this.repo.findById(id);
    if (!submission) return err('MANUAL_SUBMISSION_NOT_FOUND', `Submission ${id} not found`);
    return ok(toSafe(submission));
  }

  async listForTask(taskId: string): Promise<SafeManualSubmission[]> {
    const records = await this.repo.findByTaskId(taskId);
    return records.map(toSafe);
  }

  async listForClient(clientId: string): Promise<SafeManualSubmission[]> {
    const records = await this.repo.listForClient(clientId);
    return records.map(toSafe);
  }
}
