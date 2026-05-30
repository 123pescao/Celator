import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const REPORT_TYPES = ['CASE_SUMMARY', 'EVIDENCE_SUMMARY', 'FULL_CASE_EXPORT', 'PROOF_PACKET'] as const;
const EXPORT_FORMATS = ['JSON', 'CSV', 'PDF_STUB'] as const;

const RequestReportBody = z.object({
  clientId: z.string().min(1),
  caseId: z.string().min(1).optional(),
  reportType: z.enum(REPORT_TYPES),
  exportFormat: z.enum(EXPORT_FORMATS),
  redactedSummary: z.string().min(1).max(2000),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  requestedByUserId: z.string().min(1).optional(),
});

const GenerateStubBody = z.object({
  vaultRecordId: z.string().min(1).optional(),
});

const FailReportBody = z.object({
  failureReason: z.string().min(1).max(2000),
});

// ─── Error code → HTTP status ─────────────────────────────────────────────────

function reportStatusCode(error: string): number {
  if (error === 'REPORT_NOT_FOUND') return 404;
  if (error === 'REPORT_EXPIRED') return 410;
  if (error === 'REPORT_INVALID_STATUS') return 409;
  if (error === 'FORBIDDEN') return 403;
  return 400;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const reportRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { caseReportService } = opts.services;
  const { userRepo } = opts;

  // POST /reports — request a new report
  fastify.post('/reports', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = RequestReportBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await caseReportService.requestReport(
      {
        clientId: body.data.clientId,
        ...(body.data.caseId !== undefined ? { caseId: body.data.caseId } : {}),
        reportType: body.data.reportType,
        exportFormat: body.data.exportFormat,
        redactedSummary: body.data.redactedSummary,
        ...(body.data.expiresInDays !== undefined ? { expiresInDays: body.data.expiresInDays } : {}),
        ...(body.data.requestedByUserId !== undefined ? { requestedByUserId: body.data.requestedByUserId } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) {
      return reply.code(reportStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.code(201).send({ ok: true, report: result.value });
  });

  // GET /reports/:reportId — get report by ID (enforces expiry)
  fastify.get('/reports/:reportId', async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await caseReportService.getById(reportId);
    if (!result.ok) {
      return reply.code(reportStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, report: result.value });
  });

  // GET /clients/:clientId/reports — list reports for client
  fastify.get('/clients/:clientId/reports', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const reports = await caseReportService.listForClient(clientId);
    return reply.send({ ok: true, reports });
  });

  // GET /cases/:caseId/reports — list reports for case
  fastify.get('/cases/:caseId/reports', async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const reports = await caseReportService.listForCase(caseId);
    return reply.send({ ok: true, reports });
  });

  // POST /reports/:reportId/generate — generate stub (PENDING → READY)
  fastify.post('/reports/:reportId/generate', async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = GenerateStubBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await caseReportService.generateStub(reportId, ctx.actor.id, body.data.vaultRecordId);
    if (!result.ok) {
      return reply.code(reportStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, report: result.value });
  });

  // POST /reports/:reportId/expire — expire a READY report
  fastify.post('/reports/:reportId/expire', async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await caseReportService.expireReport(reportId, ctx.actor.id);
    if (!result.ok) {
      return reply.code(reportStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, report: result.value });
  });

  // POST /reports/:reportId/fail — mark report as failed
  fastify.post('/reports/:reportId/fail', async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = FailReportBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await caseReportService.markFailed(reportId, body.data.failureReason, ctx.actor.id);
    if (!result.ok) {
      return reply.code(reportStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, report: result.value });
  });
};
