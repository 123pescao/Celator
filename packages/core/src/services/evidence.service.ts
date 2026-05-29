import type { EvidenceRecordRepository, CleanupTaskRepository } from '@celator/db';
import type { EvidenceRecord } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';

// ─── Valid evidence types (service-layer enforcement — DB stores as String) ───
export const VALID_EVIDENCE_TYPES = [
  'SCREENSHOT',
  'CONFIRMATION_CODE',
  'EMAIL_RESPONSE',
  'WEB_FORM_RECEIPT',
  'MANUAL_NOTE',
  'OTHER',
] as const;
export type EvidenceType = typeof VALID_EVIDENCE_TYPES[number];

// ─── storageKey safety check ─────────────────────────────────────────────────
// Rejects common patterns that suggest local paths, URLs, or PII-bearing paths.
function checkStorageKey(key: string): string | null {
  if (key.includes('@')) return 'storageKey contains @ (possible embedded email or address)';
  if (key.includes('://')) return 'storageKey contains URL scheme — store opaque keys only';
  if (key.includes('/home/')) return 'storageKey contains local filesystem path pattern';
  if (key.includes('C:\\') || key.includes('C:/')) return 'storageKey contains Windows filesystem path pattern';
  if (key.includes('..')) return 'storageKey contains path traversal pattern';
  return null;
}

// ─── Input/output types ───────────────────────────────────────────────────────

export interface RegisterEvidenceInput {
  taskId: string;
  clientId: string;
  storageKey: string;
  contentHash: string;
  evidenceType: EvidenceType;
  mimeType?: string;
  sizeBytes?: number;
  retainUntil?: Date;
}

export interface SafeEvidenceRecord {
  id: string;
  taskId: string;
  clientId: string | null;
  storageKey: string;
  contentHash: string;
  evidenceType: string;
  mimeType: string | null;
  sizeBytes: number | null;
  isImmutable: boolean;
  retainUntil: Date | null;
  createdAt: Date;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function toSafe(r: EvidenceRecord): SafeEvidenceRecord {
  return {
    id: r.id,
    taskId: r.taskId,
    clientId: r.clientId,
    storageKey: r.storageKey,
    contentHash: r.contentHash,
    evidenceType: r.evidenceType,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    isImmutable: r.isImmutable,
    retainUntil: r.retainUntil,
    createdAt: r.createdAt,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class EvidenceService {
  constructor(
    private readonly evidenceRepo: EvidenceRecordRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly audit: AuditService,
  ) {}

  async register(
    input: RegisterEvidenceInput,
    actorId: string,
  ): Promise<Result<SafeEvidenceRecord, ErrorCode>> {
    if (!VALID_EVIDENCE_TYPES.includes(input.evidenceType)) {
      return err('EVIDENCE_TYPE_INVALID', `Invalid evidenceType "${input.evidenceType}" — allowed: ${VALID_EVIDENCE_TYPES.join(', ')}`);
    }

    const keyViolation = checkStorageKey(input.storageKey);
    if (keyViolation) return err('VALIDATION_ERROR', `storageKey rejected: ${keyViolation}`);

    const task = await this.taskRepo.findById(input.taskId);
    if (!task) return err('NOT_FOUND', `Task ${input.taskId} not found`);

    const record = await this.evidenceRepo.create({
      task: { connect: { id: input.taskId } },
      ...(input.clientId ? { client: { connect: { id: input.clientId } } } : {}),
      storageKey: input.storageKey,
      contentHash: input.contentHash,
      evidenceType: input.evidenceType,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.retainUntil !== undefined ? { retainUntil: input.retainUntil } : {}),
    });

    const auditResult = await this.audit.write({
      eventType: 'EVIDENCE_REGISTERED',
      actorId,
      actorType: 'OPERATOR',
      clientId: input.clientId,
      resourceId: record.id,
      resourceType: 'EvidenceRecord',
      outcome: 'ALLOWED',
      metadata: { taskId: input.taskId, evidenceType: input.evidenceType, sizeBytes: input.sizeBytes ?? null },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(record));
  }

  async getById(evidenceId: string): Promise<Result<SafeEvidenceRecord, ErrorCode>> {
    const record = await this.evidenceRepo.findById(evidenceId);
    if (!record) return err('EVIDENCE_RECORD_NOT_FOUND', `Evidence record ${evidenceId} not found`);
    return ok(toSafe(record));
  }

  async listForTask(taskId: string, clientId: string): Promise<SafeEvidenceRecord[]> {
    const records = await this.evidenceRepo.listForTaskScoped(taskId, clientId);
    return records.map(toSafe);
  }

  async markImmutable(
    evidenceId: string,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafeEvidenceRecord, ErrorCode>> {
    const record = await this.evidenceRepo.findById(evidenceId);
    if (!record) return err('EVIDENCE_RECORD_NOT_FOUND', `Evidence record ${evidenceId} not found`);

    if (record.clientId && record.clientId !== clientId) {
      return err('FORBIDDEN', 'Access denied — evidence record belongs to a different client');
    }

    if (record.isImmutable) {
      // Idempotent — already immutable
      return ok(toSafe(record));
    }

    const updated = await this.evidenceRepo.markImmutable(evidenceId);

    const auditResult = await this.audit.write({
      eventType: 'EVIDENCE_MARKED_IMMUTABLE',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: evidenceId,
      resourceType: 'EvidenceRecord',
      outcome: 'ALLOWED',
      metadata: { taskId: record.taskId, evidenceId },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }
}
