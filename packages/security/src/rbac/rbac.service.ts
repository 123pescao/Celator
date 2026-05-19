/**
 * RBAC Primitives — Celator Phase 0
 *
 * Defines roles, permissions, and permission-checking helpers.
 * In Phase 0, roles and permissions are in-memory constants.
 * Phase 1+ integrates this with the Prisma roles/permissions tables.
 *
 * No full auth provider integration — uses test actor objects.
 */

// =============================================================
// Permission codes
// =============================================================

export const Permissions = {
  // Client management
  CLIENT_VIEW_OWN: 'client:view:own',
  CLIENT_SIGN_CONSENT: 'client:sign:consent',
  CLIENT_REVOKE_CONSENT: 'client:revoke:consent',
  CLIENT_CONFIRM_MATCH: 'client:confirm:match',
  CLIENT_VIEW_REPORTS: 'client:view:reports',

  // Operator — standard
  OPERATOR_MANAGE_CLIENTS: 'operator:manage:clients',
  OPERATOR_VIEW_CASES: 'operator:view:cases',
  OPERATOR_PREPARE_REVIEW_PACKET: 'operator:prepare:review_packet',
  OPERATOR_APPROVE_STANDARD: 'operator:approve:standard',
  OPERATOR_REJECT_SUBMISSION: 'operator:reject:submission',
  OPERATOR_MARK_FALSE_POSITIVE: 'operator:mark:false_positive',
  OPERATOR_VIEW_EVIDENCE: 'operator:view:evidence',
  OPERATOR_REQUEST_MORE_EVIDENCE: 'operator:request:more_evidence',

  // Senior operator
  SENIOR_APPROVE_HIGH_RISK: 'senior:approve:high_risk',
  SENIOR_OVERRIDE_PLAYBOOK_EXCEPTION: 'senior:override:playbook_exception',

  // Playbook maintainer
  PLAYBOOK_VIEW: 'playbook:view',
  PLAYBOOK_MANAGE: 'playbook:manage',
  PLAYBOOK_TEST: 'playbook:test',

  // Admin
  ADMIN_MANAGE_USERS: 'admin:manage:users',
  ADMIN_VIEW_AUDIT_LOGS: 'admin:view:audit_logs',
  ADMIN_TRIGGER_EMERGENCY_PAUSE: 'admin:trigger:emergency_pause',
  ADMIN_RESOLVE_EMERGENCY_PAUSE: 'admin:resolve:emergency_pause',
  ADMIN_VIEW_QUALITY_METRICS: 'admin:view:quality_metrics',

  // Auditor
  AUDITOR_VIEW_AUDIT_LOGS: 'auditor:view:audit_logs',
  AUDITOR_VIEW_REPORTS: 'auditor:view:reports',
  AUDITOR_VIEW_CONSENT_RECORDS: 'auditor:view:consent_records',

  // System (service accounts)
  SYSTEM_TRIGGER_JOBS: 'system:trigger:jobs',
  SYSTEM_WRITE_AUDIT: 'system:write:audit',
  SYSTEM_VAULT_DEK_ROTATION: 'system:vault:dek_rotation',
} as const;

export type PermissionCode = (typeof Permissions)[keyof typeof Permissions];

// =============================================================
// Role definitions
// =============================================================

export type RoleName =
  | 'client'
  | 'operator'
  | 'senior_operator'
  | 'playbook_maintainer'
  | 'admin'
  | 'auditor'
  | 'system';

const ROLE_PERMISSIONS: Record<RoleName, PermissionCode[]> = {
  client: [
    Permissions.CLIENT_VIEW_OWN,
    Permissions.CLIENT_SIGN_CONSENT,
    Permissions.CLIENT_REVOKE_CONSENT,
    Permissions.CLIENT_CONFIRM_MATCH,
    Permissions.CLIENT_VIEW_REPORTS,
  ],

  operator: [
    Permissions.OPERATOR_MANAGE_CLIENTS,
    Permissions.OPERATOR_VIEW_CASES,
    Permissions.OPERATOR_PREPARE_REVIEW_PACKET,
    Permissions.OPERATOR_APPROVE_STANDARD,
    Permissions.OPERATOR_REJECT_SUBMISSION,
    Permissions.OPERATOR_MARK_FALSE_POSITIVE,
    Permissions.OPERATOR_VIEW_EVIDENCE,
    Permissions.OPERATOR_REQUEST_MORE_EVIDENCE,
    Permissions.CLIENT_VIEW_REPORTS,
  ],

  senior_operator: [
    Permissions.OPERATOR_MANAGE_CLIENTS,
    Permissions.OPERATOR_VIEW_CASES,
    Permissions.OPERATOR_PREPARE_REVIEW_PACKET,
    Permissions.OPERATOR_APPROVE_STANDARD,
    Permissions.OPERATOR_REJECT_SUBMISSION,
    Permissions.OPERATOR_MARK_FALSE_POSITIVE,
    Permissions.OPERATOR_VIEW_EVIDENCE,
    Permissions.OPERATOR_REQUEST_MORE_EVIDENCE,
    Permissions.SENIOR_APPROVE_HIGH_RISK,
    Permissions.SENIOR_OVERRIDE_PLAYBOOK_EXCEPTION,
    Permissions.CLIENT_VIEW_REPORTS,
  ],

  playbook_maintainer: [
    // No PII decrypt, no approval capability
    Permissions.PLAYBOOK_VIEW,
    Permissions.PLAYBOOK_MANAGE,
    Permissions.PLAYBOOK_TEST,
  ],

  admin: [
    Permissions.OPERATOR_MANAGE_CLIENTS,
    Permissions.OPERATOR_VIEW_CASES,
    Permissions.ADMIN_MANAGE_USERS,
    Permissions.ADMIN_VIEW_AUDIT_LOGS,
    Permissions.ADMIN_TRIGGER_EMERGENCY_PAUSE,
    Permissions.ADMIN_RESOLVE_EMERGENCY_PAUSE,
    Permissions.ADMIN_VIEW_QUALITY_METRICS,
    Permissions.SENIOR_APPROVE_HIGH_RISK,
    Permissions.SENIOR_OVERRIDE_PLAYBOOK_EXCEPTION,
  ],

  auditor: [
    // Read-only. No PII decrypt. No approval capability.
    Permissions.AUDITOR_VIEW_AUDIT_LOGS,
    Permissions.AUDITOR_VIEW_REPORTS,
    Permissions.AUDITOR_VIEW_CONSENT_RECORDS,
  ],

  system: [
    Permissions.SYSTEM_TRIGGER_JOBS,
    Permissions.SYSTEM_WRITE_AUDIT,
    Permissions.SYSTEM_VAULT_DEK_ROTATION,
  ],
};

// =============================================================
// RbacService
// =============================================================

export interface TestActor {
  id: string;
  roles: RoleName[];
  organizationId: string;
  isActive: boolean;
  mfaEnabled: boolean;
  lastMfaAt?: Date;
}

export class RbacService {
  // =============================================================
  // hasPermission
  // =============================================================

  hasPermission(actor: TestActor, permission: PermissionCode): boolean {
    if (!actor.isActive) return false;

    for (const role of actor.roles) {
      const perms = ROLE_PERMISSIONS[role];
      if (perms && perms.includes(permission)) return true;
    }
    return false;
  }

  // =============================================================
  // assertPermission
  // =============================================================

  assertPermission(actor: TestActor, permission: PermissionCode): void {
    if (!this.hasPermission(actor, permission)) {
      throw new Error(
        `[RBAC] Access denied: actor ${actor.id} with roles [${actor.roles.join(', ')}] ` +
          `does not have permission "${permission}".`,
      );
    }
  }

  // =============================================================
  // canApproveHighRisk
  // =============================================================

  canApproveHighRisk(actor: TestActor): boolean {
    return this.hasPermission(actor, Permissions.SENIOR_APPROVE_HIGH_RISK);
  }

  // =============================================================
  // canTriggerEmergencyPause
  // =============================================================

  canTriggerEmergencyPause(actor: TestActor): boolean {
    return this.hasPermission(actor, Permissions.ADMIN_TRIGGER_EMERGENCY_PAUSE);
  }

  // =============================================================
  // isMfaFresh
  // =============================================================

  isMfaFresh(actor: TestActor, windowSeconds: number = 14400): boolean {
    if (!actor.mfaEnabled) return false;
    if (!actor.lastMfaAt) return false;
    const windowMs = windowSeconds * 1000;
    return Date.now() - actor.lastMfaAt.getTime() < windowMs;
  }

  // =============================================================
  // getPermissions
  // =============================================================

  getPermissionsForRoles(roles: RoleName[]): PermissionCode[] {
    const result = new Set<PermissionCode>();
    for (const role of roles) {
      const perms = ROLE_PERMISSIONS[role] ?? [];
      for (const p of perms) result.add(p);
    }
    return Array.from(result);
  }

  getRolePermissions(role: RoleName): PermissionCode[] {
    return ROLE_PERMISSIONS[role] ?? [];
  }
}
