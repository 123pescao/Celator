import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemovalRequestPacketService } from '../services/removal-request-packet.service.js';
import type {
  RemovalRequestPacketRepository,
  PacketWithItems,
  CleanupTaskRepository,
  DataSourceTargetRepository,
} from '@celator/db';
import type { IdentityVaultIntakeService } from '../services/identity-vault-intake.service.js';
import type { AuditService } from '../services/audit.service.js';
import type { CaseTimelineService } from '../services/case-timeline.service.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_TASK = {
  id: 'task_001',
  caseId: 'case_001',
  dataSourceTargetId: 'dst_001',
  status: 'OPERATOR_APPROVED' as const,
  actionType: 'OPT_OUT' as const,
  matchStatus: 'CONFIRMED_MATCH' as const,
  riskTier: 'STANDARD' as const,
  sourceRef: 'test-broker',
  findingUrl: null,
  preparedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_TARGET = {
  id: 'dst_001',
  sourceName: 'Example Data Broker',
  sourceType: 'DATA_BROKER' as const,
  piiRequiredFields: ['EMAIL', 'FULL_NAME'],
  supportedActionTypes: ['OPT_OUT' as const],
  baseDomain: null,
  jurisdiction: null,
  requiresLogin: false,
  requiresCaptcha: false,
  manualOnly: false,
  notes: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_PACKET = {
  id: 'pkt_001',
  taskId: 'task_001',
  clientId: 'client_001',
  dataSourceTargetId: 'dst_001',
  status: 'DRAFT' as const,
  redactedSummary: 'OPT_OUT packet for Example Data Broker — 2 required fields (0 ready, 2 missing)',
  preparedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_ITEM = {
  id: 'item_001',
  packetId: 'pkt_001',
  itemOrder: 1,
  itemKind: 'VERIFY_CONSENT',
  label: 'Verify client consent is active and covers this action type',
  status: 'PENDING' as const,
  requiredFieldType: null,
  operatorNotes: null,
  completedAt: null,
  createdAt: new Date(),
};

const FAKE_PACKET_WITH_ITEMS: PacketWithItems = {
  ...FAKE_PACKET,
  items: [FAKE_ITEM],
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePacketRepo(overrides?: Partial<RemovalRequestPacketRepository>): RemovalRequestPacketRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_PACKET),
    createItem: vi.fn().mockResolvedValue(FAKE_ITEM),
    findById: vi.fn().mockResolvedValue(FAKE_PACKET),
    findByIdWithItems: vi.fn().mockResolvedValue(FAKE_PACKET_WITH_ITEMS),
    findItemById: vi.fn().mockResolvedValue(FAKE_ITEM),
    listForTask: vi.fn().mockResolvedValue([FAKE_PACKET]),
    listForClient: vi.fn().mockResolvedValue([FAKE_PACKET]),
    updateStatus: vi.fn().mockResolvedValue({ ...FAKE_PACKET, status: 'READY' }),
    updateItemStatus: vi.fn().mockResolvedValue({ ...FAKE_ITEM, status: 'COMPLETED' }),
    ...overrides,
  } as unknown as RemovalRequestPacketRepository;
}

function makeTaskRepo(): CleanupTaskRepository {
  return {
    findById: vi.fn().mockResolvedValue(FAKE_TASK),
    create: vi.fn(),
    listForCase: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn(),
    update: vi.fn(),
    bulkUpdateStatus: vi.fn(),
  } as unknown as CleanupTaskRepository;
}

function makeTargetRepo(): DataSourceTargetRepository {
  return {
    findById: vi.fn().mockResolvedValue(FAKE_TARGET),
    create: vi.fn(),
    update: vi.fn(),
    findBySourceName: vi.fn(),
    list: vi.fn(),
    listActive: vi.fn(),
    setActive: vi.fn(),
  } as unknown as DataSourceTargetRepository;
}

function makeVaultService(): IdentityVaultIntakeService {
  return {
    listMetadata: vi.fn().mockResolvedValue([]),
    store: vi.fn(),
    logAccess: vi.fn(),
  } as unknown as IdentityVaultIntakeService;
}

function makeAudit(): AuditService {
  return { write: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as unknown as AuditService;
}

function makeTimeline(): CaseTimelineService {
  return { append: vi.fn().mockResolvedValue({}), listForCase: vi.fn(), listForTask: vi.fn() } as unknown as CaseTimelineService;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RemovalRequestPacketService', () => {
  let packetRepo: RemovalRequestPacketRepository;
  let taskRepo: CleanupTaskRepository;
  let targetRepo: DataSourceTargetRepository;
  let vaultService: IdentityVaultIntakeService;
  let audit: AuditService;
  let timeline: CaseTimelineService;
  let svc: RemovalRequestPacketService;

  beforeEach(() => {
    packetRepo = makePacketRepo();
    taskRepo = makeTaskRepo();
    targetRepo = makeTargetRepo();
    vaultService = makeVaultService();
    audit = makeAudit();
    timeline = makeTimeline();
    svc = new RemovalRequestPacketService(packetRepo, taskRepo, targetRepo, vaultService, audit, timeline);
  });

  describe('generateForTask', () => {
    it('creates packet with checklist items', async () => {
      const result = await svc.generateForTask({ taskId: 'task_001', clientId: 'client_001' }, 'actor_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskId).toBe('task_001');
      expect(result.value.items.length).toBeGreaterThan(0);
    });

    it('returns NOT_FOUND when task missing', async () => {
      vi.mocked(taskRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.generateForTask({ taskId: 'missing', clientId: 'client_001' }, 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('NOT_FOUND');
    });

    it('writes REMOVAL_PACKET_GENERATED audit event', async () => {
      await svc.generateForTask({ taskId: 'task_001', clientId: 'client_001' }, 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'REMOVAL_PACKET_GENERATED' }));
    });

    it('response contains no ciphertext or vault fields', async () => {
      const result = await svc.generateForTask({ taskId: 'task_001', clientId: 'client_001' }, 'actor_001');
      expect(result.ok).toBe(true);
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
      expect(json).not.toContain('encryptedKeyRef');
    });

    it('audit metadata does not contain raw PII fields', async () => {
      await svc.generateForTask({ taskId: 'task_001', clientId: 'client_001' }, 'actor_001');
      const call = vi.mocked(audit.write).mock.calls.find(([a]) => a.eventType === 'REMOVAL_PACKET_GENERATED');
      expect(call).toBeDefined();
      const meta = JSON.stringify(call![0].metadata);
      expect(meta).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    });
  });

  describe('completeItem', () => {
    it('marks item COMPLETED', async () => {
      const result = await svc.completeItem('pkt_001', 'item_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(packetRepo.updateItemStatus).toHaveBeenCalledWith('item_001', 'COMPLETED', expect.any(Object));
    });

    it('returns FORBIDDEN when clientId does not match packet', async () => {
      vi.mocked(packetRepo.findById).mockResolvedValueOnce({ ...FAKE_PACKET, clientId: 'client_OTHER' });
      const result = await svc.completeItem('pkt_001', 'item_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FORBIDDEN');
    });

    it('rejects when packet is COMPLETED (terminal)', async () => {
      vi.mocked(packetRepo.findById).mockResolvedValueOnce({ ...FAKE_PACKET, status: 'COMPLETED' });
      const result = await svc.completeItem('pkt_001', 'item_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PACKET_INVALID_STATUS');
    });

    it('rejects when packet is CANCELLED (terminal)', async () => {
      vi.mocked(packetRepo.findById).mockResolvedValueOnce({ ...FAKE_PACKET, status: 'CANCELLED' });
      const result = await svc.completeItem('pkt_001', 'item_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PACKET_INVALID_STATUS');
    });

    it('rejects when item is already COMPLETED', async () => {
      vi.mocked(packetRepo.findItemById).mockResolvedValueOnce({ ...FAKE_ITEM, status: 'COMPLETED' });
      const result = await svc.completeItem('pkt_001', 'item_001', {}, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PACKET_INVALID_STATUS');
    });

    it('rejects PII (email) in operatorNotes', async () => {
      const result = await svc.completeItem('pkt_001', 'item_001', { operatorNotes: 'Contact admin@example.com' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_UNSAFE_TEXT');
    });

    it('rejects PII (phone) in operatorNotes', async () => {
      const result = await svc.completeItem('pkt_001', 'item_001', { operatorNotes: 'Call 555-123-4567' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_UNSAFE_TEXT');
    });

    it('writes REMOVAL_PACKET_ITEM_COMPLETED audit event', async () => {
      await svc.completeItem('pkt_001', 'item_001', {}, 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'REMOVAL_PACKET_ITEM_COMPLETED' }));
    });
  });

  describe('blockItem', () => {
    it('marks item BLOCKED', async () => {
      const result = await svc.blockItem('pkt_001', 'item_001', { reason: 'Broker portal unavailable' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(packetRepo.updateItemStatus).toHaveBeenCalledWith('item_001', 'BLOCKED', expect.any(Object));
    });

    it('returns FORBIDDEN when clientId does not match packet', async () => {
      vi.mocked(packetRepo.findById).mockResolvedValueOnce({ ...FAKE_PACKET, clientId: 'client_OTHER' });
      const result = await svc.blockItem('pkt_001', 'item_001', { reason: 'Blocked' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FORBIDDEN');
    });

    it('rejects PII (email) in reason', async () => {
      const result = await svc.blockItem('pkt_001', 'item_001', { reason: 'Contact admin@example.com' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('WORKFLOW_UNSAFE_TEXT');
    });

    it('rejects when item already BLOCKED (terminal)', async () => {
      vi.mocked(packetRepo.findItemById).mockResolvedValueOnce({ ...FAKE_ITEM, status: 'BLOCKED' });
      const result = await svc.blockItem('pkt_001', 'item_001', { reason: 'Already blocked' }, 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PACKET_INVALID_STATUS');
    });

    it('writes REMOVAL_PACKET_ITEM_BLOCKED audit event', async () => {
      await svc.blockItem('pkt_001', 'item_001', { reason: 'Portal down' }, 'client_001', 'actor_001');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'REMOVAL_PACKET_ITEM_BLOCKED', outcome: 'BLOCKED' }));
    });
  });

  describe('getById', () => {
    it('returns packet for correct clientId', async () => {
      const result = await svc.getById('pkt_001', 'client_001');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('pkt_001');
    });

    it('returns FORBIDDEN for wrong clientId (not NOT_FOUND — no resource-existence leak)', async () => {
      vi.mocked(packetRepo.findByIdWithItems).mockResolvedValueOnce({ ...FAKE_PACKET_WITH_ITEMS, clientId: 'client_OTHER' });
      const result = await svc.getById('pkt_001', 'client_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('FORBIDDEN');
    });

    it('returns PACKET_NOT_FOUND for missing packet', async () => {
      vi.mocked(packetRepo.findByIdWithItems).mockResolvedValueOnce(null);
      const result = await svc.getById('missing', 'client_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PACKET_NOT_FOUND');
    });
  });

  describe('markReady', () => {
    it('transitions DRAFT packet to READY', async () => {
      const result = await svc.markReady('pkt_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(true);
      expect(packetRepo.updateStatus).toHaveBeenCalledWith('pkt_001', 'READY');
    });

    it('rejects if packet is not DRAFT', async () => {
      vi.mocked(packetRepo.findById).mockResolvedValueOnce({ ...FAKE_PACKET, status: 'READY' });
      const result = await svc.markReady('pkt_001', 'client_001', 'actor_001');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('PACKET_INVALID_STATUS');
    });
  });

  describe('listForTask and listForClient', () => {
    it('listForTask returns packet headers without items', async () => {
      const result = await svc.listForTask('task_001');
      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('items');
    });

    it('listForClient returns headers with no vault fields', async () => {
      const result = await svc.listForClient('client_001');
      const json = JSON.stringify(result);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
    });
  });
});
