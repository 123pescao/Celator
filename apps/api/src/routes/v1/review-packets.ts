/**
 * Developer-testing routes for review packets and operator approvals.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

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
  clientId: z.string().min(1),
  decision: z.enum(['APPROVED', 'REJECTED', 'ESCALATED', 'NEEDS_MORE_EVIDENCE']),
  mfaFreshAt: z.string().datetime(),
  sessionApprovalCount: z.number().int().min(0),
  reviewStartedAt: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
});

export const reviewPacketRoutes: FastifyPluginAsync<{ services: AppServices; userRepo: UserRepository }> = async (fastify, opts) => {
  const { reviewPacketService, operatorApprovalService } = opts.services;
  const { userRepo } = opts;

  fastify.post('/review-packets', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
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
      ctx.actor.id,
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
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = RecordDecisionBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, reviewStartedAt: reviewStartedAtStr, notes, ...decisionBase } = body.data;
    const result = await operatorApprovalService.recordDecision(
      {
        approvalRequestId: id,
        operatorId: ctx.actor.id,
        operatorOrganizationId: ctx.actor.organizationId,
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

  // Approve/reject shorthands — convenience wrappers over the decision endpoint
  const ApproveBody = z.object({
    clientId: z.string().min(1),
    mfaFreshAt: z.string().datetime(),
    sessionApprovalCount: z.number().int().min(0).default(0),
    notes: z.string().max(2000).optional(),
  });

  const RejectBody = z.object({
    clientId: z.string().min(1),
    mfaFreshAt: z.string().datetime(),
    sessionApprovalCount: z.number().int().min(0).default(0),
    notes: z.string().max(2000).optional(),
  });

  fastify.post('/approval-requests/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = ApproveBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, notes, ...base } = body.data;
    const result = await operatorApprovalService.recordDecision(
      {
        approvalRequestId: id,
        decision: 'APPROVED',
        mfaFreshAt: new Date(base.mfaFreshAt),
        operatorId: ctx.actor.id,
        operatorOrganizationId: ctx.actor.organizationId,
        sessionApprovalCount: base.sessionApprovalCount,
        ...(notes !== undefined ? { notes } : {}),
      },
      clientId,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, approval: result.value });
  });

  fastify.post('/approval-requests/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = RejectBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { clientId, notes, ...base } = body.data;
    const result = await operatorApprovalService.recordDecision(
      {
        approvalRequestId: id,
        decision: 'REJECTED',
        mfaFreshAt: new Date(base.mfaFreshAt),
        operatorId: ctx.actor.id,
        operatorOrganizationId: ctx.actor.organizationId,
        sessionApprovalCount: base.sessionApprovalCount,
        ...(notes !== undefined ? { notes } : {}),
      },
      clientId,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, approval: result.value });
  });
};
