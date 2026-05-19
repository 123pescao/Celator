/**
 * ConsentPolicyService — Celator Phase 0
 *
 * Manages consent scope mappings and evaluates whether an action is permitted
 * under a client's authorization.
 *
 * CRITICAL DESIGN RULES:
 * - ConsentScopeMapping is APPEND-ONLY. Existing mappings are never updated or deleted.
 * - effectiveFrom/effectiveUntil determines which mapping applies at a given time.
 * - Client authorization is evaluated using mappings effective at the consent signedAt time.
 * - Missing mapping = DENY.
 * - Ambiguous mapping (both permit=true and permit=false) = DENY.
 * - All mapping changes write AuditLog.
 */

import type { ActionType } from '../approval/approval-snapshot.service.js';

// =============================================================
// Types
// =============================================================

export interface ConsentScopeMapping {
  id: string;
  scopeName: string;
  actionType: ActionType;
  jurisdiction: string; // e.g. "US-CA", "US", "*"
  permitted: boolean;
  requiredLanguageNote?: string | undefined;
  effectiveFrom: Date;
  effectiveUntil?: Date | undefined;
  createdBy: string;
  createdAt: Date;
  // NO updatedAt — this record must never be modified
}

export interface ClientAuthorizationRef {
  id: string;
  clientId: string;
  scopeNames: string[];
  jurisdiction: string;
  signedAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
}

export interface ConsentPolicyResult {
  permitted: boolean;
  reason: string;
  matchedMappings: Array<{ scopeName: string; permitted: boolean }>;
}

export interface AuditLogEntry {
  id: string;
  eventType: string;
  actorId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

// =============================================================
// Seeded mappings
// =============================================================

const SEEDED_MAPPINGS: Omit<ConsentScopeMapping, 'id' | 'createdAt'>[] = [
  // DATA_BROKER_OPT_OUT — permitted actions
  {
    scopeName: 'DATA_BROKER_OPT_OUT',
    actionType: 'OPT_OUT',
    jurisdiction: '*',
    permitted: true,
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
  {
    scopeName: 'DATA_BROKER_OPT_OUT',
    actionType: 'DO_NOT_SELL',
    jurisdiction: '*',
    permitted: true,
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
  {
    scopeName: 'DATA_BROKER_OPT_OUT',
    actionType: 'DO_NOT_SHARE',
    jurisdiction: '*',
    permitted: true,
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
  // DATA_BROKER_OPT_OUT — denied actions
  {
    scopeName: 'DATA_BROKER_OPT_OUT',
    actionType: 'DELETE_PERSONAL_DATA',
    jurisdiction: '*',
    permitted: false,
    requiredLanguageNote: 'Deletion requires DELETION_REQUEST scope',
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
  {
    scopeName: 'DATA_BROKER_OPT_OUT',
    actionType: 'LEGAL_ESCALATION',
    jurisdiction: '*',
    permitted: false,
    requiredLanguageNote: 'Legal escalation requires LEGAL_ESCALATION scope',
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
  {
    scopeName: 'DATA_BROKER_OPT_OUT',
    actionType: 'ESCALATE_NON_RESPONSE',
    jurisdiction: '*',
    permitted: false,
    requiredLanguageNote: 'Escalation requires LEGAL_ESCALATION scope',
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
  // DELETION_REQUEST scope
  {
    scopeName: 'DELETION_REQUEST',
    actionType: 'DELETE_PERSONAL_DATA',
    jurisdiction: '*',
    permitted: true,
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
  // SEARCH_RESULT_REMOVAL scope
  {
    scopeName: 'SEARCH_RESULT_REMOVAL',
    actionType: 'REMOVE_FROM_SEARCH',
    jurisdiction: '*',
    permitted: true,
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
  // LEGAL_ESCALATION scope — requires explicit scope
  {
    scopeName: 'LEGAL_ESCALATION',
    actionType: 'LEGAL_ESCALATION',
    jurisdiction: '*',
    permitted: true,
    requiredLanguageNote:
      'Legal escalation requires explicit client authorization and specialist review',
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
  {
    scopeName: 'LEGAL_ESCALATION',
    actionType: 'ESCALATE_NON_RESPONSE',
    jurisdiction: '*',
    permitted: true,
    effectiveFrom: new Date('2024-01-01'),
    createdBy: 'system-seed',
  },
];

// =============================================================
// ConsentPolicyService
// =============================================================

let _mappingCounter = 0;
let _auditCounter = 0;

export class ConsentPolicyService {
  private mappings: ConsentScopeMapping[] = [];
  private auditLog: AuditLogEntry[] = [];

  constructor() {
    // Load seeded mappings
    for (const mapping of SEEDED_MAPPINGS) {
      this.mappings.push({
        id: `csm_seed_${++_mappingCounter}`,
        ...mapping,
        createdAt: new Date('2024-01-01'),
      });
    }
  }

  // =============================================================
  // isActionPermitted
  // =============================================================

  isActionPermitted(
    authorization: ClientAuthorizationRef,
    actionType: ActionType,
    atTime?: Date,
  ): ConsentPolicyResult {
    const evaluationTime = atTime ?? authorization.signedAt;

    // Check revocation
    if (authorization.revokedAt && authorization.revokedAt <= (atTime ?? new Date())) {
      return {
        permitted: false,
        reason: 'Authorization has been revoked',
        matchedMappings: [],
      };
    }

    // Check expiry
    if (authorization.expiresAt && authorization.expiresAt < (atTime ?? new Date())) {
      return {
        permitted: false,
        reason: 'Authorization has expired',
        matchedMappings: [],
      };
    }

    // Evaluate each scope in the authorization
    const matchedMappings: Array<{ scopeName: string; permitted: boolean }> = [];
    let anyPermitted = false;
    let anyDenied = false;

    for (const scopeName of authorization.scopeNames) {
      const effectiveMappings = this.getEffectiveMappings(
        scopeName,
        actionType,
        authorization.jurisdiction,
        evaluationTime,
      );

      for (const mapping of effectiveMappings) {
        matchedMappings.push({ scopeName: mapping.scopeName, permitted: mapping.permitted });
        if (mapping.permitted) anyPermitted = true;
        else anyDenied = true;
      }
    }

    if (matchedMappings.length === 0) {
      return {
        permitted: false,
        reason: `No consent scope mapping found for action "${actionType}" in jurisdiction "${authorization.jurisdiction}". Missing mapping = deny.`,
        matchedMappings: [],
      };
    }

    if (anyPermitted && anyDenied) {
      return {
        permitted: false,
        reason: `Ambiguous consent scope mapping for action "${actionType}" — both permitted and denied mappings exist. Ambiguous = deny.`,
        matchedMappings,
      };
    }

    if (anyPermitted) {
      return {
        permitted: true,
        reason: `Action "${actionType}" is permitted under the client's authorization scopes`,
        matchedMappings,
      };
    }

    return {
      permitted: false,
      reason: `Action "${actionType}" is explicitly denied by consent scope mapping`,
      matchedMappings,
    };
  }

  // =============================================================
  // getEffectiveMappings
  // =============================================================

  getEffectiveMappings(
    scopeName: string,
    actionType: ActionType,
    jurisdiction: string,
    atTime: Date,
  ): ConsentScopeMapping[] {
    return this.mappings.filter((m) => {
      if (m.scopeName !== scopeName) return false;
      if (m.actionType !== actionType) return false;
      // Jurisdiction matching: exact match or wildcard "*"
      if (m.jurisdiction !== '*' && m.jurisdiction !== jurisdiction) return false;
      if (m.effectiveFrom > atTime) return false;
      if (m.effectiveUntil && m.effectiveUntil <= atTime) return false;
      return true;
    });
  }

  // =============================================================
  // appendConsentScopeMapping — APPEND ONLY
  // =============================================================

  appendConsentScopeMapping(
    scopeName: string,
    actionType: ActionType,
    jurisdiction: string,
    permitted: boolean,
    effectiveFrom: Date,
    effectiveUntil: Date | undefined,
    createdBy: string,
    requiredLanguageNote?: string,
  ): ConsentScopeMapping {
    // Prevent duplicates that would create ambiguity
    const conflicting = this.getEffectiveMappings(scopeName, actionType, jurisdiction, effectiveFrom);
    if (conflicting.length > 0) {
      const existing = conflicting.find((m) => m.permitted !== permitted);
      if (existing) {
        throw new Error(
          `[ConsentPolicy] Appending a conflicting mapping for scope="${scopeName}" action="${actionType}" ` +
            `jurisdiction="${jurisdiction}" would create ambiguity. ` +
            `An existing mapping at effectiveFrom=${existing.effectiveFrom.toISOString()} has permitted=${existing.permitted}. ` +
            `Close the existing mapping with effectiveUntil before adding a conflicting one.`,
        );
      }
    }

    const mapping = {
      id: `csm_${++_mappingCounter}`,
      scopeName,
      actionType,
      jurisdiction,
      permitted,
      ...(requiredLanguageNote !== undefined && { requiredLanguageNote }),
      effectiveFrom,
      ...(effectiveUntil !== undefined && { effectiveUntil }),
      createdBy,
      createdAt: new Date(),
    } as ConsentScopeMapping;

    this.mappings.push(mapping);

    this.writeAuditLog('CONSENT_SCOPE_MAPPING_CREATED', createdBy, {
      mappingId: mapping.id,
      scopeName,
      actionType,
      jurisdiction,
      permitted,
    });

    return mapping;
  }

  // =============================================================
  // Mutation guards
  // =============================================================

  preventMappingUpdate(_mappingId: string): never {
    throw new Error(
      '[ConsentPolicy] OPERATION DENIED: ConsentScopeMapping records are append-only and may never be updated. ' +
        'To change a mapping, close the existing mapping with effectiveUntil and append a new one.',
    );
  }

  preventMappingDelete(_mappingId: string): never {
    throw new Error(
      '[ConsentPolicy] OPERATION DENIED: ConsentScopeMapping records are append-only and may never be deleted. ' +
        'This is a legal compliance requirement.',
    );
  }

  // =============================================================
  // Helpers
  // =============================================================

  getAllMappings(): ConsentScopeMapping[] {
    return [...this.mappings];
  }

  getAuditLog(): AuditLogEntry[] {
    return [...this.auditLog];
  }

  private writeAuditLog(
    eventType: string,
    actorId: string,
    metadata: Record<string, unknown>,
  ): void {
    this.auditLog.push({
      id: `al_${++_auditCounter}`,
      eventType,
      actorId,
      metadata,
      createdAt: new Date(),
    });
  }
}
