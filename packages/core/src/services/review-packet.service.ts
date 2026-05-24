import { createHash } from 'node:crypto';
import type {
  ApprovalPayloadSnapshotRepository,
  ApprovalRequestRepository,
  CleanupTaskRepository,
  ClientAuthorizationRepository,
} from '@celator/db';
import type { ApprovalRequest } from '@celator/db';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { CaseTimelineService } from './case-timeline.service.js';

export interface CreateReviewPacketInput {
  taskId: string;
  authorizationId: string;
  redactedPreview: string;
  evidenceIds?: string[];
  preparedByUserId?: string;
  expiresInDays?: number;
}

export interface ReviewPacketResult {
  approvalRequest: ApprovalRequest;
  snapshotId: string;
  payloadHash: string;
}

export class ReviewPacketService {
  constructor(
    private readonly snapshotRepo: ApprovalPayloadSnapshotRepository,
    private readonly requestRepo: ApprovalRequestRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly authorizationRepo: ClientAuthorizationRepository,
    private readonly audit: AuditService,
    private readonly timeline: CaseTimelineService,
  ) {}

  async create(
    input: CreateReviewPacketInput,
    clientId: string,
    actorId: string,
  ): Promise<Result<ReviewPacketResult, ErrorCode>> {
    const previewViolation = checkRedactedPreview(input.redactedPreview);
    if (previewViolation) {
      return err('PII_FORBIDDEN_IN_REDACTED_PREVIEW', `redactedPreview rejected: ${previewViolation}`);
    }

    const task = await this.taskRepo.findById(input.taskId);
    if (!task) return err('NOT_FOUND', `Task ${input.taskId} not found`);

    if (task.matchStatus !== 'CONFIRMED_MATCH' && task.matchStatus !== 'CLIENT_CONFIRMED') {
      return err(
        'VALIDATION_ERROR',
        `Task match status is "${task.matchStatus}" — review packet requires CONFIRMED_MATCH or CLIENT_CONFIRMED`,
      );
    }

    const auth = await this.authorizationRepo.findById(input.authorizationId);
    if (!auth) return err('AUTHORIZATION_NOT_FOUND', `Authorization ${input.authorizationId} not found`);
    if (auth.revokedAt) return err('AUTHORIZATION_REVOKED', 'Authorization has been revoked');
    const now = new Date();
    if (auth.expiresAt && auth.expiresAt < now) {
      return err('AUTHORIZATION_EXPIRED', 'Authorization has expired');
    }

    // Cancel any existing pending requests for this task
    await this.requestRepo.cancelPendingForTask(input.taskId);
    // Invalidate any active snapshots
    await this.snapshotRepo.invalidateForTask(input.taskId, 'Superseded by new review packet');

    // Build payload for hashing — no PII, task metadata only
    const payload = {
      taskId: task.id,
      caseId: task.caseId,
      actionType: task.actionType,
      sourceRef: task.sourceRef,
      riskTier: task.riskTier,
      evidenceIds: input.evidenceIds ?? [],
      authorizationId: input.authorizationId,
    };
    const payloadHash = hashPayload(payload);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (input.expiresInDays ?? 14));

    const snapshot = await this.snapshotRepo.create({
      taskId: input.taskId,
      payloadHash,
      snapshotSignature: `sha256:${payloadHash}`, // Phase 1A: sync placeholder; async HMAC in Phase 1B
      signingKeyVersion: 'v1',
      snapshotStatus: 'ACTIVE',
      snapshotExpiresAt: expiresAt,
      riskTier: task.riskTier,
      actionType: task.actionType ?? 'OPT_OUT',
      redactedPreview: input.redactedPreview,
      invalidationReason: null,
    });

    const approvalRequest = await this.requestRepo.create({
      task: { connect: { id: input.taskId } },
      authorization: { connect: { id: input.authorizationId } },
      snapshot: { connect: { id: snapshot.id } },
      status: 'PENDING',
      preparedByUserId: input.preparedByUserId ?? null,
      expiresAt,
    });

    const auditResult = await this.audit.write({
      eventType: 'REVIEW_PACKET_CREATED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: approvalRequest.id,
      resourceType: 'ApprovalRequest',
      outcome: 'ALLOWED',
      metadata: { taskId: input.taskId, snapshotId: snapshot.id, riskTier: task.riskTier },
    });
    if (!auditResult.ok) return auditResult;

    await this.timeline.append({
      caseId: task.caseId,
      taskId: input.taskId,
      eventType: 'REVIEW_PACKET_CREATED',
      actorId,
      actorType: 'OPERATOR',
    });

    return ok({ approvalRequest, snapshotId: snapshot.id, payloadHash });
  }

  async getActivePacket(taskId: string): Promise<Result<{ snapshotId: string; requestId: string; payloadHash: string }, ErrorCode>> {
    const snapshot = await this.snapshotRepo.findActiveForTask(taskId);
    if (!snapshot) return err('SNAPSHOT_NOT_FOUND', `No active snapshot for task ${taskId}`);
    const request = await this.requestRepo.findPendingForTask(taskId);
    if (!request) return err('NOT_FOUND', `No pending approval request for task ${taskId}`);
    return ok({ snapshotId: snapshot.id, requestId: request.id, payloadHash: snapshot.payloadHash });
  }
}

function hashPayload(payload: unknown): string {
  const keys = Object.keys(payload as object).sort();
  const canonical = JSON.stringify(payload, keys);
  return createHash('sha256').update(canonical).digest('hex');
}
