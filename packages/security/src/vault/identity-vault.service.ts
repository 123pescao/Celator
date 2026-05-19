/**
 * IdentityVaultService — Celator Phase 0
 *
 * Handles encryption, decryption, rotation, and crypto-shredding of sensitive
 * client identifiers. All PII lives here. Nothing else in the app decrypts PII
 * without going through this service with a valid purpose code.
 *
 * Encryption: AES-256-GCM with per-client Data Encryption Keys (DEKs).
 * DEKs are wrapped/stored by the KMS abstraction, never in plaintext in the DB.
 *
 * Rules:
 * - Every decrypt requires a valid VaultPurposeCode.
 * - LLM-related access is denied at the purpose level.
 * - Every decrypt writes an IdentityVaultAccessLog.
 * - Crypto-shredding deletes the DEK, making ciphertext unrecoverable.
 * - DEK rotation is idempotent.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KmsProvider } from '../kms/local-kms.js';

/** Optional interface for KMS providers that expose wrapped key refs (e.g. LocalKmsProvider). */
interface KmsWithKeyRefAccess extends KmsProvider {
  getEncryptedKeyRef(clientId: string, keyVersion: string): string | undefined;
}

// =============================================================
// Types
// =============================================================

export type VaultPurposeCode =
  | 'PURPOSE_OPERATOR_REVIEW_PACKET'
  | 'PURPOSE_FORM_FILL'
  | 'PURPOSE_REPORT_GENERATION'
  | 'PURPOSE_CLIENT_EXPORT'
  | 'PURPOSE_DEK_ROTATION';

// Purpose codes explicitly denied — fail closed
const DENIED_PURPOSES = new Set([
  'PURPOSE_LLM_CLASSIFICATION',
  'PURPOSE_LLM_DRAFTING',
  'PURPOSE_LLM_ANY',
  'PURPOSE_LOG',
  'PURPOSE_SEARCH',
  'PURPOSE_ANALYTICS',
]);

const VALID_PURPOSES = new Set<VaultPurposeCode>([
  'PURPOSE_OPERATOR_REVIEW_PACKET',
  'PURPOSE_FORM_FILL',
  'PURPOSE_REPORT_GENERATION',
  'PURPOSE_CLIENT_EXPORT',
  'PURPOSE_DEK_ROTATION',
]);

export interface VaultActor {
  actorId: string;
  actorType: 'SYSTEM' | 'CLIENT' | 'OPERATOR' | 'ADMIN' | 'SERVICE';
}

export interface EncryptedRecord {
  id: string;
  clientId: string;
  fieldType: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  keyId: string;
  keyVersion: string;
  isCryptoShredded: boolean;
  createdAt: Date;
}

export interface VaultAccessLog {
  id: string;
  recordId: string;
  clientId: string;
  purposeCode: VaultPurposeCode;
  actorId: string;
  actorType: string;
  accessedAt: Date;
}

export interface IdentifierMetadata {
  id: string;
  clientId: string;
  fieldType: string;
  keyVersion: string;
  isCryptoShredded: boolean;
  createdAt: Date;
  // No ciphertext, no plaintext
}

export interface DekRotationJob {
  id: string;
  clientId: string;
  oldKeyVersion: string;
  newKeyVersion: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  recordsTotal: number;
  recordsRotated: number;
  startedAt?: Date;
  completedAt?: Date;
  failureReason?: string;
  createdAt: Date;
}

// =============================================================
// In-memory store for Phase 0 (no DB dependency in security package)
// =============================================================
// In Phase 1+ this is replaced with Prisma DB calls.

let _recordCounter = 0;
let _logCounter = 0;
let _jobCounter = 0;

function newId(prefix: string): string {
  return `${prefix}_${++_recordCounter}_${Date.now()}`;
}

// =============================================================
// IdentityVaultService
// =============================================================

export class IdentityVaultService {
  private records = new Map<string, EncryptedRecord>();
  private accessLogs: VaultAccessLog[] = [];
  private rotationJobs = new Map<string, DekRotationJob>();
  // clientId -> { keyVersion -> encryptedKeyRef }
  private clientKeys = new Map<string, Map<string, string>>();
  private clientCurrentKeyVersion = new Map<string, string>();
  // Crypto-shredded clients — their keys are gone
  private shreddedClients = new Set<string>();

  constructor(private readonly kms: KmsProvider) {}

  // =============================================================
  // encryptIdentifier
  // =============================================================

  async encryptIdentifier(
    clientId: string,
    fieldType: string,
    plaintext: string,
    purposeCode: VaultPurposeCode,
    actor: VaultActor,
  ): Promise<string> {
    this.assertValidPurpose(purposeCode);

    if (this.shreddedClients.has(clientId)) {
      throw new Error(
        `[IdentityVault] Client ${clientId} has been crypto-shredded. Cannot store new data.`,
      );
    }

    // Get or create client DEK
    let encryptedKeyRef = await this.getOrCreateEncryptedKeyRef(clientId);
    const plaintextKey = await this.kms.decryptDataKey(encryptedKeyRef);

    // AES-256-GCM encrypt
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', plaintextKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Zero the plaintext key from memory as soon as possible
    plaintextKey.fill(0);

    const keyVersion = this.clientCurrentKeyVersion.get(clientId) ?? 'v0';
    const record: EncryptedRecord = {
      id: newId('vr'),
      clientId,
      fieldType,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyId: `local-${clientId}-${keyVersion}`,
      keyVersion,
      isCryptoShredded: false,
      createdAt: new Date(),
    };

    this.records.set(record.id, record);
    this.writeAccessLog(record.id, clientId, purposeCode, actor);

    return record.id;
  }

  // =============================================================
  // decryptIdentifier
  // =============================================================

  async decryptIdentifier(
    recordId: string,
    purposeCode: VaultPurposeCode,
    actor: VaultActor,
  ): Promise<string> {
    this.assertValidPurpose(purposeCode);

    const record = this.records.get(recordId);
    if (!record) {
      throw new Error(`[IdentityVault] Record ${recordId} not found.`);
    }

    if (record.isCryptoShredded || this.shreddedClients.has(record.clientId)) {
      throw new Error(
        `[IdentityVault] Record ${recordId} is crypto-shredded. Data is permanently unrecoverable.`,
      );
    }

    // Write access log BEFORE decryption (even if decrypt fails, log the attempt)
    this.writeAccessLog(recordId, record.clientId, purposeCode, actor);

    const encryptedKeyRef = await this.getEncryptedKeyRefForVersion(
      record.clientId,
      record.keyVersion,
    );
    const plaintextKey = await this.kms.decryptDataKey(encryptedKeyRef);

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        plaintextKey,
        Buffer.from(record.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return plaintext;
    } finally {
      plaintextKey.fill(0);
    }
  }

  // =============================================================
  // listIdentifierMetadata
  // =============================================================

  listIdentifierMetadata(clientId: string): IdentifierMetadata[] {
    const results: IdentifierMetadata[] = [];
    for (const record of this.records.values()) {
      if (record.clientId === clientId) {
        results.push({
          id: record.id,
          clientId: record.clientId,
          fieldType: record.fieldType,
          keyVersion: record.keyVersion,
          isCryptoShredded: record.isCryptoShredded || this.shreddedClients.has(clientId),
          createdAt: record.createdAt,
        });
      }
    }
    return results;
  }

  // =============================================================
  // rotateClientDek
  // =============================================================

  async rotateClientDek(clientId: string): Promise<DekRotationJob> {
    // Idempotency: if a job is already in progress, return it
    for (const job of this.rotationJobs.values()) {
      if (
        job.clientId === clientId &&
        (job.status === 'PENDING' || job.status === 'IN_PROGRESS')
      ) {
        return job;
      }
    }

    const { oldKeyVersion, newKeyVersion } = await this.kms.rotateClientKey(clientId);

    // Sync the new key reference from KMS into the vault's local key store.
    // rotateClientKey on LocalKmsProvider calls generateDataKey internally
    // which stores the wrapped key ref in the KMS's own map. We need to pull
    // that reference into the vault's clientKeys map so re-encryption can use it.
    const newEncryptedKeyRef = (this.kms as KmsWithKeyRefAccess).getEncryptedKeyRef(clientId, newKeyVersion);
    if (!newEncryptedKeyRef) {
      const jobId = `drj_${++_jobCounter}_${Date.now()}`;
      const failJob: DekRotationJob = {
        id: jobId, clientId, oldKeyVersion, newKeyVersion,
        status: 'FAILED', recordsTotal: 0, recordsRotated: 0,
        failureReason: `KMS did not return new key ref for version ${newKeyVersion}`,
        createdAt: new Date(),
      };
      this.rotationJobs.set(jobId, failJob);
      return failJob;
    }
    let versions = this.clientKeys.get(clientId);
    if (!versions) {
      versions = new Map();
      this.clientKeys.set(clientId, versions);
    }
    versions.set(newKeyVersion, newEncryptedKeyRef);
    this.clientCurrentKeyVersion.set(clientId, newKeyVersion);

    const jobId = `drj_${++_jobCounter}_${Date.now()}`;
    const clientRecords = Array.from(this.records.values()).filter(
      (r) => r.clientId === clientId && !r.isCryptoShredded,
    );

    const job: DekRotationJob = {
      id: jobId,
      clientId,
      oldKeyVersion,
      newKeyVersion,
      status: 'IN_PROGRESS',
      recordsTotal: clientRecords.length,
      recordsRotated: 0,
      startedAt: new Date(),
      createdAt: new Date(),
    };
    this.rotationJobs.set(jobId, job);

    try {
      // Re-encrypt each record with the new key
      for (const record of clientRecords) {
        // Decrypt with old key
        const oldEncryptedKeyRef = await this.getEncryptedKeyRefForVersion(
          clientId,
          record.keyVersion,
        );
        const oldKey = await this.kms.decryptDataKey(oldEncryptedKeyRef);

        let plaintext: string;
        try {
          const decipher = createDecipheriv(
            'aes-256-gcm',
            oldKey,
            Buffer.from(record.iv, 'base64'),
          );
          decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
          plaintext = Buffer.concat([
            decipher.update(Buffer.from(record.ciphertext, 'base64')),
            decipher.final(),
          ]).toString('utf8');
        } finally {
          oldKey.fill(0);
        }

        // Re-encrypt with new key
        const newEncryptedKeyRef = await this.getEncryptedKeyRefForVersion(
          clientId,
          newKeyVersion,
        );
        const newKey = await this.kms.decryptDataKey(newEncryptedKeyRef);
        try {
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', newKey, iv);
          const newCiphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
          const newAuthTag = cipher.getAuthTag();

          record.ciphertext = newCiphertext.toString('base64');
          record.iv = iv.toString('base64');
          record.authTag = newAuthTag.toString('base64');
          record.keyVersion = newKeyVersion;
          record.keyId = `local-${clientId}-${newKeyVersion}`;
        } finally {
          newKey.fill(0);
        }

        job.recordsRotated++;
      }

      job.status = 'COMPLETED';
      job.completedAt = new Date();
    } catch (err) {
      job.status = 'FAILED';
      job.failureReason = err instanceof Error ? err.message : String(err);
    }

    return job;
  }

  // =============================================================
  // cryptoShredClient
  // =============================================================

  async cryptoShredClient(clientId: string): Promise<void> {
    // Mark all records as shredded
    for (const record of this.records.values()) {
      if (record.clientId === clientId) {
        record.isCryptoShredded = true;
      }
    }

    // Remove the client's key material from the key store
    this.clientKeys.delete(clientId);
    this.clientCurrentKeyVersion.delete(clientId);
    this.shreddedClients.add(clientId);

    // Note: In production, you delete the DEK from KMS here.
    // The ciphertext in the DB becomes permanently unrecoverable.
  }

  // =============================================================
  // Test helpers
  // =============================================================

  getAccessLogs(): VaultAccessLog[] {
    return [...this.accessLogs];
  }

  getRotationJob(jobId: string): DekRotationJob | undefined {
    return this.rotationJobs.get(jobId);
  }

  // =============================================================
  // Private helpers
  // =============================================================

  private assertValidPurpose(purposeCode: string): asserts purposeCode is VaultPurposeCode {
    if (DENIED_PURPOSES.has(purposeCode)) {
      throw new Error(
        `[IdentityVault] Access denied: purpose code "${purposeCode}" is explicitly prohibited. ` +
          `LLM, log, search, and analytics access to the vault is not permitted.`,
      );
    }
    if (!VALID_PURPOSES.has(purposeCode as VaultPurposeCode)) {
      // Unknown purpose — fail closed
      throw new Error(
        `[IdentityVault] Access denied: unknown purpose code "${purposeCode}". ` +
          `Only explicitly permitted purpose codes are allowed. Failing closed.`,
      );
    }
  }

  private writeAccessLog(
    recordId: string,
    clientId: string,
    purposeCode: VaultPurposeCode,
    actor: VaultActor,
  ): void {
    const log: VaultAccessLog = {
      id: `val_${++_logCounter}_${Date.now()}`,
      recordId,
      clientId,
      purposeCode,
      actorId: actor.actorId,
      actorType: actor.actorType,
      accessedAt: new Date(),
    };
    this.accessLogs.push(log);
    // In production: write to DB identity_vault_access_logs table
  }

  private async getOrCreateEncryptedKeyRef(clientId: string): Promise<string> {
    const currentVersion = this.clientCurrentKeyVersion.get(clientId);
    if (currentVersion) {
      const keyRef = this.clientKeys.get(clientId)?.get(currentVersion);
      if (keyRef) return keyRef;
    }
    // Generate a new DEK
    const result = await this.kms.generateDataKey(clientId);
    let versions = this.clientKeys.get(clientId);
    if (!versions) {
      versions = new Map();
      this.clientKeys.set(clientId, versions);
    }
    versions.set(result.keyVersion, result.encryptedKeyRef);
    this.clientCurrentKeyVersion.set(clientId, result.keyVersion);
    result.plaintextKey.fill(0); // Discard immediately
    return result.encryptedKeyRef;
  }

  private async getEncryptedKeyRefForVersion(
    clientId: string,
    keyVersion: string,
  ): Promise<string> {
    const keyRef = this.clientKeys.get(clientId)?.get(keyVersion);
    if (!keyRef) {
      throw new Error(
        `[IdentityVault] No key found for client ${clientId} version ${keyVersion}. ` +
          `Key may have been crypto-shredded or never existed.`,
      );
    }
    return keyRef;
  }
}
