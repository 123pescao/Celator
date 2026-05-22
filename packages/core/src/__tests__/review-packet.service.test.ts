import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewPacketService } from '../services/review-packet.service.js';
import type {
  ApprovalPayloadSnapshotRepository,
  ApprovalRequestRepository,
  CleanupTaskRepository,
  ClientAuthorizationRepository,
} from '@celator/db';
import type { AuditService } from '../services/audit.service.js';
import type { CaseTimelineService } from '../services/case-timeline.service.js';

const FAKE_TASK = {
  id: 'task_001',
  caseId: 'case_001',
  status: 'READY_FOR_OPERATOR_REVIEW' as const,
  matchStatus: 'CONFIRMED_MATCH' as const,
  riskTier: 'STANDARD' as const,
  actionType: 'OPT_OUT' as const,
  sourceRef: 'broker-a',
  findingUrl: null,
  preparedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_AUTH = {
  id: 'auth_001',
  clientId: 'client_001',
  scopeNames: ['DATA_BROKER_OPT_OUT'],
  jurisdiction: 'US-CA',
  revokedAt: null,
  expiresAt: null,
  signedAt: new Date(),
  consentVersionId: 'cv_001',
  authorizationType: 'SELF' as const,
  createdAt: new Date(),
};

const FAKE_SNAPSHOT = {
  id: 'snap_001',
  taskId: 'task_001',
  payloadHash: 'abc123',
  snapshotStatus: 'ACTIVE' as const,
  snapshotExpiresAt: new Date(Date.now() + 86400_000),
};

const FAKE_REQUEST = {
  id: 'req_001',
  taskId: 'task_001',
  authorizationId: 'auth_001',
  snapshotId: 'snap_001',
  status: 'PENDING' as const,
  expiresAt: new Date(Date.now() + 86400_000),
  preparedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeSnapshotRepo(): ApprovalPayloadSnapshotRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_SNAPSHOT),
    findById: vi.fn().mockResolvedValue(FAKE_SNAPSHOT),
    findActiveForTask: vi.fn().mockResolvedValue(FAKE_SNAPSHOT),
    updateStatus: vi.fn().mockResolvedValue(FAKE_SNAPSHOT),
    invalidateForTask: vi.fn().mockResolvedValue(0),
  } as unknown as ApprovalPayloadSnapshotRepository;
}

function makeRequestRepo(): ApprovalRequestRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_REQUEST),
    findById: vi.fn().mockResolvedValue(FAKE_REQUEST),
    findPendingForTask: vi.fn().mockResolvedValue(FAKE_REQUEST),
    listForTask: vi.fn().mockResolvedValue([FAKE_REQUEST]),
    updateStatus: vi.fn().mockResolvedValue(FAKE_REQUEST),
    cancelPendingForTask: vi.fn().mockResolvedValue(0),
  } as unknown as ApprovalRequestRepository;
}

describe('ReviewPacketService', () => {
  let svc: ReviewPacketService;
  let snapshotRepo: ApprovalPayloadSnapshotRepository;
  let requestRepo: ApprovalRequestRepository;

  beforeEach(() => {
    snapshotRepo = makeSnapshotRepo();
    requestRepo = makeRequestRepo();

    const taskRepo = { findById: vi.fn().mockResolvedValue(FAKE_TASK) } as unknown as CleanupTaskRepository;
    const authRepo = { findById: vi.fn().mockResolvedValue(FAKE_AUTH) } as unknown as ClientAuthorizationRepository;
    const audit = { write: vi.fn().mockResolvedValue({ ok: true }) } as unknown as AuditService;
    const timeline = { append: vi.fn().mockResolvedValue({}) } as unknown as CaseTimelineService;

    svc = new ReviewPacketService(snapshotRepo, requestRepo, taskRepo, authRepo, audit, timeline);
  });

  describe('create', () => {
    it('creates snapshot and approval request', async () => {
      const result = await svc.create(
        { taskId: 'task_001', authorizationId: 'auth_001', redactedPreview: 'Opt-out for test broker' },
        'client_001',
        'op_001',
      );
      expect(result.ok).toBe(true);
      expect(snapshotRepo.create).toHaveBeenCalledOnce();
      expect(requestRepo.create).toHaveBeenCalledOnce();
    });

    it('cancels existing pending requests before creating new one', async () => {
      await svc.create(
        { taskId: 'task_001', authorizationId: 'auth_001', redactedPreview: 'Preview' },
        'client_001',
        'op_001',
      );
      expect(requestRepo.cancelPendingForTask).toHaveBeenCalledWith('task_001');
    });

    it('fails if task match status is not CONFIRMED_MATCH or CLIENT_CONFIRMED', async () => {
      const taskRepo = {
        findById: vi.fn().mockResolvedValue({ ...FAKE_TASK, matchStatus: 'LIKELY_MATCH' }),
      } as unknown as CleanupTaskRepository;
      const svc2 = new ReviewPacketService(
        snapshotRepo, requestRepo, taskRepo,
        { findById: vi.fn().mockResolvedValue(FAKE_AUTH) } as unknown as ClientAuthorizationRepository,
        { write: vi.fn().mockResolvedValue({ ok: true }) } as unknown as AuditService,
        { append: vi.fn() } as unknown as CaseTimelineService,
      );
      const result = await svc2.create(
        { taskId: 'task_001', authorizationId: 'auth_001', redactedPreview: 'Preview' },
        'client_001',
        'op_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('fails if authorization is revoked', async () => {
      const authRepo = {
        findById: vi.fn().mockResolvedValue({ ...FAKE_AUTH, revokedAt: new Date() }),
      } as unknown as ClientAuthorizationRepository;
      const svc2 = new ReviewPacketService(
        snapshotRepo, requestRepo,
        { findById: vi.fn().mockResolvedValue(FAKE_TASK) } as unknown as CleanupTaskRepository,
        authRepo,
        { write: vi.fn().mockResolvedValue({ ok: true }) } as unknown as AuditService,
        { append: vi.fn() } as unknown as CaseTimelineService,
      );
      const result = await svc2.create(
        { taskId: 'task_001', authorizationId: 'auth_001', redactedPreview: 'Preview' },
        'client_001',
        'op_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUTHORIZATION_REVOKED');
    });
  });

  describe('getActivePacket', () => {
    it('returns snapshot and request for active task', async () => {
      const result = await svc.getActivePacket('task_001');
      expect(result.ok).toBe(true);
    });

    it('returns SNAPSHOT_NOT_FOUND if no active snapshot', async () => {
      vi.mocked(snapshotRepo.findActiveForTask).mockResolvedValueOnce(null);
      const result = await svc.getActivePacket('task_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('SNAPSHOT_NOT_FOUND');
    });
  });

  describe('audit fail-close', () => {
    it('create propagates audit failure', async () => {
      const AUDIT_ERR = { ok: false as const, error: 'AUDIT_LOG_FAILED' as const, message: 'DB down' };
      const audit = { write: vi.fn().mockResolvedValue(AUDIT_ERR) } as unknown as AuditService;
      const taskRepo = { findById: vi.fn().mockResolvedValue(FAKE_TASK) } as unknown as CleanupTaskRepository;
      const authRepo = { findById: vi.fn().mockResolvedValue(FAKE_AUTH) } as unknown as ClientAuthorizationRepository;
      const svc2 = new ReviewPacketService(snapshotRepo, requestRepo, taskRepo, authRepo, audit, { append: vi.fn() } as unknown as CaseTimelineService);
      const result = await svc2.create(
        { taskId: 'task_001', authorizationId: 'auth_001', redactedPreview: 'Preview' },
        'client_001',
        'op_001',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('AUDIT_LOG_FAILED');
    });
  });
});
