import { describe, it, expect } from 'vitest';
import { RbacService, Permissions } from '../rbac/rbac.service.js';
import type { TestActor } from '../rbac/rbac.service.js';

function makeActor(roles: TestActor['roles'], overrides?: Partial<TestActor>): TestActor {
  return {
    id: 'actor_001',
    roles,
    organizationId: 'org_001',
    isActive: true,
    mfaEnabled: true,
    lastMfaAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

describe('RbacService', () => {
  describe('role permissions', () => {
    it('client can view own case', () => {
      const svc = new RbacService();
      expect(svc.hasPermission(makeActor(['client']), Permissions.CLIENT_VIEW_OWN)).toBe(true);
    });

    it('client cannot approve submissions', () => {
      const svc = new RbacService();
      expect(svc.hasPermission(makeActor(['client']), Permissions.OPERATOR_APPROVE_STANDARD)).toBe(false);
    });

    it('operator can prepare review packets', () => {
      const svc = new RbacService();
      expect(svc.hasPermission(makeActor(['operator']), Permissions.OPERATOR_PREPARE_REVIEW_PACKET)).toBe(true);
    });

    it('operator cannot approve high-risk tasks', () => {
      const svc = new RbacService();
      expect(svc.hasPermission(makeActor(['operator']), Permissions.SENIOR_APPROVE_HIGH_RISK)).toBe(false);
    });

    it('senior_operator can approve high-risk tasks', () => {
      const svc = new RbacService();
      expect(svc.hasPermission(makeActor(['senior_operator']), Permissions.SENIOR_APPROVE_HIGH_RISK)).toBe(true);
    });

    it('admin can trigger emergency pause', () => {
      const svc = new RbacService();
      expect(svc.hasPermission(makeActor(['admin']), Permissions.ADMIN_TRIGGER_EMERGENCY_PAUSE)).toBe(true);
    });

    it('auditor has read-only access, cannot approve', () => {
      const svc = new RbacService();
      const auditor = makeActor(['auditor']);
      expect(svc.hasPermission(auditor, Permissions.AUDITOR_VIEW_AUDIT_LOGS)).toBe(true);
      expect(svc.hasPermission(auditor, Permissions.OPERATOR_APPROVE_STANDARD)).toBe(false);
    });

    it('playbook_maintainer has no PII decrypt or approval capability', () => {
      const svc = new RbacService();
      const pm = makeActor(['playbook_maintainer']);
      expect(svc.hasPermission(pm, Permissions.OPERATOR_APPROVE_STANDARD)).toBe(false);
      expect(svc.hasPermission(pm, Permissions.PLAYBOOK_MANAGE)).toBe(true);
    });

    it('inactive actor is denied all permissions', () => {
      const svc = new RbacService();
      const inactive = makeActor(['admin'], { isActive: false });
      expect(svc.hasPermission(inactive, Permissions.ADMIN_TRIGGER_EMERGENCY_PAUSE)).toBe(false);
    });
  });

  describe('MFA freshness', () => {
    it('returns true when MFA was recent', () => {
      const svc = new RbacService();
      const actor = makeActor(['operator'], { lastMfaAt: new Date(Date.now() - 60_000) });
      expect(svc.isMfaFresh(actor, 14400)).toBe(true);
    });

    it('returns false when MFA is stale', () => {
      const svc = new RbacService();
      const actor = makeActor(['operator'], {
        lastMfaAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5 hours ago
      });
      expect(svc.isMfaFresh(actor, 14400)).toBe(false);
    });

    it('returns false when MFA is not enabled', () => {
      const svc = new RbacService();
      const actor = makeActor(['operator'], { mfaEnabled: false, lastMfaAt: new Date() });
      expect(svc.isMfaFresh(actor)).toBe(false);
    });

    it('returns false when lastMfaAt is undefined', () => {
      const svc = new RbacService();
      const actorNoMfa = makeActor(['operator']);
      actorNoMfa.lastMfaAt = undefined as unknown as Date;
      expect(svc.isMfaFresh(actorNoMfa)).toBe(false);
    });
  });

  describe('assertPermission', () => {
    it('does not throw when permission exists', () => {
      const svc = new RbacService();
      expect(() =>
        svc.assertPermission(makeActor(['operator']), Permissions.OPERATOR_APPROVE_STANDARD),
      ).not.toThrow();
    });

    it('throws when permission is missing', () => {
      const svc = new RbacService();
      expect(() =>
        svc.assertPermission(makeActor(['client']), Permissions.OPERATOR_APPROVE_STANDARD),
      ).toThrow(/Access denied/i);
    });
  });
});
