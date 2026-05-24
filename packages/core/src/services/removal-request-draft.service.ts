import type { DataSourceTargetRepository } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { IdentityVaultIntakeService } from './identity-vault-intake.service.js';

export interface RemovalRequestDraftInput {
  clientId: string;
  dataSourceTargetId: string;
}

export interface VaultFieldStatus {
  fieldType: string;
  isPresent: boolean;
  redactedDisplay: string | null;
  recordId: string | null;
}

export interface RemovalRequestDraft {
  targetId: string;
  targetName: string;
  sourceType: string;
  supportedActionTypes: string[];
  requiredFields: string[];
  vaultFieldStatuses: VaultFieldStatus[];
  missingFields: string[];
  isReadyForReview: boolean;
  draftSummary: string;
}

export class RemovalRequestDraftService {
  constructor(
    private readonly targetRepo: DataSourceTargetRepository,
    private readonly vaultService: IdentityVaultIntakeService,
  ) {}

  async buildDraft(
    input: RemovalRequestDraftInput,
  ): Promise<Result<RemovalRequestDraft, ErrorCode>> {
    const target = await this.targetRepo.findById(input.dataSourceTargetId);
    if (!target) {
      return err('DATA_SOURCE_TARGET_NOT_FOUND', `DataSourceTarget ${input.dataSourceTargetId} not found`);
    }

    if (!target.isActive) {
      return err('VALIDATION_ERROR', `DataSourceTarget "${target.sourceName}" is not active`);
    }

    // List vault metadata — returns redacted display only, no plaintext, no ciphertext
    const vaultMetadata = await this.vaultService.listMetadata(input.clientId);

    const requiredFields = target.piiRequiredFields;

    // For each required field, find the best matching vault record (most recent non-shredded)
    const vaultFieldStatuses: VaultFieldStatus[] = requiredFields.map((fieldType) => {
      const match = vaultMetadata
        .filter((r) => r.fieldType === fieldType && !r.isCryptoShredded)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      return match
        ? { fieldType, isPresent: true, redactedDisplay: match.redactedDisplay, recordId: match.id }
        : { fieldType, isPresent: false, redactedDisplay: null, recordId: null };
    });

    const missingFields = vaultFieldStatuses.filter((s) => !s.isPresent).map((s) => s.fieldType);
    const isReadyForReview = missingFields.length === 0;

    const fieldSummary = vaultFieldStatuses
      .map((s) => `${s.fieldType}: ${s.isPresent ? (s.redactedDisplay ?? '[redacted]') : 'missing'}`)
      .join(', ');

    const actionSummary = target.supportedActionTypes.length > 0
      ? target.supportedActionTypes[0]
      : 'REQUEST';

    const draftSummary = `${actionSummary} to ${target.sourceName}${target.baseDomain ? ` (${target.baseDomain})` : ''} — ${fieldSummary}`;

    return ok({
      targetId: target.id,
      targetName: target.sourceName,
      sourceType: target.sourceType,
      supportedActionTypes: target.supportedActionTypes,
      requiredFields,
      vaultFieldStatuses,
      missingFields,
      isReadyForReview,
      draftSummary,
    });
  }
}
