import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const GeneratePacketBody = z.object({
  clientId: z.string().min(1),
  preparedByUserId: z.string().optional(),
});

const PacketClientBody = z.object({
  clientId: z.string().min(1),
});

const CompleteItemBody = z.object({
  clientId: z.string().min(1),
  operatorNotes: z.string().max(2000).optional(),
});

const BlockItemBody = z.object({
  clientId: z.string().min(1),
  reason: z.string().min(1).max(2000),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export const removalRequestPacketRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { packetService } = opts.services;
  const { userRepo } = opts;

  // POST /tasks/:taskId/removal-request-packets — generate packet
  fastify.post('/tasks/:taskId/removal-request-packets', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = GeneratePacketBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await packetService.generateForTask(
      {
        taskId,
        clientId: body.data.clientId,
        ...(body.data.preparedByUserId !== undefined ? { preparedByUserId: body.data.preparedByUserId } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) {
      const code = result.error === 'NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.code(201).send({ ok: true, packet: result.value });
  });

  // GET /tasks/:taskId/removal-request-packets — list packets for task
  fastify.get('/tasks/:taskId/removal-request-packets', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const packets = await packetService.listForTask(taskId);
    return reply.send({ ok: true, packets });
  });

  // GET /clients/:clientId/removal-request-packets — list packets for client
  fastify.get('/clients/:clientId/removal-request-packets', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const packets = await packetService.listForClient(clientId);
    return reply.send({ ok: true, packets });
  });

  // GET /removal-request-packets/:packetId — get packet with items
  fastify.get('/removal-request-packets/:packetId', async (request, reply) => {
    const { packetId } = request.params as { packetId: string };
    const body = PacketClientBody.safeParse(request.query);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await packetService.getById(packetId, body.data.clientId);
    if (!result.ok) {
      const code = result.error === 'PACKET_NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, packet: result.value });
  });

  // POST /removal-request-packets/:packetId/ready — mark packet READY
  fastify.post('/removal-request-packets/:packetId/ready', async (request, reply) => {
    const { packetId } = request.params as { packetId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = PacketClientBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await packetService.markReady(packetId, body.data.clientId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'PACKET_NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, packet: result.value });
  });

  // POST /removal-request-packets/:packetId/items/:itemId/complete
  fastify.post('/removal-request-packets/:packetId/items/:itemId/complete', async (request, reply) => {
    const { packetId, itemId } = request.params as { packetId: string; itemId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = CompleteItemBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await packetService.completeItem(
      packetId,
      itemId,
      { ...(body.data.operatorNotes !== undefined ? { operatorNotes: body.data.operatorNotes } : {}) },
      body.data.clientId,
      ctx.actor.id,
    );
    if (!result.ok) {
      const code = result.error === 'PACKET_NOT_FOUND' || result.error === 'NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, packet: result.value });
  });

  // POST /removal-request-packets/:packetId/items/:itemId/block
  fastify.post('/removal-request-packets/:packetId/items/:itemId/block', async (request, reply) => {
    const { packetId, itemId } = request.params as { packetId: string; itemId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = BlockItemBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await packetService.blockItem(
      packetId,
      itemId,
      { reason: body.data.reason },
      body.data.clientId,
      ctx.actor.id,
    );
    if (!result.ok) {
      const code = result.error === 'PACKET_NOT_FOUND' || result.error === 'NOT_FOUND' ? 404 : result.error === 'FORBIDDEN' ? 403 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, packet: result.value });
  });
};
