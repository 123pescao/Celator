/**
 * Developer-testing routes for Client management.
 * NOT production auth — uses X-Dev-Actor-Id header.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';

const CreateClientBody = z.object({
  organizationId: z.string().min(1),
  displayName: z.string().min(1).max(200),
});

const UpdateStatusBody = z.object({
  status: z.enum(['PENDING_IDENTITY_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DISPUTED', 'CLOSED']),
});

export const clientRoutes: FastifyPluginAsync<{ services: AppServices }> = async (fastify, opts) => {
  const { clientService } = opts.services;

  fastify.post('/clients', async (request, reply) => {
    const actorId = (request.headers['x-dev-actor-id'] as string) ?? 'dev-actor';
    const body = CreateClientBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await clientService.create(body.data, actorId);
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, client: result.value });
  });

  fastify.get('/clients/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await clientService.getById(id);
    if (!result.ok) return reply.code(404).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, client: result.value });
  });

  fastify.get('/organizations/:orgId/clients', async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const clients = await clientService.listByOrg(orgId);
    return reply.send({ ok: true, clients });
  });

  fastify.patch('/clients/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const actorId = (request.headers['x-dev-actor-id'] as string) ?? 'dev-actor';
    const body = UpdateStatusBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await clientService.updateStatus(id, body.data.status, actorId);
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, client: result.value });
  });
};
