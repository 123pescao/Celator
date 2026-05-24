import type { DataSourceTargetRepository } from '@celator/db';
import type { DataSourceTarget, SourceType, ActionType } from '@celator/db';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';

export interface CreateDataSourceTargetInput {
  sourceName: string;
  sourceType: SourceType;
  baseDomain?: string | undefined;
  jurisdiction?: string | undefined;
  supportedActionTypes?: ActionType[] | undefined;
  requiresLogin?: boolean | undefined;
  requiresCaptcha?: boolean | undefined;
  manualOnly?: boolean | undefined;
  piiRequiredFields?: string[] | undefined;
  notes?: string | undefined;
  isActive?: boolean | undefined;
}

export interface UpdateDataSourceTargetInput {
  isActive?: boolean | undefined;
  notes?: string | undefined;
  supportedActionTypes?: ActionType[] | undefined;
  piiRequiredFields?: string[] | undefined;
}

export class DataSourceTargetService {
  constructor(private readonly repo: DataSourceTargetRepository) {}

  async create(input: CreateDataSourceTargetInput): Promise<Result<DataSourceTarget, ErrorCode>> {
    if (!input.sourceName.trim()) {
      return err('VALIDATION_ERROR', 'sourceName is required');
    }

    const existing = await this.repo.findBySourceName(input.sourceName);
    if (existing) {
      return err('VALIDATION_ERROR', `DataSourceTarget with sourceName "${input.sourceName}" already exists`);
    }

    const target = await this.repo.create(input);
    return ok(target);
  }

  async getById(id: string): Promise<Result<DataSourceTarget, ErrorCode>> {
    const target = await this.repo.findById(id);
    if (!target) return err('DATA_SOURCE_TARGET_NOT_FOUND', `DataSourceTarget ${id} not found`);
    return ok(target);
  }

  async getByName(sourceName: string): Promise<Result<DataSourceTarget, ErrorCode>> {
    const target = await this.repo.findBySourceName(sourceName);
    if (!target) return err('DATA_SOURCE_TARGET_NOT_FOUND', `DataSourceTarget "${sourceName}" not found`);
    return ok(target);
  }

  async listActive(sourceType?: SourceType): Promise<DataSourceTarget[]> {
    return this.repo.listActive(sourceType);
  }

  async list(isActive?: boolean): Promise<DataSourceTarget[]> {
    return this.repo.list(isActive);
  }

  async update(id: string, input: UpdateDataSourceTargetInput): Promise<Result<DataSourceTarget, ErrorCode>> {
    const existing = await this.repo.findById(id);
    if (!existing) return err('DATA_SOURCE_TARGET_NOT_FOUND', `DataSourceTarget ${id} not found`);

    const updated = await this.repo.update(id, {
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.supportedActionTypes !== undefined ? { supportedActionTypes: input.supportedActionTypes } : {}),
      ...(input.piiRequiredFields !== undefined ? { piiRequiredFields: input.piiRequiredFields } : {}),
    });
    return ok(updated);
  }
}
