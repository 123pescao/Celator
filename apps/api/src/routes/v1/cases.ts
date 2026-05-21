/**
 * Developer-testing routes for CleanupCase and CleanupTask management.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';

const CreateCaseBody = z.object({
  clientId: z.string().min(1),
  authorizationId: z.string().min(1),
  title: z.string().max(500).optional(),
});

const CreateTaskBody = z.object({
  caseId: z.string().min(1),
  clientId: z.string().min(1),
  sourceRef: z.string().optional(),
  findingUrl: z.string().url().optional(),
  actionType: z.string().optional(),
  riskTier: z.enum(['STANDARD', 'MEDIUM', 'HIGH']).optional(),
  matchStatus: z.string().optional(),
  preparedByUserId: z.string().optional(),
});

const TransitionTaskBody = z.object({
  toStatus: z.string().min(1),
  clientId: z.string().min(1),
  note: z.string().optional(),
});

export const caseRoutes: FastifyPluginAsync<{ services: AppServices }> = async (fastify, opts) => {
  const { caseService, taskService } = opts.services;

  // Cases
  fastify.post('/cases', async (request, reply) => {
    const actorId = (request.headers['x-dev-actor-id'] as string) ?? 'dev-actor';
    const body = CreateCaseBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { title, ...rest } = body.data;
    const result = await caseService.create({ ...rest, ...(title !== undefined ? { title } : {}) }, actorId);
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, case: result.value });
  });

  fastify.get('/cases/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await caseService.getById(id);
    if (!result.ok) return reply.code(404).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, case: result.value });
  });

  fastify.get('/clients/:clientId/cases', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const includeClosed = (request.query as Record<string, string>)['includeClosed'] === 'true';
    const cases = await caseService.listForClient(clientId, includeClosed);
    return reply.send({ ok: true, cases });
  });

  fastify.post('/cases/:id/close', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actorId = (request.headers['x-dev-actor-id'] as string) ?? 'dev-actor';
    const result = await caseService.close(id, actorId);
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, case: result.value });
  });

  // Tasks
  fastify.post('/tasks', async (request, reply) => {
    const actorId = (request.headers['x-dev-actor-id'] as string) ?? 'dev-actor';
    const body = CreateTaskBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, ...taskInput } = body.data;
    const result = await taskService.create(taskInput as Parameters<typeof taskService.create>[0], clientId, actorId);
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, task: result.value });
  });

  fastify.get('/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await taskService.getById(id);
    if (!result.ok) return reply.code(404).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, task: result.value });
  });

  fastify.get('/cases/:caseId/tasks', async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const tasks = await taskService.listForCase(caseId);
    return reply.send({ ok: true, tasks });
  });

  fastify.post('/tasks/:id/transition', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actorId = (request.headers['x-dev-actor-id'] as string) ?? 'dev-actor';
    const body = TransitionTaskBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await taskService.transition(
      id,
      body.data.toStatus as Parameters<typeof taskService.transition>[1],
      body.data.clientId,
      actorId,
      body.data.note,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, task: result.value });
  });

  fastify.get('/tasks/:id/allowed-transitions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const taskResult = await taskService.getById(id);
    if (!taskResult.ok) return reply.code(404).send({ ok: false, error: taskResult.error });
    const allowed = taskService.getAllowedTransitions(taskResult.value.status);
    return reply.send({ ok: true, currentStatus: taskResult.value.status, allowedTransitions: allowed });
  });
};
