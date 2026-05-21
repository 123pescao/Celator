import type { ConsentVersionRepository, ClientAuthorizationRepository } from '@celator/db';
import type { ConsentVersion, ClientAuthorization } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { CleanupTaskService } from './cleanup-task.service.js';

export interface CreateAuthorizationInput {
  clientId: string;
  consentVersionId: string;
  scopeNames: string[];
  jurisdiction: string;
  signedAt: Date;
  expiresAt?: Date;
  authorizationType?: 'SELF' | 'LEGAL_GUARDIAN' | 'POWER_OF_ATTORNEY' | 'EMPLOYER_SAFETY' | 'DECEASED_ESTATE' | 'ATTORNEY_CLIENT';
}

export class ConsentWorkflowService {
  constructor(
    private readonly consentVersionRepo: ConsentVersionRepository,
    private readonly authorizationRepo: ClientAuthorizationRepository,
    private readonly audit: AuditService,
    private readonly taskService: () => CleanupTaskService, // lazy to break circular dep
  ) {}

  async createConsentVersion(
    version: string,
    documentHash: string,
    effectiveFrom: Date,
    effectiveUntil: Date | undefined,
    createdBy: string,
  ): Promise<Result<ConsentVersion, ErrorCode>> {
    const existing = await this.consentVersionRepo.findByVersion(version);
    if (existing) {
      return err('VALIDATION_ERROR', `Consent version "${version}" already exists`);
    }

    const record = await this.consentVersionRepo.create({
      version,
      documentHash,
      effectiveFrom,
      effectiveUntil: effectiveUntil ?? null,
    });

    await this.audit.write({
      eventType: 'CONSENT_VERSION_CREATED',
      actorId: createdBy,
      actorType: 'ADMIN',
      resourceId: record.id,
      resourceType: 'ConsentVersion',
      outcome: 'ALLOWED',
      metadata: { version, documentHash },
    });

    return ok(record);
  }

  async createAuthorization(
    input: CreateAuthorizationInput,
    actorId: string,
  ): Promise<Result<ClientAuthorization, ErrorCode>> {
    const consentVersion = await this.consentVersionRepo.findById(input.consentVersionId);
    if (!consentVersion) {
      return err('NOT_FOUND', `Consent version ${input.consentVersionId} not found`);
    }

    const auth = await this.authorizationRepo.create({
      client: { connect: { id: input.clientId } },
      consentVersion: { connect: { id: input.consentVersionId } },
      scopeNames: input.scopeNames,
      jurisdiction: input.jurisdiction,
      signedAt: input.signedAt,
      expiresAt: input.expiresAt ?? null,
      authorizationType: input.authorizationType ?? 'SELF',
    });

    await this.audit.write({
      eventType: 'AUTHORIZATION_CREATED',
      actorId,
      actorType: 'OPERATOR',
      clientId: input.clientId,
      resourceId: auth.id,
      resourceType: 'ClientAuthorization',
      outcome: 'ALLOWED',
      metadata: { scopeNames: input.scopeNames, jurisdiction: input.jurisdiction },
    });

    return ok(auth);
  }

  async revokeAuthorization(
    authorizationId: string,
    reason: string,
    actorId: string,
    caseId?: string,
  ): Promise<Result<ClientAuthorization, ErrorCode>> {
    const auth = await this.authorizationRepo.findById(authorizationId);
    if (!auth) return err('AUTHORIZATION_NOT_FOUND', `Authorization ${authorizationId} not found`);
    if (auth.revokedAt) return err('AUTHORIZATION_REVOKED', 'Authorization is already revoked');

    const revoked = await this.authorizationRepo.revoke(authorizationId, reason, new Date());

    await this.audit.write({
      eventType: 'AUTHORIZATION_REVOKED',
      actorId,
      actorType: 'OPERATOR',
      clientId: auth.clientId,
      resourceId: authorizationId,
      resourceType: 'ClientAuthorization',
      outcome: 'ALLOWED',
      metadata: { reason },
    });

    // Pause any active tasks in cases linked to this authorization
    if (caseId) {
      await this.taskService().pauseTasksForRevocation(caseId, authorizationId, actorId);
    }

    return ok(revoked);
  }

  async evaluateActionCoverage(
    authorizationId: string,
    actionType: string,
    jurisdiction: string,
  ): Promise<Result<{ covered: boolean; reason: string }, ErrorCode>> {
    const auth = await this.authorizationRepo.findById(authorizationId);
    if (!auth) return err('AUTHORIZATION_NOT_FOUND', `Authorization ${authorizationId} not found`);

    if (auth.revokedAt) {
      return ok({ covered: false, reason: 'Authorization has been revoked' });
    }

    const now = new Date();
    if (auth.expiresAt && auth.expiresAt < now) {
      return ok({ covered: false, reason: 'Authorization has expired' });
    }

    // Check jurisdiction match: auth jurisdiction must be "*", same as requested, or a prefix
    const jurisdictionMatch =
      auth.jurisdiction === '*' ||
      auth.jurisdiction === jurisdiction ||
      jurisdiction.startsWith(auth.jurisdiction + '-');

    if (!jurisdictionMatch) {
      return ok({ covered: false, reason: `Authorization jurisdiction "${auth.jurisdiction}" does not cover "${jurisdiction}"` });
    }

    // Check scope coverage
    const covered = auth.scopeNames.some((s) => s === actionType || s === '*');
    if (!covered) {
      return ok({ covered: false, reason: `Action type "${actionType}" is not in authorization scopes` });
    }

    return ok({ covered: true, reason: 'Authorized' });
  }

  async getActiveAuthorizations(clientId: string): Promise<ClientAuthorization[]> {
    return this.authorizationRepo.findActiveForClient(clientId);
  }
}
