import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClientIntakeService } from '../services/client-intake.service.js';
import type {
  ClientIntakeSessionRepository,
  CleanupCaseRepository,
  CleanupTaskRepository,
  TaskWorkflowRunRepository,
  RemovalRequestPacketRepository,
  FollowUpReminderRepository,
  EmergencyPauseRepository,
} from '@celator/db';
import type { AuditService } from '../services/audit.service.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_SESSION = {
  id: 'session_001',
  clientId: null,
  orgId: 'org_001',
  status: 'STARTED' as const,
  safeContactRef: null,
  requestedActionTypes: [],
  requestedSourceTypes: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
  expiresAt: null,
};

const FAKE_SESSION_READY = { ...FAKE_SESSION, status: 'READY_FOR_REVIEW' as const };
const FAKE_SESSION_COMPLETED = { ...FAKE_SESSION, status: 'COMPLETED' as const };
const FAKE_SESSION_CANCELLED = { ...FAKE_SESSION, status: 'CANCELLED' as const };
const FAKE_SESSION_EXPIRED = { ...FAKE_SESSION, status: 'EXPIRED' as const };
const FAKE_SESSION_CONSENT = { ...FAKE_SESSION, status: 'CONSENT_PENDING' as const };
const FAKE_SESSION_IDENTITY = { ...FAKE_SESSION, status: 'IDENTITY_PENDING' as const };

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeRepo(overrides?: Partial<ClientIntakeSessionRepository>): ClientIntakeSessionRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_SESSION),
    findById: vi.fn().mockResolvedValue(FAKE_SESSION),
    listForOrg: vi.fn().mockResolvedValue([FAKE_SESSION]),
    listForClient: vi.fn().mockResolvedValue([FAKE_SESSION]),
    update: vi.fn().mockResolvedValue({ ...FAKE_SESSION, clientId: 'client_001' }),
    updateStatus: vi.fn().mockImplementation((_id, status) => Promise.resolve({ ...FAKE_SESSION, status })),
    ...overrides,
  } as unknown as ClientIntakeSessionRepository;
}

function makeCaseRepo() {
  return {
    listForClient: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    create: vi.fn(),
    close: vi.fn(),
    update: vi.fn(),
  } as unknown as CleanupCaseRepository;
}

function makeTaskRepo() {
  return { listForClientId: vi.fn().mockResolvedValue([]), findById: vi.fn(), create: vi.fn(), listForCase: vi.fn().mockResolvedValue([]), updateStatus: vi.fn(), update: vi.fn(), bulkUpdateStatus: vi.fn() } as unknown as CleanupTaskRepository;
}

function makeWorkflowRunRepo() {
  return { listForClient: vi.fn().mockResolvedValue([]) } as unknown as TaskWorkflowRunRepository;
}

function makePacketRepo() {
  return { listForClient: vi.fn().mockResolvedValue([]) } as unknown as RemovalRequestPacketRepository;
}

function makeFollowUpRepo() {
  return { listForClient: vi.fn().mockResolvedValue([]) } as unknown as FollowUpReminderRepository;
}

function makeEmergencyPauseRepo() {
  return {
    findActiveGlobal: vi.fn().mockResolvedValue(null),
    findActiveForScope: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    findById: vi.fn(),
    listActive: vi.fn(),
    resolve: vi.fn(),
  } as unknown as EmergencyPauseRepository;
}

function makeAudit() {
  return { write: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as unknown as AuditService;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ClientIntakeService', () => {
  let repo: ClientIntakeSessionRepository;
  let audit: AuditService;
  let svc: ClientIntakeService;

  beforeEach(() => {
    repo = makeRepo();
    audit = makeAudit();
    svc = new ClientIntakeService(
      repo, makeCaseRepo(), makeTaskRepo(), makeWorkflowRunRepo(),
      makePacketRepo(), makeFollowUpRepo(), makeEmergencyPauseRepo(), audit,
    );
  });

  describe('createSession', () => {
    it('creates session with STARTED status and writes audit event', async () => {
      const result = await svc.createSession({ orgId: 'org_001' }, 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('STARTED');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'INTAKE_SESSION_CREATED' }));
    });

    it('returns ok(SafeIntakeSession) with id, orgId, status fields', async () => {
      const result = await svc.createSession({ orgId: 'org_001' }, 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveProperty('id');
      expect(result.value).toHaveProperty('orgId');
      expect(result.value).toHaveProperty('status');
    });

    it('returns VALIDATION_ERROR when safeContactRef contains raw email', async () => {
      const result = await svc.createSession({ orgId: 'org_001', safeContactRef: 'contact admin@example.com' }, 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when safeContactRef contains phone pattern', async () => {
      const result = await svc.createSession({ orgId: 'org_001', safeContactRef: 'call 555-123-4567' }, 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('safe response contains no ciphertext, authTag, iv, encryptedKeyRef, storageKey', async () => {
      const result = await svc.createSession({ orgId: 'org_001' }, 'actor_001');
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
      expect(json).not.toContain('encryptedKeyRef');
      expect(json).not.toContain('storageKey');
    });

    it('audit metadata does not include safeContactRef value', async () => {
      await svc.createSession({ orgId: 'org_001', safeContactRef: 'REF-001' }, 'actor_001');
      const call = vi.mocked(audit.write).mock.calls.find(([a]) => a.eventType === 'INTAKE_SESSION_CREATED');
      const meta = JSON.stringify(call?.[0]?.metadata);
      expect(meta).not.toContain('REF-001');
    });
  });

  describe('linkClient', () => {
    it('links clientId to session and returns updated session', async () => {
      const result = await svc.linkClient('session_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(repo.update).toHaveBeenCalled();
    });

    it('writes INTAKE_SESSION_CLIENT_LINKED audit event', async () => {
      await svc.linkClient('session_001', 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'INTAKE_SESSION_CLIENT_LINKED' }));
    });

    it('returns INTAKE_SESSION_NOT_FOUND when session does not exist', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.linkClient('missing', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_SESSION_NOT_FOUND');
    });

    it('returns INTAKE_INVALID_STATUS when session is COMPLETED (terminal)', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_COMPLETED);
      const result = await svc.linkClient('session_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });

    it('returns INTAKE_INVALID_STATUS when session is CANCELLED (terminal)', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_CANCELLED);
      const result = await svc.linkClient('session_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });

    it('returns INTAKE_INVALID_STATUS when session is EXPIRED (terminal)', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_EXPIRED);
      const result = await svc.linkClient('session_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });

    it('returns VALIDATION_ERROR when session already linked to a different client', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce({ ...FAKE_SESSION, clientId: 'client_OTHER' });
      const result = await svc.linkClient('session_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('updateRequestedScope', () => {
    it('updates requestedActionTypes and returns ok', async () => {
      vi.mocked(repo.update).mockResolvedValueOnce({ ...FAKE_SESSION, requestedActionTypes: ['OPT_OUT'] });
      const result = await svc.updateRequestedScope('session_001', { requestedActionTypes: ['OPT_OUT'] }, 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('writes INTAKE_SESSION_SCOPE_UPDATED audit event', async () => {
      await svc.updateRequestedScope('session_001', {}, 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'INTAKE_SESSION_SCOPE_UPDATED' }));
    });

    it('returns INTAKE_SESSION_NOT_FOUND for missing session', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.updateRequestedScope('missing', {}, 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_SESSION_NOT_FOUND');
    });

    it('returns INTAKE_INVALID_STATUS when session is COMPLETED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_COMPLETED);
      const result = await svc.updateRequestedScope('session_001', {}, 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });
  });

  describe('markConsentPending', () => {
    it('transitions STARTED → CONSENT_PENDING and writes audit', async () => {
      const result = await svc.markConsentPending('session_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'INTAKE_SESSION_CONSENT_PENDING' }));
    });

    it('transitions CONTACT_CAPTURED → CONSENT_PENDING', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce({ ...FAKE_SESSION, status: 'CONTACT_CAPTURED' as const });
      const result = await svc.markConsentPending('session_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('returns INTAKE_INVALID_STATUS for IDENTITY_PENDING → CONSENT_PENDING (invalid)', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_IDENTITY);
      const result = await svc.markConsentPending('session_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });

    it('returns INTAKE_INVALID_STATUS when session is COMPLETED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_COMPLETED);
      const result = await svc.markConsentPending('session_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });

    it('returns INTAKE_SESSION_NOT_FOUND for missing session', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.markConsentPending('missing', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_SESSION_NOT_FOUND');
    });
  });

  describe('markReadyForReview', () => {
    it('transitions CONSENT_PENDING → READY_FOR_REVIEW', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_CONSENT);
      const result = await svc.markReadyForReview('session_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('transitions IDENTITY_PENDING → READY_FOR_REVIEW', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_IDENTITY);
      const result = await svc.markReadyForReview('session_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('returns INTAKE_INVALID_STATUS for STARTED → READY_FOR_REVIEW (must pass through consent or identity)', async () => {
      const result = await svc.markReadyForReview('session_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });

    it('returns INTAKE_INVALID_STATUS when session is COMPLETED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_COMPLETED);
      const result = await svc.markReadyForReview('session_001', 'actor_001');
      expect(result.ok).toBe(false);
    });
  });

  describe('completeSession', () => {
    it('transitions READY_FOR_REVIEW → COMPLETED and writes audit', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_READY);
      const result = await svc.completeSession('session_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'INTAKE_SESSION_COMPLETED' }));
    });

    it('returns INTAKE_INVALID_STATUS for STARTED → COMPLETED (must pass READY_FOR_REVIEW first)', async () => {
      const result = await svc.completeSession('session_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });

    it('returns INTAKE_INVALID_STATUS when session is already COMPLETED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_COMPLETED);
      const result = await svc.completeSession('session_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });

    it('returns INTAKE_INVALID_STATUS when session is CANCELLED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_CANCELLED);
      const result = await svc.completeSession('session_001', 'actor_001');
      expect(result.ok).toBe(false);
    });

    it('returns INTAKE_SESSION_NOT_FOUND for missing session', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.completeSession('missing', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_SESSION_NOT_FOUND');
    });
  });

  describe('cancelSession', () => {
    it('transitions STARTED → CANCELLED and writes audit', async () => {
      const result = await svc.cancelSession('session_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'INTAKE_SESSION_CANCELLED' }));
    });

    it('transitions CONSENT_PENDING → CANCELLED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_CONSENT);
      const result = await svc.cancelSession('session_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('transitions READY_FOR_REVIEW → CANCELLED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_READY);
      const result = await svc.cancelSession('session_001', 'actor_001');
      expect(result.ok).toBe(true);
    });

    it('returns INTAKE_INVALID_STATUS when session is already CANCELLED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_CANCELLED);
      const result = await svc.cancelSession('session_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_INVALID_STATUS');
    });

    it('returns INTAKE_INVALID_STATUS when session is COMPLETED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_COMPLETED);
      const result = await svc.cancelSession('session_001', 'actor_001');
      expect(result.ok).toBe(false);
    });

    it('returns INTAKE_INVALID_STATUS when session is EXPIRED', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(FAKE_SESSION_EXPIRED);
      const result = await svc.cancelSession('session_001', 'actor_001');
      expect(result.ok).toBe(false);
    });
  });

  describe('getSafeSession', () => {
    it('returns ok(SafeIntakeSession) for existing session', async () => {
      const result = await svc.getSafeSession('session_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('session_001');
    });

    it('returns INTAKE_SESSION_NOT_FOUND for missing session', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.getSafeSession('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INTAKE_SESSION_NOT_FOUND');
    });

    it('returned session has no ciphertext, authTag, encryptedKeyRef, storageKey fields', async () => {
      const result = await svc.getSafeSession('session_001');
      expect(JSON.stringify(result)).not.toContain('ciphertext');
      expect(JSON.stringify(result)).not.toContain('storageKey');
    });
  });

  describe('listSessionsForOrg', () => {
    it('returns array of SafeIntakeSession for the given orgId', async () => {
      const result = await svc.listSessionsForOrg('org_001');
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]?.orgId).toBe('org_001');
    });

    it('returns empty array when org has no sessions (not an error)', async () => {
      vi.mocked(repo.listForOrg).mockResolvedValueOnce([]);
      const result = await svc.listSessionsForOrg('org_empty');
      expect(result).toEqual([]);
    });

    it('result items contain no vault fields', async () => {
      const result = await svc.listSessionsForOrg('org_001');
      expect(JSON.stringify(result)).not.toContain('ciphertext');
    });
  });

  describe('getClientPortalSummary', () => {
    it('returns ok(SafeClientPortalSummary) with portal state', async () => {
      const result = await svc.getClientPortalSummary('client_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.clientId).toBe('client_001');
      expect(typeof result.value.hasActivePauseBlock).toBe('boolean');
    });

    it('hasActivePauseBlock is true when global pause is active', async () => {
      const fakePause = { id: 'pause_001', scope: 'GLOBAL' as const, status: 'ACTIVE' as const, reason: 'Test', triggeredBy: 'admin', scopeRef: null, triggeredAt: new Date(), resolvedBy: null, resolvedAt: null, requiresDualAdmin: false, resolutionSummary: null, secondAdminApprovedBy: null, secondAdminApprovedAt: null };
      const caseRepo = makeCaseRepo();
      const taskRepo = makeTaskRepo();
      const workflowRunRepo = makeWorkflowRunRepo();
      const packetRepo = makePacketRepo();
      const followUpRepo = makeFollowUpRepo();
      const pauseRepo = makeEmergencyPauseRepo();
      vi.mocked(pauseRepo.findActiveGlobal).mockResolvedValueOnce(fakePause);
      const svWithPause = new ClientIntakeService(repo, caseRepo, taskRepo, workflowRunRepo, packetRepo, followUpRepo, pauseRepo, audit);
      const result = await svWithPause.getClientPortalSummary('client_001');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.hasActivePauseBlock).toBe(true);
    });

    it('summary contains no vault fields', async () => {
      const result = await svc.getClientPortalSummary('client_001');
      expect(JSON.stringify(result)).not.toContain('ciphertext');
      expect(JSON.stringify(result)).not.toContain('storageKey');
    });
  });
});
