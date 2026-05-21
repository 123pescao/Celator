import type { ClientIdentityVerificationRepository } from '@celator/db';
import type { ClientIdentityVerification } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { CaseTimelineService } from './case-timeline.service.js';
import type { ClientService } from './client.service.js';

export class ClientIdentityVerificationService {
  constructor(
    private readonly repo: ClientIdentityVerificationRepository,
    private readonly clientService: ClientService,
    private readonly audit: AuditService,
    private readonly timeline: CaseTimelineService,
  ) {}

  async createRecord(clientId: string, actorId: string): Promise<Result<ClientIdentityVerification, ErrorCode>> {
    const clientResult = await this.clientService.getById(clientId);
    if (!clientResult.ok) return clientResult;

    const record = await this.repo.create({
      client: { connect: { id: clientId } },
      status: 'PENDING',
    });

    await this.audit.write({
      eventType: 'IDENTITY_VERIFICATION_CREATED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: record.id,
      resourceType: 'ClientIdentityVerification',
      outcome: 'ALLOWED',
    });

    return ok(record);
  }

  async recordOperatorAttestation(
    verificationId: string,
    operatorAttestation: string,
    operatorId: string,
  ): Promise<Result<ClientIdentityVerification, ErrorCode>> {
    const existing = await this.repo.findById(verificationId);
    if (!existing) return err('NOT_FOUND', `Verification ${verificationId} not found`);
    if (existing.status !== 'PENDING') {
      return err('VALIDATION_ERROR', `Verification is in status ${existing.status}, cannot attest`);
    }

    const updated = await this.repo.update(verificationId, {
      operatorAttestation,
      operatorId,
    });

    await this.audit.write({
      eventType: 'IDENTITY_VERIFICATION_ATTESTED',
      actorId: operatorId,
      actorType: 'OPERATOR',
      clientId: existing.clientId,
      resourceId: verificationId,
      resourceType: 'ClientIdentityVerification',
      outcome: 'ALLOWED',
    });

    return ok(updated);
  }

  async completeVerification(
    verificationId: string,
    operatorId: string,
  ): Promise<Result<ClientIdentityVerification, ErrorCode>> {
    const existing = await this.repo.findById(verificationId);
    if (!existing) return err('NOT_FOUND', `Verification ${verificationId} not found`);
    if (existing.status !== 'PENDING') {
      return err('VALIDATION_ERROR', `Verification is in status ${existing.status}, cannot complete`);
    }
    if (!existing.operatorAttestation) {
      return err('VALIDATION_ERROR', 'Operator attestation is required before completing verification');
    }

    const updated = await this.repo.updateStatus(verificationId, 'VERIFIED', { verifiedAt: new Date() });

    // Activate the client now that identity is verified
    await this.clientService.activateAfterVerification(existing.clientId, operatorId);

    await this.audit.write({
      eventType: 'IDENTITY_VERIFICATION_COMPLETED',
      actorId: operatorId,
      actorType: 'OPERATOR',
      clientId: existing.clientId,
      resourceId: verificationId,
      resourceType: 'ClientIdentityVerification',
      outcome: 'ALLOWED',
    });

    return ok(updated);
  }

  async rejectVerification(
    verificationId: string,
    rejectionReason: string,
    operatorId: string,
  ): Promise<Result<ClientIdentityVerification, ErrorCode>> {
    const existing = await this.repo.findById(verificationId);
    if (!existing) return err('NOT_FOUND', `Verification ${verificationId} not found`);
    if (existing.status !== 'PENDING' && existing.status !== 'REQUIRES_DOCUMENT_REVIEW') {
      return err('VALIDATION_ERROR', `Verification is in status ${existing.status}, cannot reject`);
    }

    const updated = await this.repo.updateStatus(verificationId, 'REJECTED', {
      rejectedAt: new Date(),
      rejectionReason,
    });

    await this.audit.write({
      eventType: 'IDENTITY_VERIFICATION_REJECTED',
      actorId: operatorId,
      actorType: 'OPERATOR',
      clientId: existing.clientId,
      resourceId: verificationId,
      resourceType: 'ClientIdentityVerification',
      outcome: 'ALLOWED',
      metadata: { rejectionReason },
    });

    return ok(updated);
  }

  async getLatest(clientId: string): Promise<ClientIdentityVerification | null> {
    return this.repo.findLatestForClient(clientId);
  }
}
