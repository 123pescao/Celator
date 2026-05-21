/**
 * Developer-testing routes for review packets and operator approvals.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';

const CreatePacketBody = z.object({
  taskId: z.string().min(1),
  authorizationId: z.string().min(1),
  clientId: z.string().min(1),
  redactedPreview: z.string().min(1).max(2000),
  evidenceIds: z.array(z.string()).optional(),
  preparedByUserId: z.string().optional(),
  expiresInDays: z.number().int().min(1).max(30).optional(),
});

const RecordDecisionBody = z.object({
  operatorId: z.string().min(1),
  operatorOrganizationId: z.string().min(1),
  clientId: z.string().min(1),
  decision: z.enum(['APPROVED', 'REJECTED', 'ESCALATED', 'NEEDS_MORE_EVIDENCE']),
  mfaFreshAt: z.string().datetime(),
  sessionApprovalCount: z.number().int().min(0),
  reviewStartedAt: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
});

export const reviewPacketRoutes: FastifyPluginAsync<{ services: AppServices }> = async (fastify, opts) => {
  const { reviewPacketService, operatorApprovalService } = opts.services;

  fastify.post('/review-packets', async (request, reply) => {
    const actorId = (request.headers['x-dev-actor-id'] as string) ?? 'dev-actor';
    const body = CreatePacketBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, evidenceIds, preparedByUserId, expiresInDays, ...packetBase } = body.data;
    const result = await reviewPacketService.create(
      {
        ...packetBase,
        ...(evidenceIds !== undefined ? { evidenceIds } : {}),
        ...(preparedByUserId !== undefined ? { preparedByUserId } : {}),
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      },
      clientId,
      actorId,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, ...result.value });
  });

  fastify.get('/tasks/:taskId/review-packet', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const result = await reviewPacketService.getActivePacket(taskId);
    if (!result.ok) return reply.code(404).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, ...result.value });
  });

  fastify.post('/approval-requests/:id/decision', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = RecordDecisionBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, reviewStartedAt: reviewStartedAtStr, notes, ...decisionBase } = body.data;
    const result = await operatorApprovalService.recordDecision(
      {
        approvalRequestId: id,
        ...decisionBase,
        mfaFreshAt: new Date(decisionBase.mfaFreshAt),
        ...(reviewStartedAtStr !== undefined ? { reviewStartedAt: new Date(reviewStartedAtStr) } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
      clientId,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, approval: result.value });
  });
};
