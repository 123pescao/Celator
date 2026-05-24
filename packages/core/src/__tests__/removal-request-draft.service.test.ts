import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemovalRequestDraftService } from '../services/removal-request-draft.service.js';
import type { DataSourceTargetRepository } from '@celator/db';
import type { ActionType } from '@celator/db';
import type { IdentityVaultIntakeService } from '../services/identity-vault-intake.service.js';

const FAKE_TARGET = {
  id: 'dst_001',
  sourceName: 'Example Data Broker',
  sourceType: 'DATA_BROKER' as const,
  baseDomain: 'databroker.invalid',
  jurisdiction: null,
  supportedActionTypes: ['OPT_OUT', 'DELETE_PERSONAL_DATA'] as ActionType[],
  requiresLogin: false,
  requiresCaptcha: false,
  manualOnly: false,
  piiRequiredFields: ['EMAIL', 'FULL_NAME'],
  notes: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FAKE_VAULT_METADATA = [
  {
    id: 'vr_001',
    clientId: 'client_001',
    fieldType: 'EMAIL',
    redactedDisplay: 'a***@example.com',
    isCryptoShredded: false,
    createdAt: new Date(),
  },
];

function makeTargetRepo(overrides?: Partial<DataSourceTargetRepository>): DataSourceTargetRepository {
  return {
    findById: vi.fn().mockResolvedValue(FAKE_TARGET),
    findBySourceName: vi.fn().mockResolvedValue(null),
    listActive: vi.fn().mockResolvedValue([FAKE_TARGET]),
    list: vi.fn().mockResolvedValue([FAKE_TARGET]),
    create: vi.fn(),
    update: vi.fn(),
    setActive: vi.fn(),
    ...overrides,
  } as unknown as DataSourceTargetRepository;
}

function makeVaultService(overrides?: Partial<IdentityVaultIntakeService>): IdentityVaultIntakeService {
  return {
    listMetadata: vi.fn().mockResolvedValue(FAKE_VAULT_METADATA),
    store: vi.fn(),
    logAccess: vi.fn(),
    ...overrides,
  } as unknown as IdentityVaultIntakeService;
}

describe('RemovalRequestDraftService', () => {
  let targetRepo: DataSourceTargetRepository;
  let vaultService: IdentityVaultIntakeService;
  let svc: RemovalRequestDraftService;

  beforeEach(() => {
    targetRepo = makeTargetRepo();
    vaultService = makeVaultService();
    svc = new RemovalRequestDraftService(targetRepo, vaultService);
  });

  describe('buildDraft', () => {
    it('returns a draft with correct target metadata', async () => {
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targetId).toBe('dst_001');
      expect(result.value.targetName).toBe('Example Data Broker');
      expect(result.value.sourceType).toBe('DATA_BROKER');
    });

    it('shows EMAIL as present with redacted display', async () => {
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const emailStatus = result.value.vaultFieldStatuses.find((s) => s.fieldType === 'EMAIL');
      expect(emailStatus).toBeDefined();
      expect(emailStatus?.isPresent).toBe(true);
      expect(emailStatus?.redactedDisplay).toBe('a***@example.com');
      expect(emailStatus?.recordId).toBe('vr_001');
    });

    it('shows FULL_NAME as missing when no vault record', async () => {
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const nameStatus = result.value.vaultFieldStatuses.find((s) => s.fieldType === 'FULL_NAME');
      expect(nameStatus?.isPresent).toBe(false);
      expect(nameStatus?.redactedDisplay).toBeNull();
      expect(nameStatus?.recordId).toBeNull();
    });

    it('reports missingFields correctly', async () => {
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.missingFields).toContain('FULL_NAME');
      expect(result.value.missingFields).not.toContain('EMAIL');
    });

    it('isReadyForReview is false when fields are missing', async () => {
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.isReadyForReview).toBe(false);
    });

    it('isReadyForReview is true when all fields are present', async () => {
      vi.mocked(vaultService.listMetadata).mockResolvedValueOnce([
        { id: 'vr_001', clientId: 'client_001', fieldType: 'EMAIL', redactedDisplay: 'a***@example.com', isCryptoShredded: false, createdAt: new Date() },
        { id: 'vr_002', clientId: 'client_001', fieldType: 'FULL_NAME', redactedDisplay: 'A*** [REDACTED_NAME]', isCryptoShredded: false, createdAt: new Date() },
      ]);

      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.isReadyForReview).toBe(true);
      expect(result.value.missingFields).toHaveLength(0);
    });

    it('excludes crypto-shredded vault records from field matching', async () => {
      vi.mocked(vaultService.listMetadata).mockResolvedValueOnce([
        { id: 'vr_001', clientId: 'client_001', fieldType: 'EMAIL', redactedDisplay: null, isCryptoShredded: true, createdAt: new Date() },
      ]);

      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const emailStatus = result.value.vaultFieldStatuses.find((s) => s.fieldType === 'EMAIL');
      expect(emailStatus?.isPresent).toBe(false);
      expect(result.value.missingFields).toContain('EMAIL');
    });

    it('returns DATA_SOURCE_TARGET_NOT_FOUND for unknown target', async () => {
      vi.mocked(targetRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'missing' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('DATA_SOURCE_TARGET_NOT_FOUND');
    });

    it('returns VALIDATION_ERROR for inactive target', async () => {
      vi.mocked(targetRepo.findById).mockResolvedValueOnce({ ...FAKE_TARGET, isActive: false });
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('draft response contains no plaintext PII', async () => {
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const json = JSON.stringify(result.value);
      // Raw/unredacted form must not appear
      expect(json).not.toContain('alice@example.com');
      // The redacted display IS allowed
      expect(json).toContain('a***@example.com');
    });

    it('draft response contains no ciphertext', async () => {
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const json = JSON.stringify(result.value);
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('authTag');
      expect(json).not.toContain('encryptedKeyRef');
    });

    it('draftSummary includes target name and field status', async () => {
      const result = await svc.buildDraft({ clientId: 'client_001', dataSourceTargetId: 'dst_001' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.draftSummary).toContain('Example Data Broker');
      expect(result.value.draftSummary).toContain('EMAIL');
    });
  });
});
