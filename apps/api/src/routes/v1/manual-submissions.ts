import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

const SubmissionMethodSchema = z.enum(['WEB_FORM', 'EMAIL', 'SUPPORT_PORTAL', 'PHONE', 'MAIL', 'OTHER']);
const OutcomeStatusSchema = z.enum(['ACKNOWLEDGED', 'REJECTED', 'NEEDS_MORE_INFO', 'COMPLETED', 'FAILED']);

const CreateManualSubmissionBody = z.object({
  clientId: z.string().min(1),
  submissionMethod: SubmissionMethodSchema,
  redactedSummary: z.string().min(1).max(2000),
  submittedByUserId: z.string().optional(),
  operatorNotes: z.string().max(2000).optional(),
});

const RecordSubmittedBody = z.object({
  clientId: z.string().min(1),
  confirmationCode: z.string().max(500).optional(),
  confirmationUrl: z.string().url().max(2000).optional(),
  operatorNotes: z.string().max(2000).optional(),
});

const RecordOutcomeBody = z.object({
  clientId: z.string().min(1),
  status: OutcomeStatusSchema,
  confirmationCode: z.string().max(500).optional(),
  confirmationUrl: z.string().url().max(2000).optional(),
  operatorNotes: z.string().max(2000).optional(),
});

export const manualSubmissionRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { manualSubmissionService } = opts.services;
  const { userRepo } = opts;

  // POST /tasks/:taskId/manual-submissions — create a submission for a task
  fastify.post('/tasks/:taskId/manual-submissions', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = CreateManualSubmissionBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, submittedByUserId, operatorNotes, ...base } = body.data;
    const result = await manualSubmissionService.createForTask(
      {
        taskId,
        clientId,
        ...base,
        ...(submittedByUserId !== undefined ? { submittedByUserId } : {}),
        ...(operatorNotes !== undefined ? { operatorNotes } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, submission: result.value });
  });

  // GET /tasks/:taskId/manual-submissions — list submissions for a task
  fastify.get('/tasks/:taskId/manual-submissions', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const submissions = await manualSubmissionService.listForTask(taskId);
    return reply.send({ ok: true, submissions });
  });

  // GET /clients/:clientId/manual-submissions — list submissions for a client
  fastify.get('/clients/:clientId/manual-submissions', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const submissions = await manualSubmissionService.listForClient(clientId);
    return reply.send({ ok: true, submissions });
  });

  // POST /manual-submissions/:submissionId/submitted — mark as submitted
  fastify.post('/manual-submissions/:submissionId/submitted', async (request, reply) => {
    const { submissionId } = request.params as { submissionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = RecordSubmittedBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, confirmationCode, confirmationUrl, operatorNotes } = body.data;
    const result = await manualSubmissionService.recordSubmitted(
      submissionId,
      {
        ...(confirmationCode !== undefined ? { confirmationCode } : {}),
        ...(confirmationUrl !== undefined ? { confirmationUrl } : {}),
        ...(operatorNotes !== undefined ? { operatorNotes } : {}),
      },
      clientId,
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, submission: result.value });
  });

  // POST /manual-submissions/:submissionId/outcome — record target response
  fastify.post('/manual-submissions/:submissionId/outcome', async (request, reply) => {
    const { submissionId } = request.params as { submissionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = RecordOutcomeBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, status, confirmationCode, confirmationUrl, operatorNotes } = body.data;
    const result = await manualSubmissionService.recordOutcome(
      submissionId,
      {
        status,
        ...(confirmationCode !== undefined ? { confirmationCode } : {}),
        ...(confirmationUrl !== undefined ? { confirmationUrl } : {}),
        ...(operatorNotes !== undefined ? { operatorNotes } : {}),
      },
      clientId,
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, submission: result.value });
  });
};
