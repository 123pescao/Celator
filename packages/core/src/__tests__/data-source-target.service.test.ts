import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSourceTargetService } from '../services/data-source-target.service.js';
import type { DataSourceTargetRepository } from '@celator/db';
import type { ActionType } from '@celator/db';

const FAKE_TARGET = {
  id: 'dst_001',
  sourceName: 'Example Data Broker',
  sourceType: 'DATA_BROKER' as const,
  baseDomain: 'databroker.invalid',
  jurisdiction: null,
  supportedActionTypes: ['OPT_OUT'] as ActionType[],
  requiresLogin: false,
  requiresCaptcha: false,
  manualOnly: false,
  piiRequiredFields: ['EMAIL', 'FULL_NAME'],
  notes: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRepo(overrides?: Partial<DataSourceTargetRepository>): DataSourceTargetRepository {
  return {
    create: vi.fn().mockResolvedValue(FAKE_TARGET),
    findById: vi.fn().mockResolvedValue(FAKE_TARGET),
    findBySourceName: vi.fn().mockResolvedValue(null),
    listActive: vi.fn().mockResolvedValue([FAKE_TARGET]),
    list: vi.fn().mockResolvedValue([FAKE_TARGET]),
    setActive: vi.fn().mockResolvedValue({ ...FAKE_TARGET, isActive: false }),
    update: vi.fn().mockResolvedValue(FAKE_TARGET),
    ...overrides,
  } as unknown as DataSourceTargetRepository;
}

describe('DataSourceTargetService', () => {
  let repo: DataSourceTargetRepository;
  let svc: DataSourceTargetService;

  beforeEach(() => {
    repo = makeRepo();
    svc = new DataSourceTargetService(repo);
  });

  describe('create', () => {
    it('creates a target when sourceName is unique', async () => {
      const result = await svc.create({
        sourceName: 'Example Data Broker',
        sourceType: 'DATA_BROKER',
        piiRequiredFields: ['EMAIL'],
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.id).toBe('dst_001');
      expect(repo.create).toHaveBeenCalledOnce();
    });

    it('rejects empty sourceName', async () => {
      const result = await svc.create({ sourceName: '  ', sourceType: 'DATA_BROKER' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    });

    it('rejects duplicate sourceName', async () => {
      vi.mocked(repo.findBySourceName).mockResolvedValueOnce(FAKE_TARGET);
      const result = await svc.create({ sourceName: 'Example Data Broker', sourceType: 'DATA_BROKER' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('VALIDATION_ERROR');
        expect(result.message).toContain('already exists');
      }
    });
  });

  describe('getById', () => {
    it('returns the target when found', async () => {
      const result = await svc.getById('dst_001');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.sourceName).toBe('Example Data Broker');
    });

    it('returns DATA_SOURCE_TARGET_NOT_FOUND when missing', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.getById('missing');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('DATA_SOURCE_TARGET_NOT_FOUND');
    });
  });

  describe('getByName', () => {
    it('returns the target when found', async () => {
      vi.mocked(repo.findBySourceName).mockResolvedValueOnce(FAKE_TARGET);
      const result = await svc.getByName('Example Data Broker');
      expect(result.ok).toBe(true);
    });

    it('returns DATA_SOURCE_TARGET_NOT_FOUND when missing', async () => {
      const result = await svc.getByName('nonexistent');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('DATA_SOURCE_TARGET_NOT_FOUND');
    });
  });

  describe('listActive', () => {
    it('returns active targets', async () => {
      const targets = await svc.listActive();
      expect(targets).toHaveLength(1);
      expect(targets[0]?.isActive).toBe(true);
    });

    it('passes sourceType filter to repo', async () => {
      await svc.listActive('DATA_BROKER');
      expect(repo.listActive).toHaveBeenCalledWith('DATA_BROKER');
    });
  });

  describe('list', () => {
    it('returns all targets when no filter', async () => {
      const targets = await svc.list();
      expect(targets).toHaveLength(1);
    });

    it('passes isActive filter through', async () => {
      await svc.list(false);
      expect(repo.list).toHaveBeenCalledWith(false);
    });
  });

  describe('update', () => {
    it('updates an existing target', async () => {
      const result = await svc.update('dst_001', { isActive: false, notes: 'Disabled for testing' });
      expect(result.ok).toBe(true);
      expect(repo.update).toHaveBeenCalledWith('dst_001', expect.objectContaining({ isActive: false }));
    });

    it('returns DATA_SOURCE_TARGET_NOT_FOUND for missing target', async () => {
      vi.mocked(repo.findById).mockResolvedValueOnce(null);
      const result = await svc.update('missing', { isActive: false });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('DATA_SOURCE_TARGET_NOT_FOUND');
    });

    it('does not include undefined fields in update payload', async () => {
      await svc.update('dst_001', { isActive: true });
      const updateCall = vi.mocked(repo.update).mock.calls[0]?.[1];
      expect(updateCall).not.toHaveProperty('notes');
    });
  });
});
