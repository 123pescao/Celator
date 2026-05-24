/**
 * IdentityVaultIntakeService — DB-backed PII intake with AES-256-GCM encryption.
 *
 * Stores client identifiers encrypted in the database. Never writes plaintext.
 * Computes a pre-redacted display string at store time so callers can show
 * a safe representation without re-decrypting.
 *
 * Encryption uses the KmsProvider (LocalKmsProvider in dev; replace in production).
 * The wrapped DEK reference is stored alongside the ciphertext so future phases
 * can decrypt without an in-memory key store.
 *
 * Access to vault records requires a VaultPurposeCode and an actor.
 * Every access (intake and log-only) is recorded in IdentityVaultAccessLog.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import type { KmsProvider } from '@celator/security';
import {
  isValidVaultFieldType,
  redactForDisplay,
  type PiiFieldType,
} from '@celator/security';
import type {
  IdentityVaultRecordRepository,
  IdentityVaultAccessLogRepository,
} from '@celator/db';
import type { VaultPurposeCode, ActorType, IdentityVaultRecord } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';

const VALID_PURPOSES = new Set<VaultPurposeCode>([
  'PURPOSE_OPERATOR_REVIEW_PACKET',
  'PURPOSE_FORM_FILL',
  'PURPOSE_REPORT_GENERATION',
  'PURPOSE_CLIENT_EXPORT',
  'PURPOSE_DEK_ROTATION',
]);

export interface VaultStoreInput {
  clientId: string;
  fieldType: string;
  plaintext: string;
  purposeCode: VaultPurposeCode;
  actorId: string;
  actorType: ActorType;
}

export interface VaultStoreResult {
  recordId: string;
  fieldType: string;
  redactedDisplay: string;
  createdAt: Date;
}

export interface VaultRecordMetadata {
  id: string;
  clientId: string;
  fieldType: string;
  redactedDisplay: string | null;
  isCryptoShredded: boolean;
  createdAt: Date;
}

export interface VaultAccessResult {
  recordId: string;
  fieldType: string;
  redactedDisplay: string | null;
  purposeCode: VaultPurposeCode;
  accessedAt: Date;
}

export class IdentityVaultIntakeService {
  constructor(
    private readonly recordRepo: IdentityVaultRecordRepository,
    private readonly accessLogRepo: IdentityVaultAccessLogRepository,
    private readonly kms: KmsProvider,
  ) {}

  async store(input: VaultStoreInput): Promise<Result<VaultStoreResult, ErrorCode>> {
    if (!isValidVaultFieldType(input.fieldType)) {
      return err('VAULT_FIELD_TYPE_INVALID', `Unknown vault field type: "${input.fieldType}"`);
    }

    if (!VALID_PURPOSES.has(input.purposeCode)) {
      return err('VAULT_PURPOSE_DENIED', `Purpose code "${input.purposeCode}" is not permitted for vault intake`);
    }

    try {
      // Generate a per-record DEK
      const { keyId, keyVersion, plaintextKey, encryptedKeyRef } = await this.kms.generateDataKey(input.clientId);

      // AES-256-GCM encrypt
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', plaintextKey, iv);
      const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      plaintextKey.fill(0); // Zero key material from memory immediately

      const redactedDisplay = redactForDisplay(input.fieldType as PiiFieldType, input.plaintext);

      const record = await this.recordRepo.create({
        clientId: input.clientId,
        fieldType: input.fieldType,
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        keyId,
        keyVersion,
        encryptedKeyRef,
        redactedDisplay,
      });

      await this.accessLogRepo.create({
        recordId: record.id,
        clientId: input.clientId,
        purposeCode: input.purposeCode,
        actorId: input.actorId,
        actorType: input.actorType,
      });

      return ok({ recordId: record.id, fieldType: input.fieldType, redactedDisplay, createdAt: record.createdAt });
    } catch (e) {
      return err('VAULT_ENCRYPT_FAILED', `Vault store failed: ${String(e)}`);
    }
  }

  async listMetadata(clientId: string): Promise<VaultRecordMetadata[]> {
    const records = await this.recordRepo.listByClient(clientId);
    return records.map(toMetadata);
  }

  async logAccess(
    recordId: string,
    purposeCode: VaultPurposeCode,
    actorId: string,
    actorType: ActorType,
  ): Promise<Result<VaultAccessResult, ErrorCode>> {
    if (!VALID_PURPOSES.has(purposeCode)) {
      return err('VAULT_PURPOSE_DENIED', `Purpose code "${purposeCode}" is not permitted`);
    }

    const record = await this.recordRepo.findById(recordId);
    if (!record) return err('VAULT_RECORD_NOT_FOUND', `Vault record ${recordId} not found`);
    if (record.isCryptoShredded) {
      return err('VAULT_CRYPTO_SHREDDED', `Vault record ${recordId} has been crypto-shredded`);
    }

    const log = await this.accessLogRepo.create({
      recordId,
      clientId: record.clientId,
      purposeCode,
      actorId,
      actorType,
    });

    return ok({
      recordId,
      fieldType: record.fieldType,
      redactedDisplay: record.redactedDisplay,
      purposeCode,
      accessedAt: log.accessedAt,
    });
  }
}

function toMetadata(r: IdentityVaultRecord): VaultRecordMetadata {
  return {
    id: r.id,
    clientId: r.clientId,
    fieldType: r.fieldType,
    redactedDisplay: r.redactedDisplay,
    isCryptoShredded: r.isCryptoShredded,
    createdAt: r.createdAt,
  };
}
