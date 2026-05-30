import type {
  ClientIntakeSessionRepository,
  ClientIntakeStatus,
  CleanupCaseRepository,
  CleanupTaskRepository,
  TaskWorkflowRunRepository,
  RemovalRequestPacketRepository,
  FollowUpReminderRepository,
  EmergencyPauseRepository,
} from '@celator/db';
import type { ClientIntakeSession } from '@celator/db';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';

// ─── Terminal statuses ────────────────────────────────────────────────────────
const TERMINAL_INTAKE_STATUSES: ClientIntakeStatus[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

// ─── Valid state transitions ──────────────────────────────────────────────────
const VALID_TRANSITIONS: Record<ClientIntakeStatus, ClientIntakeStatus[]> = {
  STARTED:           ['CONTACT_CAPTURED', 'CONSENT_PENDING', 'IDENTITY_PENDING', 'CANCELLED', 'EXPIRED'],
  CONTACT_CAPTURED:  ['CONSENT_PENDING', 'IDENTITY_PENDING', 'CANCELLED', 'EXPIRED'],
  CONSENT_PENDING:   ['IDENTITY_PENDING', 'READY_FOR_REVIEW', 'CANCELLED', 'EXPIRED'],
  IDENTITY_PENDING:  ['READY_FOR_REVIEW', 'CANCELLED', 'EXPIRED'],
  READY_FOR_REVIEW:  ['COMPLETED', 'CANCELLED'],
  COMPLETED:         [],
  CANCELLED:         [],
  EXPIRED:           [],
};

// ─── Input/output types ───────────────────────────────────────────────────────

export interface CreateIntakeSessionInput {
  orgId: string;
  requestedActionTypes?: string[];
  requestedSourceTypes?: string[];
  expiresAt?: Date;
  safeContactRef?: string;
}

export interface SafeIntakeSession {
  id: string;
  clientId: string | null;
  orgId: string;
  status: string;
  safeContactRef: string | null;
  requestedActionTypes: string[];
  requestedSourceTypes: string[];
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
}

export interface SafeClientPortalSummary {
  clientId: string;
  totalCases: number;
  openCases: number;
  completedCases: number;
  totalTasks: number;
  completedTasks: number;
  workflowsInProgress: number;
  packetsReady: number;
  followUpsPending: number;
  hasActivePauseBlock: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSafe(s: ClientIntakeSession): SafeIntakeSession {
  return {
    id: s.id,
    clientId: s.clientId,
    orgId: s.orgId,
    status: s.status,
    safeContactRef: s.safeContactRef,
    requestedActionTypes: s.requestedActionTypes,
    requestedSourceTypes: s.requestedSourceTypes,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    completedAt: s.completedAt,
    expiresAt: s.expiresAt,
  };
}

const COMPLETED_TASK_STATUSES = ['VERIFIED_REMOVED', 'FALSE_POSITIVE', 'SKIPPED'];

// ─── Service ─────────────────────────────────────────────────────────────────

export class ClientIntakeService {
  constructor(
    private readonly repo: ClientIntakeSessionRepository,
    private readonly caseRepo: CleanupCaseRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly workflowRunRepo: TaskWorkflowRunRepository,
    private readonly packetRepo: RemovalRequestPacketRepository,
    private readonly followUpRepo: FollowUpReminderRepository,
    private readonly emergencyPauseRepo: EmergencyPauseRepository,
    private readonly audit: AuditService,
  ) {}

  private validateTransition(current: ClientIntakeStatus, next: ClientIntakeStatus): boolean {
    return VALID_TRANSITIONS[current].includes(next);
  }

  async createSession(
    input: CreateIntakeSessionInput,
    actorId: string,
  ): Promise<Result<SafeIntakeSession, ErrorCode>> {
    if (input.safeContactRef !== undefined) {
      const v = checkRedactedPreview(input.safeContactRef);
      if (v) return err('VALIDATION_ERROR', `safeContactRef rejected: ${v}`);
    }

    const session = await this.repo.create({
      organization: { connect: { id: input.orgId } },
      ...(input.requestedActionTypes !== undefined ? { requestedActionTypes: input.requestedActionTypes } : {}),
      ...(input.requestedSourceTypes !== undefined ? { requestedSourceTypes: input.requestedSourceTypes } : {}),
      ...(input.safeContactRef !== undefined ? { safeContactRef: input.safeContactRef } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });

    const auditResult = await this.audit.write({
      eventType: 'INTAKE_SESSION_CREATED',
      actorId,
      actorType: 'OPERATOR',
      resourceId: session.id,
      resourceType: 'ClientIntakeSession',
      outcome: 'ALLOWED',
      metadata: { orgId: input.orgId, status: 'STARTED' },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(session));
  }

  async linkClient(
    sessionId: string,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafeIntakeSession, ErrorCode>> {
    const session = await this.repo.findById(sessionId);
    if (!session) return err('INTAKE_SESSION_NOT_FOUND', `Session ${sessionId} not found`);

    if (TERMINAL_INTAKE_STATUSES.includes(session.status as ClientIntakeStatus)) {
      return err('INTAKE_INVALID_STATUS', `Cannot modify a ${session.status} session`);
    }

    if (session.clientId && session.clientId !== clientId) {
      return err('VALIDATION_ERROR', 'Session already linked to a different client');
    }

    const updated = await this.repo.update(sessionId, { client: { connect: { id: clientId } } });

    const auditResult = await this.audit.write({
      eventType: 'INTAKE_SESSION_CLIENT_LINKED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: sessionId,
      resourceType: 'ClientIntakeSession',
      outcome: 'ALLOWED',
      metadata: { sessionId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async updateRequestedScope(
    sessionId: string,
    input: { requestedActionTypes?: string[]; requestedSourceTypes?: string[] },
    actorId: string,
  ): Promise<Result<SafeIntakeSession, ErrorCode>> {
    const session = await this.repo.findById(sessionId);
    if (!session) return err('INTAKE_SESSION_NOT_FOUND', `Session ${sessionId} not found`);

    if (TERMINAL_INTAKE_STATUSES.includes(session.status as ClientIntakeStatus)) {
      return err('INTAKE_INVALID_STATUS', `Cannot modify a ${session.status} session`);
    }

    const updated = await this.repo.update(sessionId, {
      ...(input.requestedActionTypes !== undefined ? { requestedActionTypes: input.requestedActionTypes } : {}),
      ...(input.requestedSourceTypes !== undefined ? { requestedSourceTypes: input.requestedSourceTypes } : {}),
    });

    const auditResult = await this.audit.write({
      eventType: 'INTAKE_SESSION_SCOPE_UPDATED',
      actorId,
      actorType: 'OPERATOR',
      resourceId: sessionId,
      resourceType: 'ClientIntakeSession',
      outcome: 'ALLOWED',
      metadata: { sessionId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  private async _transition(
    sessionId: string,
    targetStatus: ClientIntakeStatus,
    eventType: string,
    actorId: string,
    extra?: { completedAt?: Date },
  ): Promise<Result<SafeIntakeSession, ErrorCode>> {
    const session = await this.repo.findById(sessionId);
    if (!session) return err('INTAKE_SESSION_NOT_FOUND', `Session ${sessionId} not found`);

    if (!this.validateTransition(session.status as ClientIntakeStatus, targetStatus)) {
      return err('INTAKE_INVALID_STATUS', `Cannot transition from ${session.status} to ${targetStatus}`);
    }

    const updated = await this.repo.updateStatus(sessionId, targetStatus, extra);

    const auditResult = await this.audit.write({
      eventType,
      actorId,
      actorType: 'OPERATOR',
      resourceId: sessionId,
      resourceType: 'ClientIntakeSession',
      outcome: 'ALLOWED',
      metadata: { sessionId, fromStatus: session.status, toStatus: targetStatus },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async markConsentPending(sessionId: string, actorId: string): Promise<Result<SafeIntakeSession, ErrorCode>> {
    return this._transition(sessionId, 'CONSENT_PENDING', 'INTAKE_SESSION_CONSENT_PENDING', actorId);
  }

  async markIdentityPending(sessionId: string, actorId: string): Promise<Result<SafeIntakeSession, ErrorCode>> {
    return this._transition(sessionId, 'IDENTITY_PENDING', 'INTAKE_SESSION_IDENTITY_PENDING', actorId);
  }

  async markReadyForReview(sessionId: string, actorId: string): Promise<Result<SafeIntakeSession, ErrorCode>> {
    return this._transition(sessionId, 'READY_FOR_REVIEW', 'INTAKE_SESSION_READY_FOR_REVIEW', actorId);
  }

  async completeSession(sessionId: string, actorId: string): Promise<Result<SafeIntakeSession, ErrorCode>> {
    return this._transition(sessionId, 'COMPLETED', 'INTAKE_SESSION_COMPLETED', actorId, { completedAt: new Date() });
  }

  async cancelSession(sessionId: string, actorId: string): Promise<Result<SafeIntakeSession, ErrorCode>> {
    return this._transition(sessionId, 'CANCELLED', 'INTAKE_SESSION_CANCELLED', actorId);
  }

  async getSafeSession(sessionId: string): Promise<Result<SafeIntakeSession, ErrorCode>> {
    const session = await this.repo.findById(sessionId);
    if (!session) return err('INTAKE_SESSION_NOT_FOUND', `Session ${sessionId} not found`);
    return ok(toSafe(session));
  }

  async listSessionsForOrg(orgId: string): Promise<SafeIntakeSession[]> {
    const sessions = await this.repo.listForOrg(orgId);
    return sessions.map(toSafe);
  }

  async getClientPortalSummary(
    clientId: string,
  ): Promise<Result<SafeClientPortalSummary, ErrorCode>> {
    const cases = await this.caseRepo.listForClient(clientId, true);
    const openCases = cases.filter((c) => !c.closedAt).length;
    const completedCases = cases.filter((c) => !!c.closedAt).length;

    const tasks = await this.taskRepo.listForClientId(clientId);
    const completedTasks = tasks.filter((t) => COMPLETED_TASK_STATUSES.includes(t.status)).length;

    const runs = await this.workflowRunRepo.listForClient(clientId);
    const workflowsInProgress = runs.filter((r) => r.status === 'IN_PROGRESS').length;

    const packets = await this.packetRepo.listForClient(clientId);
    const packetsReady = packets.filter((p) => p.status === 'READY').length;

    const followUps = await this.followUpRepo.listForClient(clientId);
    const followUpsPending = followUps.filter((f) => f.status === 'PENDING' || f.status === 'DUE').length;

    const globalPause = await this.emergencyPauseRepo.findActiveGlobal();
    const clientPause = await this.emergencyPauseRepo.findActiveForScope('CLIENT', clientId);
    const hasActivePauseBlock = !!(globalPause || clientPause);

    return ok({
      clientId,
      totalCases: cases.length,
      openCases,
      completedCases,
      totalTasks: tasks.length,
      completedTasks,
      workflowsInProgress,
      packetsReady,
      followUpsPending,
      hasActivePauseBlock,
    });
  }
}
