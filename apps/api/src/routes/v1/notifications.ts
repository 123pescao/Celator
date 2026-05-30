import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ScheduleNotificationBody = z.object({
  clientId: z.string().min(1),
  caseId: z.string().min(1).optional(),
  subjectSafe: z.string().min(1).max(500),
  bodySafe: z.string().min(1).max(2000),
  scheduledFor: z.string().datetime(),
  createdByUserId: z.string().min(1).optional(),
});

const ScheduleForTaskBody = z.object({
  clientId: z.string().min(1),
  caseId: z.string().min(1).optional(),
  subjectSafe: z.string().min(1).max(500),
  bodySafe: z.string().min(1).max(2000),
  scheduledFor: z.string().datetime(),
  createdByUserId: z.string().min(1).optional(),
});

const ScheduleForFollowUpBody = z.object({
  subjectSafe: z.string().min(1).max(500),
  bodySafe: z.string().min(1).max(2000),
  scheduledFor: z.string().datetime(),
});

const FailNotificationBody = z.object({
  failureReason: z.string().min(1).max(2000),
});

// ─── Error code → HTTP status ─────────────────────────────────────────────────

function notifStatusCode(error: string): number {
  if (error === 'NOTIFICATION_NOT_FOUND' || error === 'FOLLOW_UP_NOT_FOUND' || error === 'NOT_FOUND') return 404;
  if (error === 'NOTIFICATION_INVALID_STATUS') return 409;
  if (error === 'FORBIDDEN') return 403;
  return 400;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const notificationRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { notificationService } = opts.services;
  const { userRepo } = opts;

  // POST /tasks/:taskId/notifications — schedule notification for a task
  fastify.post('/tasks/:taskId/notifications', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = ScheduleForTaskBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await notificationService.schedule(
      {
        clientId: body.data.clientId,
        taskId,
        ...(body.data.caseId !== undefined ? { caseId: body.data.caseId } : {}),
        subjectSafe: body.data.subjectSafe,
        bodySafe: body.data.bodySafe,
        scheduledFor: new Date(body.data.scheduledFor),
        ...(body.data.createdByUserId !== undefined ? { createdByUserId: body.data.createdByUserId } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) {
      return reply.code(notifStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.code(201).send({ ok: true, notification: result.value });
  });

  // GET /tasks/:taskId/notifications — list notifications for a task
  fastify.get('/tasks/:taskId/notifications', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const notifications = await notificationService.listForTask(taskId);
    return reply.send({ ok: true, notifications });
  });

  // GET /clients/:clientId/notifications — list notifications for a client
  fastify.get('/clients/:clientId/notifications', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const notifications = await notificationService.listForClient(clientId);
    return reply.send({ ok: true, notifications });
  });

  // GET /notifications/due — list pending notifications due as of now (or ?asOf=)
  fastify.get('/notifications/due', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const { asOf } = request.query as { asOf?: string };
    const asOfDate = asOf !== undefined ? new Date(asOf) : new Date();
    const notifications = await notificationService.listDueAsOf(asOfDate);
    return reply.send({ ok: true, notifications });
  });

  // POST /notifications/:notificationId/schedule — mark PENDING → SCHEDULED
  fastify.post('/notifications/:notificationId/schedule', async (request, reply) => {
    const { notificationId } = request.params as { notificationId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await notificationService.markScheduled(notificationId, ctx.actor.id);
    if (!result.ok) {
      return reply.code(notifStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, notification: result.value });
  });

  // POST /notifications/:notificationId/deliver-dry-run — SCHEDULED → DELIVERED (DRY_RUN)
  fastify.post('/notifications/:notificationId/deliver-dry-run', async (request, reply) => {
    const { notificationId } = request.params as { notificationId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await notificationService.deliverDryRun(notificationId, ctx.actor.id);
    if (!result.ok) {
      return reply.code(notifStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, notification: result.value });
  });

  // POST /notifications/:notificationId/fail — mark as FAILED
  fastify.post('/notifications/:notificationId/fail', async (request, reply) => {
    const { notificationId } = request.params as { notificationId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = FailNotificationBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await notificationService.markFailed(notificationId, body.data.failureReason, ctx.actor.id);
    if (!result.ok) {
      return reply.code(notifStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, notification: result.value });
  });

  // POST /notifications/:notificationId/cancel — cancel notification
  fastify.post('/notifications/:notificationId/cancel', async (request, reply) => {
    const { notificationId } = request.params as { notificationId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await notificationService.cancel(notificationId, ctx.actor.id);
    if (!result.ok) {
      return reply.code(notifStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, notification: result.value });
  });

  // POST /follow-up-reminders/:followUpReminderId/notify — schedule notification for overdue reminder
  fastify.post('/follow-up-reminders/:followUpReminderId/notify', async (request, reply) => {
    const { followUpReminderId } = request.params as { followUpReminderId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = ScheduleForFollowUpBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await notificationService.scheduleForOverdueReminder(
      followUpReminderId,
      body.data.subjectSafe,
      body.data.bodySafe,
      new Date(body.data.scheduledFor),
      ctx.actor.id,
    );
    if (!result.ok) {
      return reply.code(notifStatusCode(result.error)).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.code(201).send({ ok: true, notification: result.value });
  });
};
