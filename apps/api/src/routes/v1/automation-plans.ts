import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

// ─── intentJson Zod schema (security-reviewed constraints) ───────────────────
// Max depth 2, allowlisted keys, string values capped at 500 chars, ≤ 20 keys.
// This prevents unbounded blobs and ensures PII cannot be hidden in deep nesting.

const INTENT_ALLOWED_KEYS = new Set([
  'action', 'targetId', 'targetType', 'sourceType', 'jurisdiction',
  'actionType', 'playbookId', 'stepId', 'priority', 'notes', 'reason',
  'requestedAt', 'dataSourceTargetId', 'taskId',
]);

const IntentValueSchema = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(
    z.string().max(100),
    z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
  ).refine(obj => Object.keys(obj).length <= 10, 'Nested object must have ≤ 10 keys'),
]);

const IntentJsonSchema = z
  .record(z.string().max(100), IntentValueSchema)
  .refine(
    obj => Object.keys(obj).length <= 20,
    'intentJson must have ≤ 20 top-level keys',
  )
  .refine(
    obj => Object.keys(obj).every(k => INTENT_ALLOWED_KEYS.has(k)),
    `intentJson keys must be one of: ${[...INTENT_ALLOWED_KEYS].join(', ')}`,
  );

// ─── Request body schemas ─────────────────────────────────────────────────────

const CreatePlanBody = z.object({
  taskId: z.string().min(1),
  clientId: z.string().min(1),
  intentJson: IntentJsonSchema,
  createdByUserId: z.string().min(1).optional(),
});

const ApprovePlanBody = z.object({
  approvedByUserId: z.string().min(1),
});

const RejectPlanBody = z.object({
  rejectedByUserId: z.string().min(1),
  rejectionReason: z.string().min(1).max(2000),
});

const CancelPlanBody = z.object({
  cancelledByUserId: z.string().min(1),
});

// ─── Error code → HTTP status ─────────────────────────────────────────────────

function planStatusCode(error: string): number {
  if (error === 'AUTOMATION_PLAN_NOT_FOUND' || error === 'NOT_FOUND') return 404;
  if (error === 'AUTOMATION_PLAN_INVALID_STATUS') return 409;
  if (error === 'AUTOMATION_PLAN_PAUSED') return 409;
  if (error === 'FORBIDDEN') return 403;
  return 400;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const automationPlanRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { automationPlanService } = opts.services;
  const { userRepo } = opts;

  // POST /automation-plans — create plan
  fastify.post('/automation-plans', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = CreatePlanBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await automationPlanService.createPlan(
      {
        taskId: body.data.taskId,
        clientId: body.data.clientId,
        intentJson: body.data.intentJson as Record<string, unknown>,
        ...(body.data.createdByUserId !== undefined ? { createdByUserId: body.data.createdByUserId } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) {
      return reply.code(planStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.code(201).send({ ok: true, plan: result.value });
  });

  // GET /automation-plans/:planId — get plan by ID
  fastify.get('/automation-plans/:planId', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await automationPlanService.getById(planId);
    if (!result.ok) {
      return reply.code(planStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, plan: result.value });
  });

  // GET /tasks/:taskId/automation-plans — list plans for task
  fastify.get('/tasks/:taskId/automation-plans', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const plans = await automationPlanService.listForTask(taskId);
    return reply.send({ ok: true, plans });
  });

  // GET /clients/:clientId/automation-plans — list plans for client
  fastify.get('/clients/:clientId/automation-plans', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const plans = await automationPlanService.listForClient(clientId);
    return reply.send({ ok: true, plans });
  });

  // POST /automation-plans/:planId/approve — approve plan
  fastify.post('/automation-plans/:planId/approve', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = ApprovePlanBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await automationPlanService.approvePlan(planId, body.data.approvedByUserId, ctx.actor.id);
    if (!result.ok) {
      return reply.code(planStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, plan: result.value });
  });

  // POST /automation-plans/:planId/reject — reject plan
  fastify.post('/automation-plans/:planId/reject', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = RejectPlanBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await automationPlanService.rejectPlan(planId, body.data.rejectedByUserId, body.data.rejectionReason, ctx.actor.id);
    if (!result.ok) {
      return reply.code(planStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, plan: result.value });
  });

  // POST /automation-plans/:planId/execute-dry-run — execute DRY_RUN
  fastify.post('/automation-plans/:planId/execute-dry-run', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await automationPlanService.executeDryRun(planId, ctx.actor.id);
    if (!result.ok) {
      return reply.code(planStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, plan: result.value });
  });

  // POST /automation-plans/:planId/cancel — cancel plan
  fastify.post('/automation-plans/:planId/cancel', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = CancelPlanBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await automationPlanService.cancelPlan(planId, body.data.cancelledByUserId, ctx.actor.id);
    if (!result.ok) {
      return reply.code(planStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, plan: result.value });
  });
};
