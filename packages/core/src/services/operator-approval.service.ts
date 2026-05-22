import type {
  OperatorApprovalRepository,
  ApprovalRequestRepository,
  ApprovalPayloadSnapshotRepository,
} from '@celator/db';
import type { OperatorApproval } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { CaseTimelineService } from './case-timeline.service.js';
import type { CleanupTaskService } from './cleanup-task.service.js';

export interface RecordDecisionInput {
  approvalRequestId: string;
  operatorId: string;
  operatorOrganizationId: string;
  decision: 'APPROVED' | 'REJECTED' | 'ESCALATED' | 'NEEDS_MORE_EVIDENCE';
  mfaFreshAt: Date;
  sessionApprovalCount: number;
  reviewStartedAt?: Date;
  notes?: string;
}

export class OperatorApprovalService {
  constructor(
    private readonly approvalRepo: OperatorApprovalRepository,
    private readonly requestRepo: ApprovalRequestRepository,
    private readonly snapshotRepo: ApprovalPayloadSnapshotRepository,
    private readonly taskService: CleanupTaskService,
    private readonly audit: AuditService,
    private readonly timeline: CaseTimelineService,
  ) {}

  async recordDecision(
    input: RecordDecisionInput,
    clientId: string,
  ): Promise<Result<OperatorApproval, ErrorCode>> {
    const request = await this.requestRepo.findById(input.approvalRequestId);
    if (!request) return err('NOT_FOUND', `Approval request ${input.approvalRequestId} not found`);
    if (request.status !== 'PENDING') {
      return err('VALIDATION_ERROR', `Approval request is in status "${request.status}", not PENDING`);
    }
    const now = new Date();
    if (request.expiresAt < now) {
      return err('VALIDATION_ERROR', 'Approval request has expired');
    }

    const snapshot = await this.snapshotRepo.findById(request.snapshotId);
    if (!snapshot) return err('SNAPSHOT_NOT_FOUND', `Snapshot ${request.snapshotId} not found`);
    if (snapshot.snapshotStatus !== 'ACTIVE') {
      return err('SNAPSHOT_INVALID', `Snapshot is in status "${snapshot.snapshotStatus}", cannot approve`);
    }

    const approval = await this.approvalRepo.create({
      approvalRequest: { connect: { id: input.approvalRequestId } },
      snapshot: { connect: { id: request.snapshotId } },
      operator: { connect: { id: input.operatorId } },
      decision: input.decision,
      mfaFreshAt: input.mfaFreshAt,
      sessionApprovalCount: input.sessionApprovalCount,
      reviewStartedAt: input.reviewStartedAt ?? null,
      approvedAt: now,
      notes: input.notes ?? null,
    });

    // Update request status based on decision
    const requestStatus =
      input.decision === 'APPROVED' ? 'APPROVED' :
      input.decision === 'REJECTED' ? 'REJECTED' : 'PENDING';
    await this.requestRepo.updateStatus(input.approvalRequestId, requestStatus);

    // Update snapshot status on final decisions
    if (input.decision === 'APPROVED') {
      await this.snapshotRepo.updateStatus(request.snapshotId, 'USED');
    } else if (input.decision === 'REJECTED') {
      await this.snapshotRepo.updateStatus(request.snapshotId, 'INVALIDATED', 'Rejected by operator');
    }

    // Drive task status transition
    if (input.decision === 'APPROVED') {
      await this.taskService.transition(request.taskId, 'OPERATOR_APPROVED', clientId, input.operatorId, input.notes);
    } else if (input.decision === 'REJECTED') {
      await this.taskService.transition(request.taskId, 'OPERATOR_REJECTED', clientId, input.operatorId, input.notes);
    } else if (input.decision === 'ESCALATED') {
      await this.taskService.transition(request.taskId, 'ESCALATED', clientId, input.operatorId, input.notes);
    }

    const auditResult = await this.audit.write({
      eventType: 'OPERATOR_DECISION_RECORDED',
      actorId: input.operatorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: input.approvalRequestId,
      resourceType: 'ApprovalRequest',
      outcome: 'ALLOWED',
      metadata: {
        decision: input.decision,
        sessionApprovalCount: input.sessionApprovalCount,
        taskId: request.taskId,
      },
    });
    if (!auditResult.ok) return auditResult;

    return ok(approval);
  }

  async getByRequest(approvalRequestId: string): Promise<OperatorApproval | null> {
    return this.approvalRepo.findByApprovalRequest(approvalRequestId);
  }

  async listByOperator(operatorId: string, limit = 50): Promise<OperatorApproval[]> {
    return this.approvalRepo.listByOperator(operatorId, limit);
  }
}
