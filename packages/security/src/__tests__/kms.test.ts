import { describe, it, expect } from 'vitest';
import { LocalKmsProvider } from '../kms/local-kms.js';
import { TEST_KMS_MASTER, TEST_KMS_SIGNING } from './fixtures.js';

describe('LocalKmsProvider', () => {
  it('rejects short master secret', () => {
    expect(() => new LocalKmsProvider('short', 'also-short')).toThrow();
  });

  it('rejects short signing secret', () => {
    expect(() => new LocalKmsProvider(TEST_KMS_MASTER, 'short')).toThrow();
  });

  it('generates a data key with plaintext and encrypted ref', async () => {
    const kms = new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
    const result = await kms.generateDataKey('client_001');
    expect(result.plaintextKey).toBeInstanceOf(Buffer);
    expect(result.plaintextKey.length).toBe(32);
    expect(result.encryptedKeyRef).toBeTruthy();
    expect(result.keyVersion).toMatch(/^v/);
  });

  it('round-trips data key encryption and decryption', async () => {
    const kms = new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
    const result = await kms.generateDataKey('client_002');
    const decrypted = await kms.decryptDataKey(result.encryptedKeyRef);
    expect(Buffer.compare(decrypted, result.plaintextKey)).toBe(0);
  });

  it('signs and verifies a snapshot with correct key version', async () => {
    const kms = new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
    const version = kms.getCurrentSigningKeyVersion();
    const signature = await kms.signSnapshot('test-hash-abc123', version);
    const valid = await kms.verifySnapshot('test-hash-abc123', signature, version);
    expect(valid).toBe(true);
  });

  it('fails verification with wrong hash', async () => {
    const kms = new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
    const version = kms.getCurrentSigningKeyVersion();
    const signature = await kms.signSnapshot('original-hash', version);
    const valid = await kms.verifySnapshot('tampered-hash', signature, version);
    expect(valid).toBe(false);
  });

  it('fails verification with unknown key version', async () => {
    const kms = new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
    const version = kms.getCurrentSigningKeyVersion();
    const signature = await kms.signSnapshot('some-hash', version);
    const valid = await kms.verifySnapshot('some-hash', signature, 'unknown-version');
    expect(valid).toBe(false);
  });

  it('rotates client key and returns old/new versions', async () => {
    const kms = new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
    await kms.generateDataKey('client_rotate_001');
    const { oldKeyVersion, newKeyVersion } = await kms.rotateClientKey('client_rotate_001');
    expect(oldKeyVersion).toBeTruthy();
    expect(newKeyVersion).toBeTruthy();
    expect(oldKeyVersion).not.toBe(newKeyVersion);
  });
});
