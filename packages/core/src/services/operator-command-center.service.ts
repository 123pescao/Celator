import type {
  ClientRepository,
  CleanupCaseRepository,
  CleanupTaskRepository,
  TaskWorkflowRunRepository,
  RemovalRequestPacketRepository,
  FollowUpReminderRepository,
  EvidenceRecordRepository,
  ManualRemovalSubmissionRepository,
  CaseTimelineRepository,
} from '@celator/db';
import type { TaskStatus } from '@celator/db';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { SafeFollowUp } from './follow-up-reminder.service.js';
import type { SafePacketHeader } from './removal-request-packet.service.js';

// ─── Output types ─────────────────────────────────────────────────────────────

export interface DashboardOverview {
  totalClients: number;
  activeCases: number;
  openTasks: number;
  workflowsInProgress: number;
  workflowsBlocked: number;
  packetsReady: number;
  followUpsDue: number;
  evidenceRecords: number;
  manualSubmissionsPending: number;
  manualSubmissionsCompleted: number;
}

export interface WorkQueueItem {
  id: string;
  caseId: string;
  clientId: string;
  status: string;
  actionType: string | null;
  riskTier: string;
  // sourceRef validated below — PII-gated at read time
  sourceRef: string | null;
}

export interface ClientProgress {
  clientId: string;
  totalCases: number;
  openCases: number;
  totalTasks: number;
  completedTasks: number;
  openTasks: number;
  workflowsInProgress: number;
  packetsReady: number;
  followUpsPending: number;
}

export interface CaseProgress {
  caseId: string;
  clientId: string;
  taskCountByStatus: Record<string, number>;
  totalTasks: number;
}

export interface TaskProgress {
  taskId: string;
  caseId: string;
  workflowRunCount: number;
  evidenceCount: number;
  packetCount: number;
  followUpCount: number;
}

export interface SafeTimelineEntry {
  id: string;
  caseId: string;
  taskId: string | null;
  eventType: string;
  actorType: string;
  note: string | null;
  createdAt: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const OPEN_TASK_STATUSES: TaskStatus[] = [
  'FOUND', 'CLASSIFIED', 'MATCH_REVIEW_REQUIRED', 'CLIENT_CONFIRMATION_REQUIRED',
  'READY_FOR_OPERATOR_REVIEW', 'OPERATOR_APPROVED', 'READY_TO_SUBMIT', 'SUBMITTED',
  'DELIVERED', 'MORE_INFO_REQUESTED', 'WAITING_VERIFICATION', 'PARTIALLY_REMOVED',
  'NEEDS_OPERATOR_REVIEW', 'PAUSED_BY_SYSTEM', 'MANUAL_ONLY', 'ESCALATED', 'REAPPEARED',
];

const COMPLETED_TASK_STATUSES: TaskStatus[] = ['VERIFIED_REMOVED', 'FALSE_POSITIVE', 'SKIPPED'];

function safeSourceRef(ref: string | null): string | null {
  if (!ref) return null;
  const violation = checkRedactedPreview(ref);
  return violation ? '[REDACTED]' : ref;
}

function toSafeTimeline(e: {
  id: string; caseId: string; taskId: string | null; eventType: string;
  actorType: string; note: string | null; createdAt: Date;
}): SafeTimelineEntry {
  return { id: e.id, caseId: e.caseId, taskId: e.taskId, eventType: e.eventType, actorType: e.actorType, note: e.note, createdAt: e.createdAt };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class OperatorCommandCenterService {
  constructor(
    private readonly clientRepo: ClientRepository,
    private readonly caseRepo: CleanupCaseRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly workflowRunRepo: TaskWorkflowRunRepository,
    private readonly packetRepo: RemovalRequestPacketRepository,
    private readonly followUpRepo: FollowUpReminderRepository,
    private readonly evidenceRepo: EvidenceRecordRepository,
    private readonly manualSubmissionRepo: ManualRemovalSubmissionRepository,
    private readonly timelineRepo: CaseTimelineRepository,
  ) {}

  // TODO: For production, scope all unfiltered queries to actor.organizationId.
  // Currently the dev actor pattern means all data is accessible within the service boundary.
  async getDashboardOverview(
    filter: { orgId?: string; clientId?: string },
  ): Promise<DashboardOverview> {
    // Require at least clientId or orgId — unbounded cross-org query is blocked.
    // TODO: For production, derive default scope from actor.organizationId.
    if (!filter.clientId && !filter.orgId) {
      return {
        totalClients: 0, activeCases: 0, openTasks: 0,
        workflowsInProgress: 0, workflowsBlocked: 0, packetsReady: 0,
        followUpsDue: 0, evidenceRecords: 0,
        manualSubmissionsPending: 0, manualSubmissionsCompleted: 0,
      };
    }

    const clients = filter.clientId
      ? [{ id: filter.clientId }]
      : await this.clientRepo.listByOrg(filter.orgId!);

    const clientIds = clients.map((c) => c.id);

    // Aggregate across selected clients
    let activeCases = 0;
    let openTasks = 0;
    let workflowsInProgress = 0;
    let workflowsBlocked = 0;
    let packetsReady = 0;
    let followUpsDue = 0;
    let evidenceRecords = 0;
    let manualSubmissionsPending = 0;
    let manualSubmissionsCompleted = 0;

    const now = new Date();

    for (const clientId of clientIds) {
      const cases = await this.caseRepo.listForClient(clientId, false);
      activeCases += cases.length;

      const tasks = await this.taskRepo.listForClientId(clientId);
      openTasks += tasks.filter((t) => OPEN_TASK_STATUSES.includes(t.status)).length;

      const runs = await this.workflowRunRepo.listForClient(clientId);
      workflowsInProgress += runs.filter((r) => r.status === 'IN_PROGRESS').length;
      workflowsBlocked += runs.filter((r) => r.status === 'BLOCKED').length;

      const packets = await this.packetRepo.listForClient(clientId);
      packetsReady += packets.filter((p) => p.status === 'READY').length;

      const dueFollowUps = await this.followUpRepo.listDueAsOf(now, clientId);
      followUpsDue += dueFollowUps.length;

      const evidence = await this.evidenceRepo.listForClient(clientId);
      evidenceRecords += evidence.length;

      const submissions = await this.manualSubmissionRepo.listForClient(clientId);
      manualSubmissionsPending += submissions.filter((s) => s.submissionStatus === 'DRAFTED' || s.submissionStatus === 'READY_FOR_MANUAL_SUBMISSION').length;
      manualSubmissionsCompleted += submissions.filter((s) => s.submissionStatus === 'SUBMITTED' || s.submissionStatus === 'COMPLETED').length;
    }

    return {
      totalClients: clientIds.length,
      activeCases,
      openTasks,
      workflowsInProgress,
      workflowsBlocked,
      packetsReady,
      followUpsDue,
      evidenceRecords,
      manualSubmissionsPending,
      manualSubmissionsCompleted,
    };
  }

  async listWorkQueue(
    filter: { orgId?: string; clientId?: string; statusFilter?: string; limit?: number },
  ): Promise<WorkQueueItem[]> {
    const status = filter.statusFilter as TaskStatus | undefined;
    let tasks: Awaited<ReturnType<CleanupTaskRepository['listForClientId']>> = [];

    if (filter.clientId) {
      tasks = await this.taskRepo.listForClientId(filter.clientId, status);
    } else if (filter.orgId) {
      const clients = await this.clientRepo.listByOrg(filter.orgId);
      for (const c of clients) {
        const t = await this.taskRepo.listForClientId(c.id, status);
        tasks.push(...t);
      }
    }
    // If neither orgId nor clientId: return empty to prevent unbounded cross-org enumeration.
    // TODO: For production, scope to actor.organizationId.

    const items: WorkQueueItem[] = tasks.map((t) => ({
      id: t.id,
      caseId: t.caseId,
      clientId: '', // not emitted for queue items — use getClientProgress for client-scoped view
      status: t.status,
      actionType: t.actionType,
      riskTier: t.riskTier,
      sourceRef: safeSourceRef(t.sourceRef ?? null),
    }));

    const limited = filter.limit ? items.slice(0, filter.limit) : items;
    return limited;
  }

  async listDueFollowUps(
    filter: { clientId: string; asOf?: Date; limit?: number },
  ): Promise<SafeFollowUp[]> {
    const asOf = filter.asOf ?? new Date();
    const results = await this.followUpRepo.listDueAsOf(asOf, filter.clientId);
    const mapped: SafeFollowUp[] = results.map((f) => ({
      id: f.id,
      taskId: f.taskId,
      clientId: f.clientId,
      status: f.status,
      dueAt: f.dueAt,
      safeNote: f.safeNote,
      completedAt: f.completedAt,
      cancelledAt: f.cancelledAt,
      createdByUserId: f.createdByUserId,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));
    return filter.limit ? mapped.slice(0, filter.limit) : mapped;
  }

  async listBlockedWorkflows(
    filter: { clientId?: string; limit?: number },
  ): Promise<Array<{ id: string; taskId: string; clientId: string; status: string; currentStepOrder: number | null; startedAt: Date | null }>> {
    if (!filter.clientId) return [];
    const runs = await this.workflowRunRepo.listForClient(filter.clientId);
    const blocked = runs.filter((r) => r.status === 'BLOCKED');
    const safe = blocked.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      clientId: r.clientId,
      status: r.status,
      currentStepOrder: r.currentStepOrder,
      startedAt: r.startedAt,
    }));
    return filter.limit ? safe.slice(0, filter.limit) : safe;
  }

  async listReadyPackets(
    filter: { clientId?: string; limit?: number },
  ): Promise<SafePacketHeader[]> {
    if (!filter.clientId) return [];
    const packets = await this.packetRepo.listForClient(filter.clientId);
    const ready = packets.filter((p) => p.status === 'READY');
    const safe: SafePacketHeader[] = ready.map((p) => ({
      id: p.id,
      taskId: p.taskId,
      clientId: p.clientId,
      dataSourceTargetId: p.dataSourceTargetId,
      status: p.status,
      redactedSummary: p.redactedSummary,
      preparedByUserId: p.preparedByUserId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
    return filter.limit ? safe.slice(0, filter.limit) : safe;
  }

  async getClientProgress(
    clientId: string,
  ): Promise<Result<ClientProgress, ErrorCode>> {
    const client = await this.clientRepo.findById(clientId);
    if (!client) return err('CLIENT_NOT_FOUND', `Client ${clientId} not found`);

    const cases = await this.caseRepo.listForClient(clientId, true);
    const openCases = cases.filter((c) => !c.closedAt).length;

    const tasks = await this.taskRepo.listForClientId(clientId);
    const completedTasks = tasks.filter((t) => COMPLETED_TASK_STATUSES.includes(t.status)).length;
    const openTasks = tasks.filter((t) => OPEN_TASK_STATUSES.includes(t.status)).length;

    const runs = await this.workflowRunRepo.listForClient(clientId);
    const workflowsInProgress = runs.filter((r) => r.status === 'IN_PROGRESS').length;

    const packets = await this.packetRepo.listForClient(clientId);
    const packetsReady = packets.filter((p) => p.status === 'READY').length;

    const followUps = await this.followUpRepo.listForClient(clientId);
    const followUpsPending = followUps.filter((f) => f.status === 'PENDING' || f.status === 'DUE').length;

    return ok({
      clientId,
      totalCases: cases.length,
      openCases,
      totalTasks: tasks.length,
      completedTasks,
      openTasks,
      workflowsInProgress,
      packetsReady,
      followUpsPending,
    });
  }

  async getCaseProgress(
    caseId: string,
    clientId: string,
  ): Promise<Result<CaseProgress, ErrorCode>> {
    const caseRecord = await this.caseRepo.findById(caseId);
    if (!caseRecord) return err('NOT_FOUND', `Case ${caseId} not found`);
    if (caseRecord.clientId !== clientId) {
      return err('FORBIDDEN', 'Access denied — case belongs to a different client');
    }

    const tasks = await this.taskRepo.listForCase(caseId);
    const countByStatus: Record<string, number> = {};
    for (const t of tasks) {
      countByStatus[t.status] = (countByStatus[t.status] ?? 0) + 1;
    }

    return ok({
      caseId,
      clientId,
      taskCountByStatus: countByStatus,
      totalTasks: tasks.length,
    });
  }

  async getTaskProgress(
    taskId: string,
    clientId: string,
  ): Promise<Result<TaskProgress, ErrorCode>> {
    const task = await this.taskRepo.findById(taskId);
    if (!task) return err('NOT_FOUND', `Task ${taskId} not found`);

    const caseRecord = await this.caseRepo.findById(task.caseId);
    if (!caseRecord) return err('NOT_FOUND', `Parent case for task ${taskId} not found`);
    if (caseRecord.clientId !== clientId) {
      return err('FORBIDDEN', 'Access denied — task belongs to a different client');
    }

    const [runs, packets, followUps, evidence] = await Promise.all([
      this.workflowRunRepo.listForClient(clientId).then((r) => r.filter((x) => x.taskId === taskId)),
      this.packetRepo.listForTask(taskId),
      this.followUpRepo.listForTask(taskId),
      this.evidenceRepo.listForTask(taskId),
    ]);

    return ok({
      taskId,
      caseId: task.caseId,
      workflowRunCount: runs.length,
      evidenceCount: evidence.length,
      packetCount: packets.length,
      followUpCount: followUps.length,
    });
  }

  async getRecentActivity(
    filter: { clientId?: string; caseId?: string; limit?: number },
  ): Promise<SafeTimelineEntry[]> {
    const limit = filter.limit ?? 50;

    let events: Array<{ id: string; caseId: string; taskId: string | null; eventType: string; actorType: string; note: string | null; createdAt: Date }> = [];

    if (filter.caseId) {
      events = await this.timelineRepo.listForCase(filter.caseId);
    } else if (filter.clientId) {
      events = await this.timelineRepo.listRecentForClient(filter.clientId, limit);
    }

    const limited = events.slice(0, limit);
    return limited.map(toSafeTimeline);
  }
}
