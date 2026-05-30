import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OperatorCommandCenterService } from '../services/operator-command-center.service.js';
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_CLIENT = { id: 'client_001', organizationId: 'org_001', status: 'ACTIVE' as const, displayName: 'Test', createdAt: new Date(), updatedAt: new Date(), hasDisputeFlag: false, hasComplianceHold: false };

const FAKE_CASE = { id: 'case_001', clientId: 'client_001', authorizationId: 'auth_001', title: 'Test', createdAt: new Date(), updatedAt: new Date(), closedAt: null };

const FAKE_TASK = {
  id: 'task_001', caseId: 'case_001', dataSourceTargetId: null,
  status: 'OPERATOR_APPROVED' as const, actionType: 'OPT_OUT' as const,
  matchStatus: 'CONFIRMED_MATCH' as const, riskTier: 'STANDARD' as const,
  sourceRef: 'Example Broker', findingUrl: null, preparedByUserId: null,
  createdAt: new Date(), updatedAt: new Date(),
};

const FAKE_WORKFLOW_RUN = { id: 'run_001', taskId: 'task_001', clientId: 'client_001', playbookId: 'pb_001', status: 'BLOCKED' as const, currentStepOrder: 2, startedAt: new Date(), completedAt: null, createdAt: new Date(), updatedAt: new Date() };

const FAKE_PACKET = { id: 'pkt_001', taskId: 'task_001', clientId: 'client_001', dataSourceTargetId: null, status: 'READY' as const, redactedSummary: 'Test packet', preparedByUserId: null, createdAt: new Date(), updatedAt: new Date() };

const FAKE_FOLLOW_UP = { id: 'fu_001', taskId: 'task_001', clientId: 'client_001', status: 'PENDING' as const, dueAt: new Date(Date.now() - 1000), safeNote: null, completedAt: null, cancelledAt: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date() };

const FAKE_EVIDENCE = { id: 'ev_001', taskId: 'task_001', clientId: 'client_001', storageKey: 'evidence/ev_001', contentHash: 'abc', evidenceType: 'SCREENSHOT', mimeType: null, sizeBytes: null, isImmutable: false, retainUntil: null, createdAt: new Date() };

const FAKE_SUBMISSION = { id: 'sub_001', taskId: 'task_001', clientId: 'client_001', dataSourceTargetId: null, submittedByUserId: null, submissionMethod: 'MANUAL_FORM' as const, submissionStatus: 'DRAFTED' as const, submittedAt: null, confirmationCode: null, confirmationUrl: null, operatorNotes: null, redactedSummary: null, createdAt: new Date(), updatedAt: new Date() };

const FAKE_TIMELINE_EVENT = { id: 'te_001', caseId: 'case_001', taskId: 'task_001', eventType: 'CASE_CREATED', fromStatus: null, toStatus: null, actorId: 'actor_001', actorType: 'OPERATOR' as const, note: 'Case created', createdAt: new Date() };

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeRepos() {
  const clientRepo = {
    findById: vi.fn().mockResolvedValue(FAKE_CLIENT),
    listByOrg: vi.fn().mockResolvedValue([FAKE_CLIENT]),
    create: vi.fn(),
    updateStatus: vi.fn(),
    update: vi.fn(),
  } as unknown as ClientRepository;

  const caseRepo = {
    findById: vi.fn().mockResolvedValue(FAKE_CASE),
    listForClient: vi.fn().mockResolvedValue([FAKE_CASE]),
    create: vi.fn(),
    close: vi.fn(),
    update: vi.fn(),
  } as unknown as CleanupCaseRepository;

  const taskRepo = {
    findById: vi.fn().mockResolvedValue(FAKE_TASK),
    listForCase: vi.fn().mockResolvedValue([FAKE_TASK]),
    listForClientId: vi.fn().mockResolvedValue([FAKE_TASK]),
    create: vi.fn(),
    updateStatus: vi.fn(),
    update: vi.fn(),
    bulkUpdateStatus: vi.fn(),
  } as unknown as CleanupTaskRepository;

  const workflowRunRepo = {
    listForClient: vi.fn().mockResolvedValue([FAKE_WORKFLOW_RUN]),
    create: vi.fn(),
    findById: vi.fn(),
    findActiveByTaskId: vi.fn(),
  } as unknown as TaskWorkflowRunRepository;

  const packetRepo = {
    listForClient: vi.fn().mockResolvedValue([FAKE_PACKET]),
    listForTask: vi.fn().mockResolvedValue([FAKE_PACKET]),
    create: vi.fn(),
    findById: vi.fn(),
  } as unknown as RemovalRequestPacketRepository;

  const followUpRepo = {
    listForClient: vi.fn().mockResolvedValue([FAKE_FOLLOW_UP]),
    listDueAsOf: vi.fn().mockResolvedValue([FAKE_FOLLOW_UP]),
    listForTask: vi.fn().mockResolvedValue([FAKE_FOLLOW_UP]),
    create: vi.fn(),
  } as unknown as FollowUpReminderRepository;

  const evidenceRepo = {
    listForClient: vi.fn().mockResolvedValue([FAKE_EVIDENCE]),
    listForTask: vi.fn().mockResolvedValue([FAKE_EVIDENCE]),
    create: vi.fn(),
    findById: vi.fn(),
  } as unknown as EvidenceRecordRepository;

  const manualSubmissionRepo = {
    listForClient: vi.fn().mockResolvedValue([FAKE_SUBMISSION]),
    create: vi.fn(),
    findById: vi.fn(),
  } as unknown as ManualRemovalSubmissionRepository;

  const timelineRepo = {
    listForCase: vi.fn().mockResolvedValue([FAKE_TIMELINE_EVENT]),
    listForTask: vi.fn().mockResolvedValue([FAKE_TIMELINE_EVENT]),
    listRecentForClient: vi.fn().mockResolvedValue([FAKE_TIMELINE_EVENT]),
    create: vi.fn(),
  } as unknown as CaseTimelineRepository;

  return { clientRepo, caseRepo, taskRepo, workflowRunRepo, packetRepo, followUpRepo, evidenceRepo, manualSubmissionRepo, timelineRepo };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OperatorCommandCenterService', () => {
  let repos: ReturnType<typeof makeRepos>;
  let svc: OperatorCommandCenterService;

  beforeEach(() => {
    repos = makeRepos();
    svc = new OperatorCommandCenterService(
      repos.clientRepo, repos.caseRepo, repos.taskRepo, repos.workflowRunRepo,
      repos.packetRepo, repos.followUpRepo, repos.evidenceRepo,
      repos.manualSubmissionRepo, repos.timelineRepo,
    );
  });

  describe('getDashboardOverview', () => {
    it('returns DashboardOverview with correct shape when called with clientId', async () => {
      const result = await svc.getDashboardOverview({ clientId: 'client_001' });
      expect(result).toMatchObject({ totalClients: 1, activeCases: expect.any(Number) });
    });

    it('returns zero counts when neither orgId nor clientId is provided', async () => {
      const result = await svc.getDashboardOverview({});
      expect(result.totalClients).toBe(0);
      expect(result.activeCases).toBe(0);
    });

    it('returns overview when called with orgId', async () => {
      const result = await svc.getDashboardOverview({ orgId: 'org_001' });
      expect(result.totalClients).toBe(1);
    });

    it('result contains no vault fields', async () => {
      const result = await svc.getDashboardOverview({ clientId: 'client_001' });
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
      expect(json).not.toContain('encryptedKeyRef');
      expect(json).not.toContain('storageKey');
    });

    it('counts blocked workflows correctly', async () => {
      const result = await svc.getDashboardOverview({ clientId: 'client_001' });
      expect(result.workflowsBlocked).toBe(1);
      expect(result.workflowsInProgress).toBe(0);
    });

    it('counts ready packets correctly', async () => {
      const result = await svc.getDashboardOverview({ clientId: 'client_001' });
      expect(result.packetsReady).toBe(1);
    });
  });

  describe('listWorkQueue', () => {
    it('returns WorkQueueItems for a given clientId', async () => {
      const result = await svc.listWorkQueue({ clientId: 'client_001' });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns empty array when neither orgId nor clientId is provided', async () => {
      const result = await svc.listWorkQueue({});
      expect(result).toEqual([]);
    });

    it('respects limit — slices to limit', async () => {
      vi.mocked(repos.taskRepo.listForClientId).mockResolvedValueOnce([FAKE_TASK, { ...FAKE_TASK, id: 'task_002' }, { ...FAKE_TASK, id: 'task_003' }]);
      const result = await svc.listWorkQueue({ clientId: 'client_001', limit: 2 });
      expect(result.length).toBe(2);
    });

    it('applies statusFilter when provided', async () => {
      await svc.listWorkQueue({ clientId: 'client_001', statusFilter: 'OPERATOR_APPROVED' });
      expect(repos.taskRepo.listForClientId).toHaveBeenCalledWith('client_001', 'OPERATOR_APPROVED');
    });

    it('result items contain no raw PII — sourceRef is checked', async () => {
      vi.mocked(repos.taskRepo.listForClientId).mockResolvedValueOnce([
        { ...FAKE_TASK, sourceRef: 'contact admin@example.com' },
      ]);
      const result = await svc.listWorkQueue({ clientId: 'client_001' });
      expect(result[0]?.sourceRef).toBe('[REDACTED]');
    });
  });

  describe('listDueFollowUps', () => {
    it('calls followUpRepo.listDueAsOf with provided clientId and asOf', async () => {
      const asOf = new Date();
      await svc.listDueFollowUps({ clientId: 'client_001', asOf });
      expect(repos.followUpRepo.listDueAsOf).toHaveBeenCalledWith(asOf, 'client_001');
    });

    it('uses current time as asOf when not provided', async () => {
      await svc.listDueFollowUps({ clientId: 'client_001' });
      expect(repos.followUpRepo.listDueAsOf).toHaveBeenCalled();
    });

    it('respects limit parameter', async () => {
      vi.mocked(repos.followUpRepo.listDueAsOf).mockResolvedValueOnce([FAKE_FOLLOW_UP, { ...FAKE_FOLLOW_UP, id: 'fu_002' }]);
      const result = await svc.listDueFollowUps({ clientId: 'client_001', limit: 1 });
      expect(result.length).toBe(1);
    });

    it('returns SafeFollowUp[] — no vault fields in response shape', async () => {
      const result = await svc.listDueFollowUps({ clientId: 'client_001' });
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
    });
  });

  describe('listBlockedWorkflows', () => {
    it('returns only BLOCKED workflow runs', async () => {
      vi.mocked(repos.workflowRunRepo.listForClient).mockResolvedValueOnce([
        { ...FAKE_WORKFLOW_RUN, status: 'BLOCKED' as const },
        { ...FAKE_WORKFLOW_RUN, id: 'run_002', status: 'IN_PROGRESS' as const },
      ]);
      const result = await svc.listBlockedWorkflows({ clientId: 'client_001' });
      expect(result.length).toBe(1);
      expect(result[0]?.status).toBe('BLOCKED');
    });

    it('returns empty array when clientId is not provided', async () => {
      const result = await svc.listBlockedWorkflows({});
      expect(result).toEqual([]);
    });

    it('respects limit parameter', async () => {
      vi.mocked(repos.workflowRunRepo.listForClient).mockResolvedValueOnce([
        { ...FAKE_WORKFLOW_RUN, status: 'BLOCKED' as const },
        { ...FAKE_WORKFLOW_RUN, id: 'run_002', status: 'BLOCKED' as const },
        { ...FAKE_WORKFLOW_RUN, id: 'run_003', status: 'BLOCKED' as const },
      ]);
      const result = await svc.listBlockedWorkflows({ clientId: 'client_001', limit: 2 });
      expect(result.length).toBe(2);
    });
  });

  describe('listReadyPackets', () => {
    it('returns only READY packets', async () => {
      vi.mocked(repos.packetRepo.listForClient).mockResolvedValueOnce([
        { ...FAKE_PACKET, status: 'READY' as const },
        { ...FAKE_PACKET, id: 'pkt_002', status: 'DRAFT' as const },
      ]);
      const result = await svc.listReadyPackets({ clientId: 'client_001' });
      expect(result.length).toBe(1);
      expect(result[0]?.status).toBe('READY');
    });

    it('returns empty array when clientId is not provided', async () => {
      const result = await svc.listReadyPackets({});
      expect(result).toEqual([]);
    });

    it('respects limit parameter', async () => {
      vi.mocked(repos.packetRepo.listForClient).mockResolvedValueOnce([
        { ...FAKE_PACKET, status: 'READY' as const },
        { ...FAKE_PACKET, id: 'pkt_002', status: 'READY' as const },
      ]);
      const result = await svc.listReadyPackets({ clientId: 'client_001', limit: 1 });
      expect(result.length).toBe(1);
    });

    it('result contains no vault fields', async () => {
      const result = await svc.listReadyPackets({ clientId: 'client_001' });
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('storageKey');
    });
  });

  describe('getClientProgress', () => {
    it('returns ok(ClientProgress) with correct counts', async () => {
      const result = await svc.getClientProgress('client_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.clientId).toBe('client_001');
      expect(result.value.totalCases).toBe(1);
    });

    it('returns CLIENT_NOT_FOUND when client does not exist', async () => {
      vi.mocked(repos.clientRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.getClientProgress('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('CLIENT_NOT_FOUND');
    });

    it('progress shape contains no vault fields', async () => {
      const result = await svc.getClientProgress('client_001');
      expect(JSON.stringify(result)).not.toContain('ciphertext');
    });
  });

  describe('getCaseProgress', () => {
    it('returns ok(CaseProgress) when clientId matches case.clientId', async () => {
      const result = await svc.getCaseProgress('case_001', 'client_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.caseId).toBe('case_001');
      expect(result.value.clientId).toBe('client_001');
    });

    it('returns FORBIDDEN when clientId does not match case.clientId', async () => {
      vi.mocked(repos.caseRepo.findById).mockResolvedValueOnce({ ...FAKE_CASE, clientId: 'client_OTHER' });
      const result = await svc.getCaseProgress('case_001', 'client_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FORBIDDEN');
    });

    it('FORBIDDEN result contains no case data in value', async () => {
      vi.mocked(repos.caseRepo.findById).mockResolvedValueOnce({ ...FAKE_CASE, clientId: 'client_OTHER' });
      const result = await svc.getCaseProgress('case_001', 'client_001');
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('value');
    });

    it('returns NOT_FOUND when case does not exist', async () => {
      vi.mocked(repos.caseRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.getCaseProgress('missing', 'client_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });

    it('CaseProgress contains task counts by status', async () => {
      vi.mocked(repos.taskRepo.listForCase).mockResolvedValueOnce([
        FAKE_TASK,
        { ...FAKE_TASK, id: 'task_002', status: 'VERIFIED_REMOVED' as const },
      ]);
      const result = await svc.getCaseProgress('case_001', 'client_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalTasks).toBe(2);
      expect(result.value.taskCountByStatus['OPERATOR_APPROVED']).toBe(1);
      expect(result.value.taskCountByStatus['VERIFIED_REMOVED']).toBe(1);
    });
  });

  describe('getTaskProgress', () => {
    it('returns ok(TaskProgress) when resolved case clientId matches requestClientId', async () => {
      const result = await svc.getTaskProgress('task_001', 'client_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskId).toBe('task_001');
      expect(result.value.caseId).toBe('case_001');
    });

    it('returns FORBIDDEN when case.clientId !== requestClientId', async () => {
      vi.mocked(repos.caseRepo.findById).mockResolvedValueOnce({ ...FAKE_CASE, clientId: 'client_OTHER' });
      const result = await svc.getTaskProgress('task_001', 'client_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FORBIDDEN');
    });

    it('returns NOT_FOUND when task does not exist', async () => {
      vi.mocked(repos.taskRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.getTaskProgress('missing', 'client_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when parent case does not exist', async () => {
      vi.mocked(repos.caseRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.getTaskProgress('task_001', 'client_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });
  });

  describe('getRecentActivity', () => {
    it('calls timelineRepo.listForCase when caseId filter is provided', async () => {
      await svc.getRecentActivity({ caseId: 'case_001' });
      expect(repos.timelineRepo.listForCase).toHaveBeenCalledWith('case_001');
      expect(repos.timelineRepo.listRecentForClient).not.toHaveBeenCalled();
    });

    it('calls timelineRepo.listRecentForClient when only clientId is provided', async () => {
      await svc.getRecentActivity({ clientId: 'client_001' });
      expect(repos.timelineRepo.listRecentForClient).toHaveBeenCalledWith('client_001', expect.any(Number));
      expect(repos.timelineRepo.listForCase).not.toHaveBeenCalled();
    });

    it('respects limit parameter', async () => {
      const manyEvents = Array.from({ length: 10 }, (_, i) => ({ ...FAKE_TIMELINE_EVENT, id: `te_${i}` }));
      vi.mocked(repos.timelineRepo.listForCase).mockResolvedValueOnce(manyEvents);
      const result = await svc.getRecentActivity({ caseId: 'case_001', limit: 3 });
      expect(result.length).toBe(3);
    });

    it('returns empty array when no filter is provided', async () => {
      const result = await svc.getRecentActivity({});
      expect(result).toEqual([]);
    });

    it('SafeTimelineEntry contains no vault fields or actorId', async () => {
      const result = await svc.getRecentActivity({ caseId: 'case_001' });
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('actorId');
    });
  });
});
