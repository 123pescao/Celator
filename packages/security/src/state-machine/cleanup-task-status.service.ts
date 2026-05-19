/**
 * CleanupTaskStatusService — Celator Phase 0
 *
 * Enforces valid state transitions for CleanupTask status.
 *
 * Rules:
 * - Valid transitions pass and write audit/timeline records.
 * - Invalid transitions throw — never silently succeed.
 * - Task cannot jump directly to SUBMITTED.
 * - Task cannot become READY_TO_SUBMIT without OPERATOR_APPROVED.
 * - Task cannot become VERIFIED_REMOVED directly from SUBMITTED.
 * - PAUSED_BY_SYSTEM and NEEDS_OPERATOR_REVIEW are safe exits from most states.
 */

// =============================================================
// Types
// =============================================================

export type TaskStatus =
  | 'FOUND'
  | 'CLASSIFIED'
  | 'MATCH_REVIEW_REQUIRED'
  | 'CLIENT_CONFIRMATION_REQUIRED'
  | 'READY_FOR_OPERATOR_REVIEW'
  | 'OPERATOR_APPROVED'
  | 'OPERATOR_REJECTED'
  | 'READY_TO_SUBMIT'
  | 'SUBMITTED'
  | 'DELIVERED'
  | 'BROKER_CONFIRMED_RECEIPT'
  | 'BROKER_REJECTED'
  | 'MORE_INFO_REQUESTED'
  | 'WAITING_VERIFICATION'
  | 'VERIFIED_REMOVED'
  | 'PARTIALLY_REMOVED'
  | 'FAILED'
  | 'REAPPEARED'
  | 'MANUAL_ONLY'
  | 'ESCALATED'
  | 'FALSE_POSITIVE'
  | 'SKIPPED'
  | 'NEEDS_OPERATOR_REVIEW'
  | 'BLOCKED_CONSENT_SCOPE'
  | 'PAUSED_BY_SYSTEM';

export interface TransitionActor {
  actorId: string;
  actorType: 'SYSTEM' | 'CLIENT' | 'OPERATOR' | 'ADMIN' | 'SERVICE';
}

export interface TransitionResult {
  taskId: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  actorId: string;
  timelineEventId: string;
  auditEventId: string;
  transitionedAt: Date;
}

export interface TimelineEvent {
  id: string;
  caseId: string;
  taskId: string;
  eventType: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  actorId: string;
  actorType: string;
  createdAt: Date;
}

export interface StateMachineAuditEntry {
  id: string;
  eventType: string;
  actorId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

// =============================================================
// Allowed transitions definition
// =============================================================

/**
 * Safe exits that can be reached from most states.
 * These are not in the main flow but are always valid.
 */
const UNIVERSAL_SAFE_EXITS: TaskStatus[] = [
  'MANUAL_ONLY',
  'FALSE_POSITIVE',
  'SKIPPED',
  'PAUSED_BY_SYSTEM',
  'NEEDS_OPERATOR_REVIEW',
  'BLOCKED_CONSENT_SCOPE',
  'ESCALATED',
];

/**
 * Core happy-path and expected-failure transitions.
 * Format: [fromStatus, toStatus]
 */
const CORE_TRANSITIONS: Array<[TaskStatus, TaskStatus]> = [
  // Discovery and classification
  ['FOUND', 'CLASSIFIED'],
  ['FOUND', 'MATCH_REVIEW_REQUIRED'],

  // Classification routing
  ['CLASSIFIED', 'MATCH_REVIEW_REQUIRED'],
  ['CLASSIFIED', 'READY_FOR_OPERATOR_REVIEW'],
  ['CLASSIFIED', 'CLIENT_CONFIRMATION_REQUIRED'],

  // Match review
  ['MATCH_REVIEW_REQUIRED', 'CLIENT_CONFIRMATION_REQUIRED'],
  ['MATCH_REVIEW_REQUIRED', 'READY_FOR_OPERATOR_REVIEW'],
  ['MATCH_REVIEW_REQUIRED', 'FALSE_POSITIVE'],

  // Client confirmation
  ['CLIENT_CONFIRMATION_REQUIRED', 'READY_FOR_OPERATOR_REVIEW'],

  // Operator review
  ['READY_FOR_OPERATOR_REVIEW', 'OPERATOR_APPROVED'],
  ['READY_FOR_OPERATOR_REVIEW', 'OPERATOR_REJECTED'],
  ['READY_FOR_OPERATOR_REVIEW', 'MORE_INFO_REQUESTED'],

  // Approved -> Ready to submit (the gate)
  ['OPERATOR_APPROVED', 'READY_TO_SUBMIT'],

  // Submission (only from READY_TO_SUBMIT — this is the critical gating point)
  ['READY_TO_SUBMIT', 'SUBMITTED'],

  // Post-submission
  ['SUBMITTED', 'DELIVERED'],
  ['SUBMITTED', 'FAILED'],
  ['SUBMITTED', 'BROKER_REJECTED'],

  // Delivery
  ['DELIVERED', 'BROKER_CONFIRMED_RECEIPT'],
  ['DELIVERED', 'BROKER_REJECTED'],
  ['DELIVERED', 'MORE_INFO_REQUESTED'],

  // After broker confirmation
  ['BROKER_CONFIRMED_RECEIPT', 'WAITING_VERIFICATION'],
  ['BROKER_CONFIRMED_RECEIPT', 'MORE_INFO_REQUESTED'],

  // Broker rejected
  ['BROKER_REJECTED', 'READY_FOR_OPERATOR_REVIEW'],

  // More info requested
  ['MORE_INFO_REQUESTED', 'READY_FOR_OPERATOR_REVIEW'],

  // Verification (VERIFIED_REMOVED requires going through WAITING_VERIFICATION)
  ['WAITING_VERIFICATION', 'VERIFIED_REMOVED'],
  ['WAITING_VERIFICATION', 'PARTIALLY_REMOVED'],
  ['WAITING_VERIFICATION', 'FAILED'],

  // Reappearance — goes back to review
  ['VERIFIED_REMOVED', 'REAPPEARED'],
  ['REAPPEARED', 'READY_FOR_OPERATOR_REVIEW'],
  ['PARTIALLY_REMOVED', 'READY_FOR_OPERATOR_REVIEW'],
  ['PARTIALLY_REMOVED', 'WAITING_VERIFICATION'],

  // Failed / rejected — can be retried or escalated
  ['FAILED', 'READY_FOR_OPERATOR_REVIEW'],
  ['OPERATOR_REJECTED', 'READY_FOR_OPERATOR_REVIEW'],
];

// Build the allowed transitions set
const ALLOWED_TRANSITIONS = new Set<string>();

for (const [from, to] of CORE_TRANSITIONS) {
  ALLOWED_TRANSITIONS.add(`${from}::${to}`);
}

// Universal safe exits from any non-terminal status
const TERMINAL_STATUSES = new Set<TaskStatus>([
  'VERIFIED_REMOVED',
  'FALSE_POSITIVE',
  'SKIPPED',
  'FAILED',
]);

const ALL_STATUSES: TaskStatus[] = [
  'FOUND', 'CLASSIFIED', 'MATCH_REVIEW_REQUIRED', 'CLIENT_CONFIRMATION_REQUIRED',
  'READY_FOR_OPERATOR_REVIEW', 'OPERATOR_APPROVED', 'OPERATOR_REJECTED', 'READY_TO_SUBMIT',
  'SUBMITTED', 'DELIVERED', 'BROKER_CONFIRMED_RECEIPT', 'BROKER_REJECTED',
  'MORE_INFO_REQUESTED', 'WAITING_VERIFICATION', 'VERIFIED_REMOVED', 'PARTIALLY_REMOVED',
  'FAILED', 'REAPPEARED', 'MANUAL_ONLY', 'ESCALATED', 'FALSE_POSITIVE', 'SKIPPED',
  'NEEDS_OPERATOR_REVIEW', 'BLOCKED_CONSENT_SCOPE', 'PAUSED_BY_SYSTEM',
];

for (const status of ALL_STATUSES) {
  if (!TERMINAL_STATUSES.has(status)) {
    for (const safeExit of UNIVERSAL_SAFE_EXITS) {
      ALLOWED_TRANSITIONS.add(`${status}::${safeExit}`);
    }
  }
}

// =============================================================
// CleanupTaskStatusService
// =============================================================

let _eventCounter = 0;
let _auditCounter = 0;

export class CleanupTaskStatusService {
  private timelineEvents: TimelineEvent[] = [];
  private auditLog: StateMachineAuditEntry[] = [];

  // =============================================================
  // isTransitionAllowed
  // =============================================================

  isTransitionAllowed(fromStatus: TaskStatus, toStatus: TaskStatus): boolean {
    return ALLOWED_TRANSITIONS.has(`${fromStatus}::${toStatus}`);
  }

  // =============================================================
  // transition
  // =============================================================

  transition(
    taskId: string,
    caseId: string,
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
    actor: TransitionActor,
    note?: string,
  ): TransitionResult {
    if (!this.isTransitionAllowed(fromStatus, toStatus)) {
      throw new Error(
        `[StatusMachine] Invalid transition: ${fromStatus} → ${toStatus} for task ${taskId}. ` +
          `This transition is not in the allowed transitions list. ` +
          `If this transition is needed, it must be explicitly added to the allowed transitions.`,
      );
    }

    const transitionedAt = new Date();

    const timelineEvent = this.writeTimelineEvent(
      caseId,
      taskId,
      'TASK_STATUS_CHANGED',
      fromStatus,
      toStatus,
      actor,
    );

    const auditEntry = this.writeAuditLog(
      'CLEANUP_TASK_TRANSITION',
      actor.actorId,
      {
        taskId,
        caseId,
        fromStatus,
        toStatus,
        note,
      },
    );

    return {
      taskId,
      fromStatus,
      toStatus,
      actorId: actor.actorId,
      timelineEventId: timelineEvent.id,
      auditEventId: auditEntry.id,
      transitionedAt,
    };
  }

  // =============================================================
  // getAllowedTransitions
  // =============================================================

  getAllowedNextStatuses(fromStatus: TaskStatus): TaskStatus[] {
    const result: TaskStatus[] = [];
    for (const key of ALLOWED_TRANSITIONS) {
      const [from, to] = key.split('::') as [TaskStatus, TaskStatus];
      if (from === fromStatus) result.push(to);
    }
    return result;
  }

  // =============================================================
  // Getters
  // =============================================================

  getTimelineEvents(taskId?: string): TimelineEvent[] {
    if (taskId) return this.timelineEvents.filter((e) => e.taskId === taskId);
    return [...this.timelineEvents];
  }

  getAuditLog(): StateMachineAuditEntry[] {
    return [...this.auditLog] as StateMachineAuditEntry[];
  }

  // =============================================================
  // Private helpers
  // =============================================================

  private writeTimelineEvent(
    caseId: string,
    taskId: string,
    eventType: string,
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
    actor: TransitionActor,
  ): TimelineEvent {
    const event: TimelineEvent = {
      id: `te_${++_eventCounter}`,
      caseId,
      taskId,
      eventType,
      fromStatus,
      toStatus,
      actorId: actor.actorId,
      actorType: actor.actorType,
      createdAt: new Date(),
    };
    this.timelineEvents.push(event);
    return event;
  }

  private writeAuditLog(
    eventType: string,
    actorId: string,
    metadata: Record<string, unknown>,
  ): StateMachineAuditEntry {
    const entry: StateMachineAuditEntry = {
      id: `al_${++_auditCounter}`,
      eventType,
      actorId,
      metadata,
      createdAt: new Date(),
    };
    this.auditLog.push(entry);
    return entry;
  }
}
