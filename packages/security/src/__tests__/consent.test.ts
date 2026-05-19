import { describe, it, expect } from 'vitest';
import { ConsentPolicyService } from '../consent/consent-policy.service.js';
import type { ClientAuthorizationRef } from '../consent/consent-policy.service.js';

function makeAuth(overrides?: Partial<ClientAuthorizationRef>): ClientAuthorizationRef {
  return {
    id: 'auth_001',
    clientId: 'client_001',
    scopeNames: ['DATA_BROKER_OPT_OUT'],
    jurisdiction: 'US-CA',
    signedAt: new Date('2024-06-01'),
    ...overrides,
  };
}

describe('ConsentPolicyService', () => {
  describe('permit/deny behavior', () => {
    it('permits OPT_OUT for DATA_BROKER_OPT_OUT scope', () => {
      const svc = new ConsentPolicyService();
      const result = svc.isActionPermitted(makeAuth(), 'OPT_OUT');
      expect(result.permitted).toBe(true);
    });

    it('permits DO_NOT_SELL for DATA_BROKER_OPT_OUT scope', () => {
      const svc = new ConsentPolicyService();
      const result = svc.isActionPermitted(makeAuth(), 'DO_NOT_SELL');
      expect(result.permitted).toBe(true);
    });

    it('denies DELETE_PERSONAL_DATA for DATA_BROKER_OPT_OUT scope', () => {
      const svc = new ConsentPolicyService();
      const result = svc.isActionPermitted(makeAuth(), 'DELETE_PERSONAL_DATA');
      expect(result.permitted).toBe(false);
      expect(result.reason).toMatch(/denied/i);
    });

    it('denies LEGAL_ESCALATION for DATA_BROKER_OPT_OUT scope', () => {
      const svc = new ConsentPolicyService();
      const result = svc.isActionPermitted(makeAuth(), 'LEGAL_ESCALATION');
      expect(result.permitted).toBe(false);
    });

    it('denies when no mapping exists for the action', () => {
      const svc = new ConsentPolicyService();
      const result = svc.isActionPermitted(makeAuth(), 'REMOVE_IMAGE');
      expect(result.permitted).toBe(false);
      expect(result.reason).toMatch(/No consent scope mapping/i);
    });

    it('denies when authorization has no matching scopes', () => {
      const svc = new ConsentPolicyService();
      const auth = makeAuth({ scopeNames: ['NONEXISTENT_SCOPE'] });
      const result = svc.isActionPermitted(auth, 'OPT_OUT');
      expect(result.permitted).toBe(false);
    });
  });

  describe('revocation and expiry', () => {
    it('denies when authorization is revoked', () => {
      const svc = new ConsentPolicyService();
      const auth = makeAuth({ revokedAt: new Date('2024-09-01') });
      const result = svc.isActionPermitted(auth, 'OPT_OUT', new Date('2024-10-01'));
      expect(result.permitted).toBe(false);
      expect(result.reason).toMatch(/revoked/i);
    });

    it('denies when authorization is expired', () => {
      const svc = new ConsentPolicyService();
      const auth = makeAuth({ expiresAt: new Date('2024-08-01') });
      const result = svc.isActionPermitted(auth, 'OPT_OUT', new Date('2024-09-01'));
      expect(result.permitted).toBe(false);
      expect(result.reason).toMatch(/expired/i);
    });

    it('evaluates using signedAt time for mapping effectiveness', () => {
      const svc = new ConsentPolicyService();
      // Signed before the mapping became effective
      const auth = makeAuth({ signedAt: new Date('2023-01-01') });
      // The seeded mappings are effective from 2024-01-01
      // Evaluated at signedAt (2023-01-01) — no mapping was effective
      const result = svc.isActionPermitted(auth, 'OPT_OUT');
      // Evaluated at signedAt: 2023-01-01 — effectiveFrom is 2024-01-01, so no mapping
      expect(result.permitted).toBe(false);
    });
  });

  describe('append-only behavior', () => {
    it('appends a new mapping successfully', () => {
      const svc = new ConsentPolicyService();
      const before = svc.getAllMappings().length;
      svc.appendConsentScopeMapping(
        'TEST_SCOPE',
        'REMOVE_IMAGE',
        'US',
        true,
        new Date('2024-01-01'),
        undefined,
        'test-admin',
      );
      expect(svc.getAllMappings().length).toBe(before + 1);
    });

    it('prevents update of existing mapping', () => {
      const svc = new ConsentPolicyService();
      expect(() => svc.preventMappingUpdate('csm_001')).toThrow(/append-only/i);
    });

    it('prevents delete of existing mapping', () => {
      const svc = new ConsentPolicyService();
      expect(() => svc.preventMappingDelete('csm_001')).toThrow(/append-only/i);
    });

    it('writes audit log when new mapping is created', () => {
      const svc = new ConsentPolicyService();
      svc.appendConsentScopeMapping(
        'AUDIT_TEST_SCOPE',
        'REMOVE_IMAGE',
        'US',
        true,
        new Date('2024-01-01'),
        undefined,
        'audit-test-admin',
      );
      const logs = svc.getAuditLog();
      expect(logs.some((l) => l.eventType === 'CONSENT_SCOPE_MAPPING_CREATED')).toBe(true);
    });

    it('rejects conflicting mapping that would create ambiguity', () => {
      const svc = new ConsentPolicyService();
      // DATA_BROKER_OPT_OUT + OPT_OUT + * is already permitted=true
      // Appending permitted=false for same scope/action at overlapping time should conflict
      expect(() =>
        svc.appendConsentScopeMapping(
          'DATA_BROKER_OPT_OUT',
          'OPT_OUT',
          '*',
          false, // conflicts with the seeded permitted=true
          new Date('2024-01-01'),
          undefined,
          'test-admin',
        ),
      ).toThrow(/ambiguity|conflict/i);
    });
  });
});
