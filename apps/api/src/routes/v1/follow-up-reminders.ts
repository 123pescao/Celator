import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const CreateFollowUpBody = z.object({
  clientId: z.string().min(1),
  dueAt: z.string().datetime(),
  safeNote: z.string().max(2000).optional(),
  createdByUserId: z.string().optional(),
});

const FollowUpClientBody = z.object({
  clientId: z.string().min(1),
});

const ListDueQuery = z.object({
  clientId: z.string().min(1),
  asOf: z.string().datetime().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export const followUpRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { followUpService } = opts.services;
  const { userRepo } = opts;

  // POST /tasks/:taskId/follow-ups — schedule follow-up
  fastify.post('/tasks/:taskId/follow-ups', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = CreateFollowUpBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, dueAt, safeNote, createdByUserId } = body.data;
    const result = await followUpService.create(
      {
        taskId,
        clientId,
        dueAt: new Date(dueAt),
        ...(safeNote !== undefined ? { safeNote } : {}),
        ...(createdByUserId !== undefined ? { createdByUserId } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) {
      const code = result.error === 'NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.code(201).send({ ok: true, followUp: result.value });
  });

  // GET /tasks/:taskId/follow-ups — list follow-ups for task
  fastify.get('/tasks/:taskId/follow-ups', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const followUps = await followUpService.listForTask(taskId);
    return reply.send({ ok: true, followUps });
  });

  // GET /clients/:clientId/follow-ups — list follow-ups for client
  fastify.get('/clients/:clientId/follow-ups', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const followUps = await followUpService.listForClient(clientId);
    return reply.send({ ok: true, followUps });
  });

  // GET /follow-ups/due — list due follow-ups for a specific client
  fastify.get('/follow-ups/due', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const query = ListDueQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: query.error.flatten() });
    }
    const asOf = query.data.asOf ? new Date(query.data.asOf) : new Date();
    const followUps = await followUpService.listDueAsOf(asOf, query.data.clientId);
    return reply.send({ ok: true, followUps });
  });

  // POST /follow-ups/:followUpId/complete — complete a follow-up
  fastify.post('/follow-ups/:followUpId/complete', async (request, reply) => {
    const { followUpId } = request.params as { followUpId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = FollowUpClientBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await followUpService.complete(followUpId, body.data.clientId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'FOLLOW_UP_NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, followUp: result.value });
  });

  // POST /follow-ups/:followUpId/cancel — cancel a follow-up
  fastify.post('/follow-ups/:followUpId/cancel', async (request, reply) => {
    const { followUpId } = request.params as { followUpId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = FollowUpClientBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await followUpService.cancel(followUpId, body.data.clientId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'FOLLOW_UP_NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, followUp: result.value });
  });
};

// Need to also export listForTask as a route-accessible method
// Note: followUpService.listForTask is called without clientId — for task-level listing
// this is intentional since task ownership is implied by the route context
