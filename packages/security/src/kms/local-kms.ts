/**
 * KMS Abstraction — Celator Phase 0
 *
 * Defines the KmsProvider interface and the development-only LocalKmsProvider.
 *
 * IMPORTANT: LocalKmsProvider is NOT suitable for production.
 * In production, replace with AWS KMS, GCP Cloud KMS, or HashiCorp Vault.
 *
 * The signing key (for snapshot signatures) is intentionally separate from
 * PII encryption keys (DEKs). A compromise of one does not compromise the other.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// =============================================================
// Interface
// =============================================================

export interface GenerateDataKeyResult {
  keyId: string;
  keyVersion: string;
  /** Plaintext key — use immediately, then discard from memory. Never log. */
  plaintextKey: Buffer;
  /** Encrypted reference stored in DB — does not contain the key itself. */
  encryptedKeyRef: string;
}

export interface KmsProvider {
  generateDataKey(clientId: string): Promise<GenerateDataKeyResult>;
  decryptDataKey(encryptedKeyRef: string): Promise<Buffer>;
  signSnapshot(payloadHash: string, signingKeyVersion: string): Promise<string>;
  verifySnapshot(
    payloadHash: string,
    signature: string,
    signingKeyVersion: string,
  ): Promise<boolean>;
  rotateClientKey(clientId: string): Promise<{ oldKeyVersion: string; newKeyVersion: string }>;
  getCurrentSigningKeyVersion(): string;
  isSigningKeyVersionValid(version: string): boolean;
}

// =============================================================
// Key versioning helpers
// =============================================================

function generateKeyVersion(): string {
  return `v${Date.now()}-${randomBytes(4).toString('hex')}`;
}

// =============================================================
// LocalKmsProvider — DEVELOPMENT ONLY
// =============================================================

/**
 * LocalKmsProvider — DEVELOPMENT USE ONLY.
 *
 * Uses Node.js crypto with secrets loaded from environment variables.
 * Stores an in-memory registry of client DEK versions.
 *
 * DO NOT use in production. Replace with a real KMS implementation.
 */
export class LocalKmsProvider implements KmsProvider {
  private readonly masterSecret: Buffer;
  private readonly signingSecret: Buffer;

  // In-memory key store: clientId -> { keyVersion -> encryptedKey }
  // In production this lives in the KMS, not in memory.
  private readonly keyStore = new Map<string, Map<string, Buffer>>();
  private readonly clientCurrentVersion = new Map<string, string>();

  // Signing key versions
  private readonly signingKeyVersions = new Map<string, Buffer>();
  private currentSigningKeyVersion: string;

  constructor(masterSecret: string, signingSecret: string) {
    if (!masterSecret || masterSecret.length < 32) {
      throw new Error(
        '[LocalKmsProvider] LOCAL_KMS_MASTER_SECRET must be at least 32 characters. This is a development KMS only.',
      );
    }
    if (!signingSecret || signingSecret.length < 32) {
      throw new Error(
        '[LocalKmsProvider] LOCAL_KMS_SIGNING_SECRET must be at least 32 characters. This is a development KMS only.',
      );
    }

    this.masterSecret = Buffer.from(masterSecret, 'utf8').subarray(0, 32);
    this.signingSecret = Buffer.from(signingSecret, 'utf8').subarray(0, 32);

    // Bootstrap initial signing key version
    this.currentSigningKeyVersion = generateKeyVersion();
    this.signingKeyVersions.set(this.currentSigningKeyVersion, this.signingSecret);
  }

  getCurrentSigningKeyVersion(): string {
    return this.currentSigningKeyVersion;
  }

  isSigningKeyVersionValid(version: string): boolean {
    return this.signingKeyVersions.has(version);
  }

  async generateDataKey(clientId: string): Promise<GenerateDataKeyResult> {
    const plaintextKey = randomBytes(32); // AES-256 key
    const keyVersion = generateKeyVersion();
    const keyId = `local-${clientId}-${keyVersion}`;

    // "Encrypt" the key using the master secret (AES-256-GCM wrap)
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterSecret, iv);
    const encrypted = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encryptedKeyRef = Buffer.concat([iv, authTag, encrypted]).toString('base64');

    // Store in memory key store
    let versions = this.keyStore.get(clientId);
    if (!versions) {
      versions = new Map();
      this.keyStore.set(clientId, versions);
    }
    versions.set(keyVersion, Buffer.from(encryptedKeyRef, 'base64'));
    this.clientCurrentVersion.set(clientId, keyVersion);

    return { keyId, keyVersion, plaintextKey, encryptedKeyRef };
  }

  async decryptDataKey(encryptedKeyRef: string): Promise<Buffer> {
    const blob = Buffer.from(encryptedKeyRef, 'base64');
    const iv = blob.subarray(0, 12);
    const authTag = blob.subarray(12, 28);
    const encrypted = blob.subarray(28);

    const decipher = createDecipheriv('aes-256-gcm', this.masterSecret, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  async signSnapshot(payloadHash: string, signingKeyVersion: string): Promise<string> {
    const key = this.signingKeyVersions.get(signingKeyVersion);
    if (!key) {
      throw new Error(
        `[LocalKmsProvider] Unknown signing key version: ${signingKeyVersion}. Cannot sign.`,
      );
    }
    return createHmac('sha256', key).update(payloadHash).digest('hex');
  }

  async verifySnapshot(
    payloadHash: string,
    signature: string,
    signingKeyVersion: string,
  ): Promise<boolean> {
    const key = this.signingKeyVersions.get(signingKeyVersion);
    if (!key) {
      // Unknown key version — fail closed
      return false;
    }
    const expected = createHmac('sha256', key).update(payloadHash).digest('hex');
    // Constant-time comparison
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= (expected.codePointAt(i) ?? 0) ^ (signature.codePointAt(i) ?? 0);
    }
    return diff === 0;
  }

  async rotateClientKey(
    clientId: string,
  ): Promise<{ oldKeyVersion: string; newKeyVersion: string }> {
    const oldKeyVersion = this.clientCurrentVersion.get(clientId) ?? 'none';
    const newResult = await this.generateDataKey(clientId);
    return { oldKeyVersion, newKeyVersion: newResult.keyVersion };
  }

  /** Retrieve current encrypted key ref for a client+version — used during DEK rotation. */
  getEncryptedKeyRef(clientId: string, keyVersion: string): string | undefined {
    const raw = this.keyStore.get(clientId)?.get(keyVersion);
    return raw?.toString('base64');
  }

  getCurrentKeyVersion(clientId: string): string | undefined {
    return this.clientCurrentVersion.get(clientId);
  }
}

// =============================================================
// Factory — loads from environment
// =============================================================

let _instance: KmsProvider | undefined;

export function getKmsProvider(): KmsProvider {
  if (_instance) return _instance;

  const masterSecret = process.env['LOCAL_KMS_MASTER_SECRET'];
  const signingSecret = process.env['LOCAL_KMS_SIGNING_SECRET'];

  if (!masterSecret || !signingSecret) {
    throw new Error(
      '[KMS] LOCAL_KMS_MASTER_SECRET and LOCAL_KMS_SIGNING_SECRET must be set. ' +
        'Copy .env.example to .env and set real development secrets.',
    );
  }

  _instance = new LocalKmsProvider(masterSecret, signingSecret);
  return _instance;
}

/** Reset the singleton — for testing only. */
export function resetKmsProviderForTesting(provider?: KmsProvider): void {
  _instance = provider;
}
