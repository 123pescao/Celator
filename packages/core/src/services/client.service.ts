import type { ClientRepository } from '@celator/db';
import type { Client, ClientStatus } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';

export interface CreateClientInput {
  organizationId: string;
  displayName: string;
}

export class ClientService {
  constructor(
    private readonly repo: ClientRepository,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateClientInput, actorId: string): Promise<Result<Client, ErrorCode>> {
    const client = await this.repo.create({
      organization: { connect: { id: input.organizationId } },
      displayName: input.displayName,
      status: 'PENDING_IDENTITY_VERIFICATION',
    });

    const auditResult = await this.audit.write({
      eventType: 'CLIENT_CREATED',
      actorId,
      actorType: 'OPERATOR',
      clientId: client.id,
      resourceId: client.id,
      resourceType: 'Client',
      outcome: 'ALLOWED',
    });
    if (!auditResult.ok) return auditResult;

    return ok(client);
  }

  async getById(id: string): Promise<Result<Client, ErrorCode>> {
    const client = await this.repo.findById(id);
    if (!client) return err('CLIENT_NOT_FOUND', `Client ${id} not found`);
    return ok(client);
  }

  async listByOrg(organizationId: string): Promise<Client[]> {
    return this.repo.listByOrg(organizationId);
  }

  async activateAfterVerification(clientId: string, actorId: string): Promise<Result<Client, ErrorCode>> {
    const existing = await this.repo.findById(clientId);
    if (!existing) return err('CLIENT_NOT_FOUND', `Client ${clientId} not found`);

    if (existing.status !== 'PENDING_IDENTITY_VERIFICATION') {
      return err('VALIDATION_ERROR', `Client is in status ${existing.status}, cannot activate`);
    }

    const updated = await this.repo.updateStatus(clientId, 'ACTIVE');

    const auditResult = await this.audit.write({
      eventType: 'CLIENT_ACTIVATED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: clientId,
      resourceType: 'Client',
      outcome: 'ALLOWED',
      metadata: { previousStatus: existing.status },
    });
    if (!auditResult.ok) return auditResult;

    return ok(updated);
  }

  async updateStatus(clientId: string, status: ClientStatus, actorId: string): Promise<Result<Client, ErrorCode>> {
    const existing = await this.repo.findById(clientId);
    if (!existing) return err('CLIENT_NOT_FOUND', `Client ${clientId} not found`);

    const updated = await this.repo.updateStatus(clientId, status);

    const auditResult = await this.audit.write({
      eventType: 'CLIENT_STATUS_CHANGED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: clientId,
      resourceType: 'Client',
      outcome: 'ALLOWED',
      metadata: { fromStatus: existing.status, toStatus: status },
    });
    if (!auditResult.ok) return auditResult;

    return ok(updated);
  }

  async setFlags(
    clientId: string,
    flags: { hasDisputeFlag?: boolean; hasComplianceHold?: boolean },
    actorId: string,
  ): Promise<Result<Client, ErrorCode>> {
    const existing = await this.repo.findById(clientId);
    if (!existing) return err('CLIENT_NOT_FOUND', `Client ${clientId} not found`);

    const updated = await this.repo.update(clientId, flags);

    const auditResult = await this.audit.write({
      eventType: 'CLIENT_FLAGS_UPDATED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: clientId,
      resourceType: 'Client',
      outcome: 'ALLOWED',
      metadata: flags,
    });
    if (!auditResult.ok) return auditResult;

    return ok(updated);
  }
}
