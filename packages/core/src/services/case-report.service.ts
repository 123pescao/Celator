import type { CaseReportRepository, ReportType, ExportFormat, ReportStatus, CaseReport } from '@celator/db';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { IdentityVaultIntakeService } from './identity-vault-intake.service.js';

// ─── Terminal report statuses ────────────────────────────────────────────────

const TERMINAL_REPORT_STATUSES: ReportStatus[] = ['READY', 'FAILED', 'EXPIRED'];

// ─── Input / output types ────────────────────────────────────────────────────

export interface RequestReportInput {
  clientId: string;
  caseId?: string;
  reportType: ReportType;
  exportFormat: ExportFormat;
  redactedSummary: string;
  requestedByUserId?: string;
  expiresInDays?: number;
}

export interface SafeCaseReport {
  id: string;
  clientId: string;
  caseId: string | null;
  reportType: string;
  exportFormat: string;
  status: string;
  redactedSummary: string;
  requestedByUserId: string | null;
  generatedAt: Date | null;
  failedAt: Date | null;
  expiresAt: Date | null;
  failureReason: string | null;
  vaultAccessLogged: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Helper — vaultAccessLogId is intentionally excluded from API response ───

function toSafe(r: CaseReport): SafeCaseReport {
  return {
    id: r.id,
    clientId: r.clientId,
    caseId: r.caseId,
    reportType: r.reportType,
    exportFormat: r.exportFormat,
    status: r.status,
    redactedSummary: r.redactedSummary,
    requestedByUserId: r.requestedByUserId,
    generatedAt: r.generatedAt,
    failedAt: r.failedAt,
    expiresAt: r.expiresAt,
    failureReason: r.failureReason,
    vaultAccessLogged: r.vaultAccessLogId !== null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ─── Service ──────────���───────────────────────���──────────────────────────────

export class CaseReportService {
  constructor(
    private readonly reportRepo: CaseReportRepository,
    private readonly vaultService: IdentityVaultIntakeService,
    private readonly audit: AuditService,
  ) {}

  async requestReport(
    input: RequestReportInput,
    actorId: string,
  ): Promise<Result<SafeCaseReport, ErrorCode>> {
    const summaryViolation = checkRedactedPreview(input.redactedSummary);
    if (summaryViolation) {
      return err('REPORT_CONTENT_UNSAFE', `redactedSummary rejected: ${summaryViolation}`);
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (input.expiresInDays ?? 30));

    const report = await this.reportRepo.create({
      client: { connect: { id: input.clientId } },
      ...(input.caseId !== undefined ? { case: { connect: { id: input.caseId } } } : {}),
      reportType: input.reportType,
      exportFormat: input.exportFormat,
      redactedSummary: input.redactedSummary,
      expiresAt,
      ...(input.requestedByUserId !== undefined ? { requestedByUserId: input.requestedByUserId } : {}),
    });

    const auditResult = await this.audit.write({
      eventType: 'REPORT_REQUESTED',
      actorId,
      actorType: 'OPERATOR',
      clientId: input.clientId,
      resourceId: report.id,
      resourceType: 'CaseReport',
      outcome: 'ALLOWED',
      metadata: {
        reportId: report.id,
        reportType: input.reportType,
        exportFormat: input.exportFormat,
        ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
      },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(report));
  }

  async generateStub(
    reportId: string,
    actorId: string,
    vaultRecordId?: string,
  ): Promise<Result<SafeCaseReport, ErrorCode>> {
    const report = await this.reportRepo.findById(reportId);
    if (!report) return err('REPORT_NOT_FOUND', `Report ${reportId} not found`);

    if (report.status !== 'PENDING') {
      return err('REPORT_INVALID_STATUS', `Cannot generate from status "${report.status}" — must be PENDING`);
    }

    // Optionally log vault access for report types that require it
    if (
      vaultRecordId !== undefined &&
      (report.reportType === 'PROOF_PACKET' || report.reportType === 'FULL_CASE_EXPORT')
    ) {
      await this.vaultService.logAccess(vaultRecordId, 'PURPOSE_REPORT_GENERATION', actorId, 'OPERATOR');
      // Note: vaultAccessLogId not stored in Foundation phase — logAccess does not return log ID.
      // The vault audit trail exists in IdentityVaultAccessLog. Wire in a future phase.
    }

    const now = new Date();
    const updated = await this.reportRepo.updateStatus(reportId, 'READY', { generatedAt: now });

    const auditResult = await this.audit.write({
      eventType: 'REPORT_GENERATED_STUB',
      actorId,
      actorType: 'OPERATOR',
      clientId: report.clientId,
      resourceId: reportId,
      resourceType: 'CaseReport',
      outcome: 'ALLOWED',
      metadata: {
        reportId,
        reportType: report.reportType,
        exportFormat: report.exportFormat,
        vaultAccessLogged: vaultRecordId !== undefined,
      },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async markFailed(
    reportId: string,
    failureReason: string,
    actorId: string,
  ): Promise<Result<SafeCaseReport, ErrorCode>> {
    const report = await this.reportRepo.findById(reportId);
    if (!report) return err('REPORT_NOT_FOUND', `Report ${reportId} not found`);

    if (TERMINAL_REPORT_STATUSES.includes(report.status as ReportStatus)) {
      return err('REPORT_INVALID_STATUS', `Cannot mark FAILED from terminal status "${report.status}"`);
    }

    const reasonViolation = checkRedactedPreview(failureReason);
    if (reasonViolation) {
      return err('REPORT_CONTENT_UNSAFE', `failureReason rejected: ${reasonViolation}`);
    }

    const now = new Date();
    const updated = await this.reportRepo.updateStatus(reportId, 'FAILED', {
      failedAt: now,
      failureReason,
    });

    const auditResult = await this.audit.write({
      eventType: 'REPORT_FAILED',
      actorId,
      actorType: 'OPERATOR',
      clientId: report.clientId,
      resourceId: reportId,
      resourceType: 'CaseReport',
      outcome: 'BLOCKED',
      metadata: { reportId, reportType: report.reportType },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async expireReport(
    reportId: string,
    actorId: string,
  ): Promise<Result<SafeCaseReport, ErrorCode>> {
    const report = await this.reportRepo.findById(reportId);
    if (!report) return err('REPORT_NOT_FOUND', `Report ${reportId} not found`);

    if (report.status !== 'READY') {
      return err('REPORT_INVALID_STATUS', `Cannot expire report with status "${report.status}" — must be READY`);
    }

    const updated = await this.reportRepo.updateStatus(reportId, 'EXPIRED');

    const auditResult = await this.audit.write({
      eventType: 'REPORT_EXPIRED',
      actorId,
      actorType: 'OPERATOR',
      clientId: report.clientId,
      resourceId: reportId,
      resourceType: 'CaseReport',
      outcome: 'ALLOWED',
      metadata: { reportId, reportType: report.reportType },
    });
    if (!auditResult.ok) return auditResult;

    return ok(toSafe(updated));
  }

  async getById(reportId: string): Promise<Result<SafeCaseReport, ErrorCode>> {
    const report = await this.reportRepo.findById(reportId);
    if (!report) return err('REPORT_NOT_FOUND', `Report ${reportId} not found`);

    // Security: enforce expiry at read time
    if (report.expiresAt !== null && report.expiresAt < new Date()) {
      return err('REPORT_EXPIRED', `Report ${reportId} has expired`);
    }

    return ok(toSafe(report));
  }

  async listForClient(clientId: string): Promise<SafeCaseReport[]> {
    const reports = await this.reportRepo.listForClient(clientId);
    return reports.map(toSafe);
  }

  async listForCase(caseId: string): Promise<SafeCaseReport[]> {
    const reports = await this.reportRepo.listForCase(caseId);
    return reports.map(toSafe);
  }
}
