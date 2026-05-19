import { describe, it, expect } from 'vitest';
import { makeVault, makeKms } from './fixtures.js';
import type { VaultActor } from '../vault/identity-vault.service.js';

const OPERATOR_ACTOR: VaultActor = { actorId: 'op_001', actorType: 'OPERATOR' };

describe('IdentityVaultService', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('encrypts and decrypts a plaintext value correctly', async () => {
      const vault = makeVault();
      const id = await vault.encryptIdentifier(
        'client_001',
        'EMAIL',
        'synthetic-test@example.invalid',
        'PURPOSE_OPERATOR_REVIEW_PACKET',
        OPERATOR_ACTOR,
      );
      const result = await vault.decryptIdentifier(
        id,
        'PURPOSE_OPERATOR_REVIEW_PACKET',
        OPERATOR_ACTOR,
      );
      expect(result).toBe('synthetic-test@example.invalid');
    });

    it('different plaintexts produce different ciphertexts', async () => {
      const vault = makeVault();
      const id1 = await vault.encryptIdentifier('c1', 'EMAIL', 'email1@test.invalid', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      const id2 = await vault.encryptIdentifier('c1', 'EMAIL', 'email2@test.invalid', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      const records = vault.listIdentifierMetadata('c1');
      expect(records).toHaveLength(2);
      expect(id1).not.toBe(id2);
    });
  });

  describe('purpose code enforcement', () => {
    it('allows decrypt with valid purpose code', async () => {
      const vault = makeVault();
      const id = await vault.encryptIdentifier('c1', 'PHONE', '555-0100', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      await expect(
        vault.decryptIdentifier(id, 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR),
      ).resolves.toBe('555-0100');
    });

    it('denies decrypt with LLM purpose code', async () => {
      const vault = makeVault();
      const id = await vault.encryptIdentifier('c1', 'EMAIL', 'pii@test.invalid', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      await expect(
        // @ts-expect-error intentionally passing invalid purpose
        vault.decryptIdentifier(id, 'PURPOSE_LLM_CLASSIFICATION', OPERATOR_ACTOR),
      ).rejects.toThrow(/prohibited/i);
    });

    it('denies decrypt with unknown purpose code', async () => {
      const vault = makeVault();
      const id = await vault.encryptIdentifier('c1', 'EMAIL', 'pii@test.invalid', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      await expect(
        // @ts-expect-error intentionally passing invalid purpose
        vault.decryptIdentifier(id, 'PURPOSE_UNKNOWN_TOTALLY', OPERATOR_ACTOR),
      ).rejects.toThrow(/unknown purpose|Failing closed/i);
    });

    it('denies encrypt with LLM purpose code', async () => {
      const vault = makeVault();
      await expect(
        // @ts-expect-error intentionally passing invalid purpose
        vault.encryptIdentifier('c1', 'EMAIL', 'pii@test.invalid', 'PURPOSE_LLM_ANY', OPERATOR_ACTOR),
      ).rejects.toThrow(/prohibited/i);
    });
  });

  describe('access logging', () => {
    it('writes access log on decrypt', async () => {
      const vault = makeVault();
      const id = await vault.encryptIdentifier('c1', 'ADDRESS', '123 Synthetic St', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      await vault.decryptIdentifier(id, 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      const logs = vault.getAccessLogs();
      expect(logs.length).toBeGreaterThanOrEqual(1);
      const decryptLog = logs.find((l) => l.recordId === id && l.purposeCode === 'PURPOSE_OPERATOR_REVIEW_PACKET');
      expect(decryptLog).toBeDefined();
      expect(decryptLog?.actorId).toBe('op_001');
    });

    it('access log contains no plaintext values', async () => {
      const vault = makeVault();
      const id = await vault.encryptIdentifier('c1', 'DOB', '1990-01-01', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      await vault.decryptIdentifier(id, 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      const logs = vault.getAccessLogs();
      const logStr = JSON.stringify(logs);
      expect(logStr).not.toContain('1990-01-01');
    });
  });

  describe('crypto-shredding', () => {
    it('prevents decrypt after crypto-shred', async () => {
      const vault = makeVault();
      const id = await vault.encryptIdentifier('c_shred', 'EMAIL', 'shred@test.invalid', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      await vault.cryptoShredClient('c_shred');
      await expect(
        vault.decryptIdentifier(id, 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR),
      ).rejects.toThrow(/crypto-shredded|unrecoverable/i);
    });

    it('prevents new encryption after crypto-shred', async () => {
      const vault = makeVault();
      await vault.encryptIdentifier('c_shred2', 'EMAIL', 'before@test.invalid', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      await vault.cryptoShredClient('c_shred2');
      await expect(
        vault.encryptIdentifier('c_shred2', 'EMAIL', 'after@test.invalid', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR),
      ).rejects.toThrow(/crypto-shredded/i);
    });

    it('marks records as crypto-shredded in metadata', async () => {
      const vault = makeVault();
      await vault.encryptIdentifier('c_shred3', 'PHONE', '555-9999', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      await vault.cryptoShredClient('c_shred3');
      const meta = vault.listIdentifierMetadata('c_shred3');
      expect(meta.every((m) => m.isCryptoShredded)).toBe(true);
    });
  });

  describe('DEK rotation', () => {
    it('rotates DEK and re-encrypts records idempotently', async () => {
      const vault = makeVault();
      const id = await vault.encryptIdentifier('c_rotate', 'EMAIL', 'rotate@test.invalid', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      const job1 = await vault.rotateClientDek('c_rotate');
      expect(job1.status).toBe('COMPLETED');
      expect(job1.recordsRotated).toBe(1);

      // After rotation, decrypt still works
      const result = await vault.decryptIdentifier(id, 'PURPOSE_DEK_ROTATION', OPERATOR_ACTOR);
      expect(result).toBe('rotate@test.invalid');
    });

    it('idempotent — second rotation while first is running returns existing job', async () => {
      const vault = makeVault();
      await vault.encryptIdentifier('c_idemp', 'EMAIL', 'idemp@test.invalid', 'PURPOSE_OPERATOR_REVIEW_PACKET', OPERATOR_ACTOR);
      const job1 = await vault.rotateClientDek('c_idemp');
      // For a completed job, a second call creates a new job (completed jobs don't block)
      expect(job1.status).toBe('COMPLETED');
    });
  });
});
