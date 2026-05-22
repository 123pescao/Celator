/**
 * Developer-testing routes for Client management.
 * NOT production auth — uses X-Dev-Actor-Id header.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

const CreateClientBody = z.object({
  organizationId: z.string().min(1),
  displayName: z.string().min(1).max(200),
});

const UpdateStatusBody = z.object({
  status: z.enum(['PENDING_IDENTITY_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DISPUTED', 'CLOSED']),
});

const AttestBody = z.object({
  operatorAttestation: z.string().min(1).max(2000),
});

const RejectVerificationBody = z.object({
  rejectionReason: z.string().min(1).max(2000),
});

export const clientRoutes: FastifyPluginAsync<{ services: AppServices; userRepo: UserRepository }> = async (fastify, opts) => {
  const { clientService, civService, audit } = opts.services;
  const { userRepo } = opts;

  fastify.post('/clients', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = CreateClientBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await clientService.create(body.data, ctx.actor.id);
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
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = UpdateStatusBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await clientService.updateStatus(id, body.data.status, ctx.actor.id);
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, client: result.value });
  });

  // Identity verification
  fastify.post('/clients/:clientId/identity-verification', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await civService.createRecord(clientId, ctx.actor.id);
    if (!result.ok) return reply.code(result.error === 'CLIENT_NOT_FOUND' ? 404 : 400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, verification: result.value });
  });

  fastify.get('/clients/:clientId/identity-verification', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const record = await civService.getLatest(clientId);
    if (!record) return reply.code(404).send({ ok: false, error: 'NOT_FOUND', message: `No verification record for client ${clientId}` });
    return reply.send({ ok: true, verification: record });
  });

  fastify.post('/identity-verifications/:verificationId/attest', async (request, reply) => {
    const { verificationId } = request.params as { verificationId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = AttestBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await civService.recordOperatorAttestation(
      verificationId,
      body.data.operatorAttestation,
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(result.error === 'NOT_FOUND' ? 404 : 400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, verification: result.value });
  });

  fastify.post('/identity-verifications/:verificationId/complete', async (request, reply) => {
    const { verificationId } = request.params as { verificationId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await civService.completeVerification(verificationId, ctx.actor.id);
    if (!result.ok) return reply.code(result.error === 'NOT_FOUND' ? 404 : 400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, verification: result.value });
  });

  fastify.post('/identity-verifications/:verificationId/reject', async (request, reply) => {
    const { verificationId } = request.params as { verificationId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = RejectVerificationBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await civService.rejectVerification(verificationId, body.data.rejectionReason, ctx.actor.id);
    if (!result.ok) return reply.code(result.error === 'NOT_FOUND' ? 404 : 400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, verification: result.value });
  });

  // Audit logs for a client
  fastify.get('/clients/:clientId/audit-logs', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const limitParam = (request.query as Record<string, string>)['limit'];
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 100, 500) : 100;
    const logs = await audit.listByClient(clientId, limit);
    return reply.send({ ok: true, auditLogs: logs });
  });
};
