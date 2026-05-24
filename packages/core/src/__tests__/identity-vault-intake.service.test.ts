import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdentityVaultIntakeService } from '../services/identity-vault-intake.service.js';
import type { IdentityVaultRecordRepository, IdentityVaultAccessLogRepository } from '@celator/db';
import type { KmsProvider } from '@celator/security';

// Fake KMS: generates deterministic keys for testing
function makeKms(): KmsProvider {
  return {
    generateDataKey: vi.fn().mockResolvedValue({
      keyId: 'local-test-v1',
      keyVersion: 'v1',
      plaintextKey: Buffer.alloc(32, 0xab),
      encryptedKeyRef: 'ZmFrZWtleXJlZg==', // base64 'fakekeyref'
    }),
    decryptDataKey: vi.fn().mockResolvedValue(Buffer.alloc(32, 0xab)),
    signSnapshot: vi.fn().mockResolvedValue('sig'),
    verifySnapshot: vi.fn().mockResolvedValue(true),
    rotateClientKey: vi.fn().mockResolvedValue({ oldKeyVersion: 'v0', newKeyVersion: 'v1' }),
    getCurrentSigningKeyVersion: vi.fn().mockReturnValue('v1'),
    isSigningKeyVersionValid: vi.fn().mockReturnValue(true),
  } as unknown as KmsProvider;
}

function makeRecordRepo(overrides?: Partial<IdentityVaultRecordRepository>): IdentityVaultRecordRepository {
  return {
    create: vi.fn().mockImplementation((data: Record<string, unknown>) => Promise.resolve({
      id: 'vr_001',
      clientId: data['clientId'],
      fieldType: data['fieldType'],
      ciphertext: data['ciphertext'],
      iv: data['iv'],
      authTag: data['authTag'],
      keyId: data['keyId'],
      keyVersion: data['keyVersion'],
      encryptedKeyRef: data['encryptedKeyRef'],
      redactedDisplay: data['redactedDisplay'],
      isCryptoShredded: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    findById: vi.fn().mockResolvedValue(null),
    listByClient: vi.fn().mockResolvedValue([]),
    markCryptoShredded: vi.fn(),
    ...overrides,
  } as unknown as IdentityVaultRecordRepository;
}

function makeAccessLogRepo(): IdentityVaultAccessLogRepository {
  return {
    create: vi.fn().mockResolvedValue({
      id: 'val_001',
      recordId: 'vr_001',
      clientId: 'client_001',
      purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
      actorId: 'user_001',
      actorType: 'OPERATOR',
      accessedAt: new Date(),
    }),
    listByRecord: vi.fn().mockResolvedValue([]),
    listByClient: vi.fn().mockResolvedValue([]),
  } as unknown as IdentityVaultAccessLogRepository;
}

describe('IdentityVaultIntakeService', () => {
  let svc: IdentityVaultIntakeService;
  let recordRepo: IdentityVaultRecordRepository;
  let accessLogRepo: IdentityVaultAccessLogRepository;
  let kms: KmsProvider;

  beforeEach(() => {
    kms = makeKms();
    recordRepo = makeRecordRepo();
    accessLogRepo = makeAccessLogRepo();
    svc = new IdentityVaultIntakeService(recordRepo, accessLogRepo, kms);
  });

  describe('store', () => {
    it('stores an email and returns redacted display', async () => {
      const result = await svc.store({
        clientId: 'client_001',
        fieldType: 'EMAIL',
        plaintext: 'alice@example.com',
        purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
        actorId: 'user_001',
        actorType: 'OPERATOR',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.redactedDisplay).toBe('a***@example.com');
        expect(result.value.redactedDisplay).not.toContain('alice');
      }
    });

    it('does not store plaintext in the DB record', async () => {
      await svc.store({
        clientId: 'client_001',
        fieldType: 'EMAIL',
        plaintext: 'alice@example.com',
        purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
        actorId: 'user_001',
        actorType: 'OPERATOR',
      });

      const createCall = vi.mocked(recordRepo.create).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(createCall).toBeDefined();
      // ciphertext should differ from plaintext
      expect(createCall['ciphertext']).not.toBe('alice@example.com');
      // plaintext key should not appear
      expect(JSON.stringify(createCall)).not.toContain('alice@example.com');
    });

    it('stores phone and returns redacted display', async () => {
      const result = await svc.store({
        clientId: 'client_001',
        fieldType: 'PHONE',
        plaintext: '787-555-1212',
        purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
        actorId: 'user_001',
        actorType: 'OPERATOR',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.redactedDisplay).toBe('***-***-1212');
    });

    it('writes an access log entry', async () => {
      await svc.store({
        clientId: 'client_001',
        fieldType: 'EMAIL',
        plaintext: 'alice@example.com',
        purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
        actorId: 'user_001',
        actorType: 'OPERATOR',
      });

      expect(accessLogRepo.create).toHaveBeenCalledOnce();
      const logCall = vi.mocked(accessLogRepo.create).mock.calls[0]?.[0];
      expect(logCall?.actorId).toBe('user_001');
      expect(logCall?.purposeCode).toBe('PURPOSE_OPERATOR_REVIEW_PACKET');
    });

    it('rejects unknown fieldType', async () => {
      const result = await svc.store({
        clientId: 'client_001',
        fieldType: 'CREDIT_CARD', // not a valid vault field type
        plaintext: '4111111111111111',
        purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
        actorId: 'user_001',
        actorType: 'OPERATOR',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VAULT_FIELD_TYPE_INVALID');
    });

    it('rejects invalid purposeCode', async () => {
      const result = await svc.store({
        clientId: 'client_001',
        fieldType: 'EMAIL',
        plaintext: 'alice@example.com',
        purposeCode: 'PURPOSE_LLM_ANY' as never,
        actorId: 'user_001',
        actorType: 'OPERATOR',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VAULT_PURPOSE_DENIED');
    });

    it('propagates encryption failure as VAULT_ENCRYPT_FAILED', async () => {
      vi.mocked(kms.generateDataKey).mockRejectedValueOnce(new Error('KMS error'));
      const result = await svc.store({
        clientId: 'client_001',
        fieldType: 'EMAIL',
        plaintext: 'alice@example.com',
        purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
        actorId: 'user_001',
        actorType: 'OPERATOR',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VAULT_ENCRYPT_FAILED');
    });
  });

  describe('listMetadata', () => {
    it('returns metadata without ciphertext or plaintext', async () => {
      vi.mocked(recordRepo.listByClient).mockResolvedValueOnce([
        {
          id: 'vr_001',
          clientId: 'client_001',
          fieldType: 'EMAIL',
          ciphertext: 'ZW5jcnlwdGVk',
          iv: 'aXY=',
          authTag: 'YXV0aFRhZw==',
          keyId: 'local-test-v1',
          keyVersion: 'v1',
          encryptedKeyRef: 'ZmFrZWtleXJlZg==',
          redactedDisplay: 'a***@example.com',
          isCryptoShredded: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const meta = await svc.listMetadata('client_001');
      expect(meta).toHaveLength(1);
      expect(meta[0]?.fieldType).toBe('EMAIL');
      expect(meta[0]?.redactedDisplay).toBe('a***@example.com');
      // No ciphertext exposed
      expect(JSON.stringify(meta)).not.toContain('ZW5jcnlwdGVk');
    });
  });

  describe('logAccess', () => {
    it('logs access and returns redacted display', async () => {
      vi.mocked(recordRepo.findById).mockResolvedValueOnce({
        id: 'vr_001',
        clientId: 'client_001',
        fieldType: 'EMAIL',
        ciphertext: 'enc',
        iv: 'iv',
        authTag: 'tag',
        keyId: 'k1',
        keyVersion: 'v1',
        encryptedKeyRef: null,
        redactedDisplay: 'a***@example.com',
        isCryptoShredded: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await svc.logAccess('vr_001', 'PURPOSE_FORM_FILL', 'user_001', 'OPERATOR');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.redactedDisplay).toBe('a***@example.com');
        expect(result.value.purposeCode).toBe('PURPOSE_FORM_FILL');
      }
      expect(accessLogRepo.create).toHaveBeenCalledOnce();
    });

    it('returns VAULT_RECORD_NOT_FOUND when record missing', async () => {
      vi.mocked(recordRepo.findById).mockResolvedValueOnce(null);
      const result = await svc.logAccess('missing', 'PURPOSE_FORM_FILL', 'user_001', 'OPERATOR');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VAULT_RECORD_NOT_FOUND');
    });

    it('returns VAULT_CRYPTO_SHREDDED when record is shredded', async () => {
      vi.mocked(recordRepo.findById).mockResolvedValueOnce({
        id: 'vr_001',
        clientId: 'client_001',
        fieldType: 'EMAIL',
        ciphertext: 'enc',
        iv: 'iv',
        authTag: 'tag',
        keyId: 'k1',
        keyVersion: 'v1',
        encryptedKeyRef: null,
        redactedDisplay: null,
        isCryptoShredded: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await svc.logAccess('vr_001', 'PURPOSE_FORM_FILL', 'user_001', 'OPERATOR');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VAULT_CRYPTO_SHREDDED');
    });

    it('rejects invalid purpose code', async () => {
      const result = await svc.logAccess('vr_001', 'PURPOSE_LLM_ANY' as never, 'user_001', 'OPERATOR');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('VAULT_PURPOSE_DENIED');
    });
  });
});
