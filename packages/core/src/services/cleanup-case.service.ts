import type { CleanupCaseRepository } from '@celator/db';
import type { CleanupCase } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { CaseTimelineService } from './case-timeline.service.js';

export interface CreateCaseInput {
  clientId: string;
  authorizationId: string;
  title?: string;
}

export class CleanupCaseService {
  constructor(
    private readonly repo: CleanupCaseRepository,
    private readonly audit: AuditService,
    private readonly timeline: CaseTimelineService,
  ) {}

  async create(input: CreateCaseInput, actorId: string): Promise<Result<CleanupCase, ErrorCode>> {
    const cleanupCase = await this.repo.create({
      client: { connect: { id: input.clientId } },
      authorization: { connect: { id: input.authorizationId } },
      title: input.title ?? null,
    });

    await Promise.all([
      this.audit.write({
        eventType: 'CASE_CREATED',
        actorId,
        actorType: 'OPERATOR',
        clientId: input.clientId,
        resourceId: cleanupCase.id,
        resourceType: 'CleanupCase',
        outcome: 'ALLOWED',
      }),
      this.timeline.append({
        caseId: cleanupCase.id,
        eventType: 'CASE_CREATED',
        actorId,
        actorType: 'OPERATOR',
      }),
    ]);

    return ok(cleanupCase);
  }

  async getById(id: string): Promise<Result<CleanupCase, ErrorCode>> {
    const c = await this.repo.findById(id);
    if (!c) return err('NOT_FOUND', `Case ${id} not found`);
    return ok(c);
  }

  async listForClient(clientId: string, includeClosed = false): Promise<CleanupCase[]> {
    return this.repo.listForClient(clientId, includeClosed);
  }

  async close(caseId: string, actorId: string): Promise<Result<CleanupCase, ErrorCode>> {
    const existing = await this.repo.findById(caseId);
    if (!existing) return err('NOT_FOUND', `Case ${caseId} not found`);
    if (existing.closedAt) return err('VALIDATION_ERROR', 'Case is already closed');

    const closed = await this.repo.close(caseId, new Date());

    await Promise.all([
      this.audit.write({
        eventType: 'CASE_CLOSED',
        actorId,
        actorType: 'OPERATOR',
        clientId: existing.clientId,
        resourceId: caseId,
        resourceType: 'CleanupCase',
        outcome: 'ALLOWED',
      }),
      this.timeline.append({
        caseId,
        eventType: 'CASE_CLOSED',
        actorId,
        actorType: 'OPERATOR',
      }),
    ]);

    return ok(closed);
  }
}
