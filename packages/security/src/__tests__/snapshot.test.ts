import { describe, it, expect } from 'vitest';
import { makeSnapshotService, makeKms } from './fixtures.js';
import type { SnapshotPayload } from '../approval/approval-snapshot.service.js';

const BASE_PAYLOAD: SnapshotPayload = {
  taskId: 'task_001',
  clientId: 'client_001',
  caseId: 'case_001',
  actionType: 'OPT_OUT',
  sourceRef: 'test-broker',
  submissionFields: { field1: 'value1' },
  evidenceIds: ['ev_001', 'ev_002'],
};

describe('ApprovalSnapshotService', () => {
  describe('canonicalization and hashing', () => {
    it('produces same hash regardless of key order', () => {
      const svc = makeSnapshotService();
      const p1 = { ...BASE_PAYLOAD, submissionFields: { a: '1', b: '2' } };
      const p2 = { ...BASE_PAYLOAD, submissionFields: { b: '2', a: '1' } };
      const hash1 = svc.hashPayload(svc.canonicalizePayload(p1));
      const hash2 = svc.hashPayload(svc.canonicalizePayload(p2));
      expect(hash1).toBe(hash2);
    });

    it('different values produce different hashes', () => {
      const svc = makeSnapshotService();
      const p1 = { ...BASE_PAYLOAD, submissionFields: { field: 'value1' } };
      const p2 = { ...BASE_PAYLOAD, submissionFields: { field: 'value2' } };
      const hash1 = svc.hashPayload(svc.canonicalizePayload(p1));
      const hash2 = svc.hashPayload(svc.canonicalizePayload(p2));
      expect(hash1).not.toBe(hash2);
    });

    it('nested key order does not affect hash', () => {
      const svc = makeSnapshotService();
      const p1 = { ...BASE_PAYLOAD, submissionFields: { z: { a: '1', b: '2' }, y: 'val' } };
      const p2 = { ...BASE_PAYLOAD, submissionFields: { y: 'val', z: { b: '2', a: '1' } } };
      const hash1 = svc.hashPayload(svc.canonicalizePayload(p1));
      const hash2 = svc.hashPayload(svc.canonicalizePayload(p2));
      expect(hash1).toBe(hash2);
    });

    it('adding any field changes the hash', () => {
      const svc = makeSnapshotService();
      const original = svc.hashPayload(svc.canonicalizePayload(BASE_PAYLOAD));
      const modified = svc.hashPayload(
        svc.canonicalizePayload({ ...BASE_PAYLOAD, findingUrl: 'https://example.invalid/profile' }),
      );
      expect(original).not.toBe(modified);
    });
  });

  describe('signing and verification', () => {
    it('verifies snapshot with correct signing key version', async () => {
      const kms = makeKms();
      const svc = makeSnapshotService(kms);
      const { snapshot } = await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT', [], 'Test preview',
      );
      expect(await svc.verifySnapshot(snapshot)).toBe(true);
    });

    it('fails verification if signature is tampered', async () => {
      const kms = makeKms();
      const svc = makeSnapshotService(kms);
      const { snapshot } = await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT', [], 'Test preview',
      );
      const tampered = { ...snapshot, snapshotSignature: 'tampered-signature-value' };
      expect(await svc.verifySnapshot(tampered)).toBe(false);
    });

    it('fails verification with unknown key version', async () => {
      const kms = makeKms();
      const svc = makeSnapshotService(kms);
      const { snapshot } = await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT', [], 'Test preview',
      );
      const withBadVersion = { ...snapshot, signingKeyVersion: 'v0-unknown-version' };
      expect(await svc.verifySnapshot(withBadVersion)).toBe(false);
    });
  });

  describe('expiry rules', () => {
    it('STANDARD OPT_OUT snapshot expires in 14 days', async () => {
      const svc = makeSnapshotService();
      const { snapshot } = await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT', [], 'Test',
      );
      const diffDays = Math.round(
        (snapshot.snapshotExpiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(14);
    });

    it('LEGAL_ESCALATION expires in 7 days regardless of tier', async () => {
      const svc = makeSnapshotService();
      const { snapshot } = await svc.createSnapshot(
        'task_001', { ...BASE_PAYLOAD, actionType: 'LEGAL_ESCALATION' },
        'STANDARD', 'LEGAL_ESCALATION', [], 'Legal escalation test',
      );
      const diffDays = Math.round(
        (snapshot.snapshotExpiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(7);
    });

    it('expired snapshot is detected correctly', async () => {
      const svc = makeSnapshotService();
      const { snapshot } = await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT', [], 'Test',
      );
      // Artificially expire
      snapshot.snapshotExpiresAt = new Date(Date.now() - 1000);
      expect(svc.isSnapshotExpired(snapshot)).toBe(true);
    });

    it('marks snapshot as expired', async () => {
      const svc = makeSnapshotService();
      const { snapshot } = await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT', [], 'Test',
      );
      svc.expireSnapshot(snapshot.id);
      const updated = svc.getSnapshot(snapshot.id);
      expect(updated?.snapshotStatus).toBe('EXPIRED');
    });
  });

  describe('lifecycle', () => {
    it('cannot reuse a used snapshot', async () => {
      const svc = makeSnapshotService();
      const { snapshot } = await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT', [], 'Test',
      );
      svc.markSnapshotUsed(snapshot.id);
      expect(() => svc.markSnapshotUsed(snapshot.id)).toThrow();
    });

    it('creates evidence holds for referenced evidence IDs', async () => {
      const svc = makeSnapshotService();
      const { evidenceHolds } = await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT',
        ['ev_001', 'ev_002'], 'Test',
      );
      expect(evidenceHolds).toHaveLength(2);
      expect(evidenceHolds[0]?.evidenceId).toBe('ev_001');
      expect(evidenceHolds[1]?.evidenceId).toBe('ev_002');
    });

    it('evidence is under hold after snapshot creation', async () => {
      const svc = makeSnapshotService();
      await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT', ['ev_hold_001'], 'Test',
      );
      expect(svc.isEvidenceUnderHold('ev_hold_001')).toBe(true);
    });

    it('evidence hold released after snapshot is used', async () => {
      const svc = makeSnapshotService();
      const { snapshot } = await svc.createSnapshot(
        'task_001', BASE_PAYLOAD, 'STANDARD', 'OPT_OUT', ['ev_release_001'], 'Test',
      );
      svc.markSnapshotUsed(snapshot.id);
      // After marking used, holds are released
      const holds = svc.getEvidenceHoldsForSnapshot(snapshot.id);
      expect(holds.every((h) => h.releasedAt !== undefined)).toBe(true);
    });
  });
});
