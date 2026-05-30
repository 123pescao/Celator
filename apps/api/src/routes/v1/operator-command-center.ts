import type { FastifyPluginAsync } from 'fastify';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

// ─── Routes ───────────────────────────────────────────────────────────────────

export const operatorCommandCenterRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { operatorCommandCenterService } = opts.services;
  const { userRepo } = opts;

  // GET /operator/dashboard — aggregate overview
  fastify.get('/operator/dashboard', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const q = request.query as Record<string, string>;
    const orgId = q['orgId'];
    const clientId = q['clientId'];
    const overview = await operatorCommandCenterService.getDashboardOverview({
      ...(orgId ? { orgId } : {}),
      ...(clientId ? { clientId } : {}),
    });
    return reply.send({ ok: true, overview });
  });

  // GET /operator/work-queue — tasks needing attention
  fastify.get('/operator/work-queue', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const q = request.query as Record<string, string>;
    const orgId = q['orgId'];
    const clientId = q['clientId'];
    const statusFilter = q['statusFilter'];
    const limitRaw = q['limit'];
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const items = await operatorCommandCenterService.listWorkQueue({
      ...(orgId ? { orgId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(statusFilter ? { statusFilter } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return reply.send({ ok: true, items });
  });

  // GET /operator/follow-ups/due — due follow-ups (clientId required)
  fastify.get('/operator/follow-ups/due', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const q = request.query as Record<string, string>;
    const clientId = q['clientId'];
    const asOfRaw = q['asOf'];
    const limitRaw = q['limit'];
    if (!clientId) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', message: 'clientId is required' });
    }
    const asOf = asOfRaw ? new Date(asOfRaw) : undefined;
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const followUps = await operatorCommandCenterService.listDueFollowUps({
      clientId,
      ...(asOf !== undefined ? { asOf } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return reply.send({ ok: true, followUps });
  });

  // GET /operator/workflows/blocked — blocked workflow runs
  fastify.get('/operator/workflows/blocked', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const q = request.query as Record<string, string>;
    const clientId = q['clientId'];
    const limitRaw = q['limit'];
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const runs = await operatorCommandCenterService.listBlockedWorkflows({
      ...(clientId ? { clientId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return reply.send({ ok: true, runs });
  });

  // GET /operator/packets/ready — ready packets
  fastify.get('/operator/packets/ready', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const q = request.query as Record<string, string>;
    const clientId = q['clientId'];
    const limitRaw = q['limit'];
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const packets = await operatorCommandCenterService.listReadyPackets({
      ...(clientId ? { clientId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return reply.send({ ok: true, packets });
  });

  // GET /operator/clients/:clientId/progress — client-level progress
  fastify.get('/operator/clients/:clientId/progress', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await operatorCommandCenterService.getClientProgress(clientId);
    if (!result.ok) {
      const code = result.error === 'CLIENT_NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, progress: result.value });
  });

  // GET /operator/cases/:caseId/progress?clientId= — case-level progress
  fastify.get('/operator/cases/:caseId/progress', async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const q = request.query as Record<string, string>;
    const clientId = q['clientId'];
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    if (!clientId) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', message: 'clientId is required' });
    }
    const result = await operatorCommandCenterService.getCaseProgress(caseId, clientId);
    if (!result.ok) {
      const code = result.error === 'NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, progress: result.value });
  });

  // GET /operator/tasks/:taskId/progress?clientId= — task-level progress
  fastify.get('/operator/tasks/:taskId/progress', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const q = request.query as Record<string, string>;
    const clientId = q['clientId'];
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    if (!clientId) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', message: 'clientId is required' });
    }
    const result = await operatorCommandCenterService.getTaskProgress(taskId, clientId);
    if (!result.ok) {
      const code = result.error === 'NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, progress: result.value });
  });

  // GET /operator/activity — recent timeline activity
  fastify.get('/operator/activity', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const q = request.query as Record<string, string>;
    const clientId = q['clientId'];
    const caseId = q['caseId'];
    const limitRaw = q['limit'];
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const events = await operatorCommandCenterService.getRecentActivity({
      ...(clientId ? { clientId } : {}),
      ...(caseId ? { caseId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return reply.send({ ok: true, events });
  });
};
