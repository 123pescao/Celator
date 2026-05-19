/**
 * EmergencyPauseService — Celator Phase 0
 *
 * Provides the kill-switch capability to immediately halt all pending
 * submissions system-wide or for a specific scope.
 *
 * Scopes:
 * - GLOBAL: blocks all execution
 * - CLIENT: blocks a specific client
 * - BROKER: blocks a specific broker/source
 * - OPERATOR: blocks approvals/executions tied to a specific operator
 * - JURISDICTION: blocks a specific jurisdiction
 *
 * GLOBAL pause requires two-admin consensus (scaffolded in Phase 0).
 * All trigger and resolve events write to AuditLog.
 */

// =============================================================
// Types
// =============================================================

export type EmergencyPauseScope = 'GLOBAL' | 'CLIENT' | 'BROKER' | 'OPERATOR' | 'JURISDICTION';
export type EmergencyPauseStatus = 'ACTIVE' | 'RESOLVED';

export interface EmergencyPauseEvent {
  id: string;
  scope: EmergencyPauseScope;
  scopeRef?: string | undefined; // clientId, operatorId, brokerRef, jurisdiction
  status: EmergencyPauseStatus;
  reason: string;
  triggeredBy: string;
  triggeredAt: Date;
  resolvedBy?: string | undefined;
  resolvedAt?: Date | undefined;
  resolutionSummary?: string | undefined;
  requiresDualAdmin: boolean;
  secondAdminApprovedBy?: string | undefined;
  secondAdminApprovedAt?: Date | undefined;
}

export interface PauseContext {
  clientId?: string | undefined;
  operatorId?: string | undefined;
  brokerRef?: string | undefined;
  jurisdiction?: string | undefined;
  taskId?: string | undefined;
}

export interface AuditEntry {
  id: string;
  eventType: string;
  actorId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface TriggerPauseResult {
  pause: EmergencyPauseEvent;
  auditEventId: string;
}

export interface ResolvePauseResult {
  pause: EmergencyPauseEvent;
  auditEventId: string;
}

// =============================================================
// EmergencyPauseService
// =============================================================

let _pauseCounter = 0;
let _auditCounter = 0;

export class EmergencyPauseService {
  private pauses = new Map<string, EmergencyPauseEvent>();
  private auditLog: AuditEntry[] = [];

  // =============================================================
  // triggerPause
  // =============================================================

  triggerPause(
    scope: EmergencyPauseScope,
    scopeRef: string | undefined,
    reason: string,
    actor: { actorId: string; actorType: string },
  ): TriggerPauseResult {
    if (!reason || reason.trim().length < 10) {
      throw new Error(
        '[EmergencyPause] Pause reason must be at least 10 characters. Provide a meaningful reason.',
      );
    }

    const requiresDualAdmin = scope === 'GLOBAL';
    const pauseId = `pause_${++_pauseCounter}_${Date.now()}`;

    const pause: EmergencyPauseEvent = {
      id: pauseId,
      scope,
      scopeRef,
      status: 'ACTIVE',
      reason: reason.trim(),
      triggeredBy: actor.actorId,
      triggeredAt: new Date(),
      requiresDualAdmin,
    };

    this.pauses.set(pauseId, pause);

    const auditEntry = this.writeAuditLog('EMERGENCY_PAUSE_TRIGGERED', actor.actorId, {
      pauseId,
      scope,
      scopeRef,
      reason,
      requiresDualAdmin,
    });

    return { pause, auditEventId: auditEntry.id };
  }

  // =============================================================
  // resolvePause
  // =============================================================

  resolvePause(
    pauseId: string,
    resolutionSummary: string,
    actor: { actorId: string; actorType: string },
  ): ResolvePauseResult {
    const pause = this.pauses.get(pauseId);
    if (!pause) {
      throw new Error(`[EmergencyPause] Pause ${pauseId} not found.`);
    }
    if (pause.status !== 'ACTIVE') {
      throw new Error(`[EmergencyPause] Pause ${pauseId} is not active (status: ${pause.status}).`);
    }
    if (!resolutionSummary || resolutionSummary.trim().length < 20) {
      throw new Error(
        '[EmergencyPause] Resolution summary must be at least 20 characters. Document what was resolved and why it is safe to resume.',
      );
    }

    // GLOBAL pause dual-admin check (Phase 0: scaffolded — second admin approval not yet enforced)
    if (pause.requiresDualAdmin && !pause.secondAdminApprovedBy) {
      // In production this would block unless secondAdminApprovedBy is set.
      // Phase 0 scaffolds the data model but does not enforce dual-admin auth workflow yet.
      // The check logs a warning but does not hard-block in Phase 0.
      this.writeAuditLog('EMERGENCY_PAUSE_DUAL_ADMIN_WARNING', actor.actorId, {
        pauseId,
        warning: 'GLOBAL pause resolved without confirmed second admin approval. Phase 0 scaffolding only.',
      });
    }

    pause.status = 'RESOLVED';
    pause.resolvedBy = actor.actorId;
    pause.resolvedAt = new Date();
    pause.resolutionSummary = resolutionSummary.trim();

    const auditEntry = this.writeAuditLog('EMERGENCY_PAUSE_RESOLVED', actor.actorId, {
      pauseId,
      resolutionSummary,
    });

    return { pause, auditEventId: auditEntry.id };
  }

  // =============================================================
  // isPausedFor
  // =============================================================

  isPausedFor(context: PauseContext): boolean {
    for (const pause of this.pauses.values()) {
      if (pause.status !== 'ACTIVE') continue;

      switch (pause.scope) {
        case 'GLOBAL':
          return true;

        case 'CLIENT':
          if (context.clientId && pause.scopeRef === context.clientId) return true;
          break;

        case 'OPERATOR':
          if (context.operatorId && pause.scopeRef === context.operatorId) return true;
          break;

        case 'BROKER':
          if (context.brokerRef && pause.scopeRef === context.brokerRef) return true;
          break;

        case 'JURISDICTION':
          if (context.jurisdiction && pause.scopeRef === context.jurisdiction) return true;
          break;
      }
    }
    return false;
  }

  // =============================================================
  // listActivePauses
  // =============================================================

  listActivePauses(): EmergencyPauseEvent[] {
    return Array.from(this.pauses.values()).filter((p) => p.status === 'ACTIVE');
  }

  // =============================================================
  // Helpers
  // =============================================================

  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  private writeAuditLog(
    eventType: string,
    actorId: string,
    metadata: Record<string, unknown>,
  ): AuditEntry {
    const entry: AuditEntry = {
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
