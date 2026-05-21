import type { AuditLogRepository } from '@celator/db';
import type { AuditLog, ActorType, Prisma } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';

export interface AuditEventInput {
  eventType: string;
  actorId?: string;
  actorType: ActorType;
  clientId?: string;
  resourceId?: string;
  resourceType?: string;
  outcome: 'ALLOWED' | 'BLOCKED' | 'ERROR';
  blockedBy?: string[];
  metadata?: Prisma.InputJsonValue;
}

export class AuditService {
  constructor(private readonly repo: AuditLogRepository) {}

  async write(input: AuditEventInput): Promise<Result<AuditLog, ErrorCode>> {
    // Fail-closed: if metadata contains string values that look like PII patterns, reject
    if (input.metadata) {
      const raw = JSON.stringify(input.metadata);
      if (containsPiiPattern(raw)) {
        return err('AUDIT_LOG_FAILED', 'Audit metadata failed PII pattern check — log rejected to prevent PII exposure');
      }
    }

    try {
      const log = await this.repo.create({
        eventType: input.eventType,
        actorType: input.actorType,
        outcome: input.outcome,
        blockedBy: input.blockedBy ?? [],
        ...(input.actorId ? { actor: { connect: { id: input.actorId } } } : {}),
        ...(input.clientId ? { client: { connect: { id: input.clientId } } } : {}),
        resourceId: input.resourceId ?? null,
        resourceType: input.resourceType ?? null,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
      return ok(log);
    } catch (e) {
      return err('AUDIT_LOG_FAILED', `Audit write failed: ${String(e)}`);
    }
  }

  async listByClient(clientId: string, limit = 100): Promise<AuditLog[]> {
    return this.repo.listByClient(clientId, limit);
  }

  async listByResource(resourceId: string, resourceType?: string): Promise<AuditLog[]> {
    return this.repo.listByResource(resourceId, resourceType);
  }

  async listByEventType(eventType: string, since?: Date, limit = 200): Promise<AuditLog[]> {
    return this.repo.listByEventType(eventType, since, limit);
  }
}

const PII_PATTERNS = [
  /@[a-z0-9.-]+\.[a-z]{2,}/i,       // email-like
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone-like
  /\b\d{3}-\d{2}-\d{4}\b/,           // SSN-like
];

function containsPiiPattern(s: string): boolean {
  return PII_PATTERNS.some((p) => p.test(s));
}
