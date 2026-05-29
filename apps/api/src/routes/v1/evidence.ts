import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const EvidenceTypeSchema = z.enum([
  'SCREENSHOT',
  'CONFIRMATION_CODE',
  'EMAIL_RESPONSE',
  'WEB_FORM_RECEIPT',
  'MANUAL_NOTE',
  'OTHER',
]);

const RegisterEvidenceBody = z.object({
  clientId: z.string().min(1),
  storageKey: z.string().min(1).max(2000),
  contentHash: z.string().min(1).max(200),
  evidenceType: EvidenceTypeSchema,
  mimeType: z.string().max(200).optional(),
  sizeBytes: z.number().int().positive().optional(),
  retainUntil: z.string().datetime().optional(),
});

const EvidenceClientBody = z.object({
  clientId: z.string().min(1),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export const evidenceRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { evidenceService } = opts.services;
  const { userRepo } = opts;

  // POST /tasks/:taskId/evidence — register evidence
  fastify.post('/tasks/:taskId/evidence', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = RegisterEvidenceBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, storageKey, contentHash, evidenceType, mimeType, sizeBytes, retainUntil } = body.data;
    const result = await evidenceService.register(
      {
        taskId,
        clientId,
        storageKey,
        contentHash,
        evidenceType,
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(retainUntil !== undefined ? { retainUntil: new Date(retainUntil) } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) {
      const code = result.error === 'NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.code(201).send({ ok: true, evidence: result.value });
  });

  // GET /tasks/:taskId/evidence — list evidence for task (omits storageKey)
  fastify.get('/tasks/:taskId/evidence', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const query = EvidenceClientBody.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: query.error.flatten() });
    }
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const records = await evidenceService.listForTask(taskId, query.data.clientId);
    // Strip storageKey from list responses to avoid internal path exposure
    const safe = records.map(({ storageKey: _sk, ...rest }) => rest);
    return reply.send({ ok: true, evidence: safe });
  });

  // GET /evidence/:evidenceId — get single record (omits storageKey)
  fastify.get('/evidence/:evidenceId', async (request, reply) => {
    const { evidenceId } = request.params as { evidenceId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await evidenceService.getById(evidenceId);
    if (!result.ok) {
      return reply.code(404).send({ ok: false, error: result.error, message: result.message });
    }
    const { storageKey: _sk, ...safe } = result.value;
    return reply.send({ ok: true, evidence: safe });
  });

  // POST /evidence/:evidenceId/immutable — mark immutable
  fastify.post('/evidence/:evidenceId/immutable', async (request, reply) => {
    const { evidenceId } = request.params as { evidenceId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = EvidenceClientBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await evidenceService.markImmutable(evidenceId, body.data.clientId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'EVIDENCE_RECORD_NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    const { storageKey: _sk, ...safe } = result.value;
    return reply.send({ ok: true, evidence: safe });
  });
};
