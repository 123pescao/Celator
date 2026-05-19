import { describe, it, expect } from 'vitest';
import {
  makeGateServices,
  makeTestClient,
  makeTestTask,
  makeTestAuthorization,
  makeTestApproval,
  makeValidGateContext,
} from './fixtures.js';

describe('ApprovalGateService — canExecuteSubmission', () => {
  describe('allows execution when all conditions pass', () => {
    it('returns allowed=true for a complete valid context', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(true);
      expect(result.blockedBy).toHaveLength(0);
    });
  });

  describe('blocks on client issues', () => {
    it('blocks when client status is not ACTIVE', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.client = makeTestClient({ status: 'SUSPENDED' });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_2_FAILED'))).toBe(true);
    });

    it('blocks when client identity verification is incomplete', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.client = makeTestClient({ identityVerified: false });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_3_FAILED'))).toBe(true);
    });

    it('blocks when client has dispute flag', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.client = makeTestClient({ hasDisputeFlag: true });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_23_FAILED'))).toBe(true);
    });

    it('blocks when client has compliance hold', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.client = makeTestClient({ hasComplianceHold: true });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_24_FAILED'))).toBe(true);
    });
  });

  describe('blocks on authorization issues', () => {
    it('blocks when authorization is revoked', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.authorization = makeTestAuthorization({ revokedAt: new Date('2024-09-01') });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_7_FAILED'))).toBe(true);
    });

    it('blocks when authorization is expired', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.authorization = makeTestAuthorization({ expiresAt: new Date('2020-01-01') });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_6_FAILED'))).toBe(true);
    });

    it('blocks when consent scope does not cover action', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      // DATA_BROKER_OPT_OUT scope does not permit DELETE_PERSONAL_DATA
      ctx.task = makeTestTask({ actionType: 'DELETE_PERSONAL_DATA' });
      ctx.authorization = makeTestAuthorization({ scopeNames: ['DATA_BROKER_OPT_OUT'] });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_5_FAILED'))).toBe(true);
    });
  });

  describe('blocks on match confidence issues', () => {
    it('blocks when match status is LIKELY_MATCH', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.task = makeTestTask({ matchStatus: 'LIKELY_MATCH' });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_9_FAILED'))).toBe(true);
    });

    it('blocks when match status is NEEDS_OPERATOR_REVIEW', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.task = makeTestTask({ matchStatus: 'NEEDS_OPERATOR_REVIEW' });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_9_FAILED'))).toBe(true);
    });

    it('allows CLIENT_CONFIRMED match status', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.task = makeTestTask({ matchStatus: 'CLIENT_CONFIRMED' });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe('blocks on payload/snapshot integrity issues', () => {
    it('blocks when payload hash does not match approved hash', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.currentPayloadHash = 'tampered-hash-value';
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_15_FAILED'))).toBe(true);
    });

    it('blocks when snapshot is expired', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.snapshot.snapshotExpiresAt = new Date(Date.now() - 1000);
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_28_FAILED'))).toBe(true);
    });

    it('blocks when snapshot status is INVALIDATED', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.snapshot.snapshotStatus = 'INVALIDATED';
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_28_FAILED'))).toBe(true);
    });
  });

  describe('blocks on emergency pause', () => {
    it('blocks when GLOBAL emergency pause is active', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      services.pause.triggerPause(
        'GLOBAL',
        undefined,
        'Security incident detected — halting all submissions',
        { actorId: 'admin_001', actorType: 'ADMIN' },
      );
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_25_FAILED'))).toBe(true);
    });

    it('blocks when CLIENT-scoped pause is active for this client', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      services.pause.triggerPause(
        'CLIENT',
        ctx.client.id,
        'Client-specific hold pending review',
        { actorId: 'admin_001', actorType: 'ADMIN' },
      );
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_25_FAILED'))).toBe(true);
    });
  });

  describe('blocks on high-risk flag issues', () => {
    it('blocks when unresolved high-risk flag present', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.task = makeTestTask({
        highRiskFlags: [{ flagType: 'MINOR_DATA' }],
      });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_22_FAILED'))).toBe(true);
    });

    it('does not block when high-risk flag is resolved', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.task = makeTestTask({
        highRiskFlags: [{ flagType: 'MINOR_DATA', resolvedAt: new Date() }],
      });
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe('blocks on single-operator org with high-risk task', () => {
    it('blocks HIGH-risk task in single-operator organization', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.task = makeTestTask({ riskTier: 'HIGH' });
      ctx.isOrganizationSingleOperator = true;
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_38_FAILED'))).toBe(true);
    });

    it('allows HIGH-risk task in multi-operator organization', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.task = makeTestTask({ riskTier: 'HIGH', highRiskFlags: [] });
      ctx.isOrganizationSingleOperator = false;
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe('blocks on missing warning acknowledgments', () => {
    it('blocks when required warnings were not acknowledged', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.requiredWarnings = ['HIGH_RISK_FLAG_PRESENT', 'MATCH_CONFIDENCE_LOW'];
      ctx.acknowledgedWarnings = ['HIGH_RISK_FLAG_PRESENT']; // missing MATCH_CONFIDENCE_LOW
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_33_FAILED'))).toBe(true);
    });
  });

  describe('blocks on data minimization violations', () => {
    it('blocks when data minimization was not enforced', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.dataMinimizationEnforced = false;
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_36_FAILED'))).toBe(true);
    });

    it('blocks when optional fields are included', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.optionalFieldsIncluded = ['middleName', 'maidenName'];
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_37_FAILED'))).toBe(true);
    });
  });

  describe('blocks when evidence is unavailable', () => {
    it('blocks when evidence is not available', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.evidenceAvailable = false;
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_27_FAILED'))).toBe(true);
    });

    it('blocks when evidence availability not evaluated (undefined)', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      (ctx as unknown as Record<string, unknown>)['evidenceAvailable'] = undefined;
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes('CHECK_27_FAILED'))).toBe(true);
    });
  });

  describe('audit trail', () => {
    it('writes audit log on both allowed and blocked results', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      const result = services.gate.canExecuteSubmission(ctx);
      expect(result.auditEventId).toBeTruthy();
      expect(services.gate.getAuditLog().length).toBeGreaterThanOrEqual(1);
    });

    it('records blockedBy list in audit log', async () => {
      const services = makeGateServices();
      const ctx = await makeValidGateContext(services);
      ctx.client = makeTestClient({ status: 'SUSPENDED' });
      services.gate.canExecuteSubmission(ctx);
      const log = services.gate.getAuditLog();
      const logEntry = log[0] as Record<string, unknown>;
      const ctx2 = logEntry['context'] as Record<string, unknown>;
      expect((ctx2['blockedBy'] as string[]).length).toBeGreaterThan(0);
    });
  });
});
