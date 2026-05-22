/**
 * Developer-testing routes for consent workflow.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

const CreateVersionBody = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  documentHash: z.string().min(64).max(64),
  effectiveFrom: z.string().datetime(),
  effectiveUntil: z.string().datetime().optional(),
});

const CreateAuthBody = z.object({
  clientId: z.string().min(1),
  consentVersionId: z.string().min(1),
  scopeNames: z.array(z.string().min(1)).min(1),
  jurisdiction: z.string().min(2).max(20),
  signedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  authorizationType: z.enum(['SELF', 'LEGAL_GUARDIAN', 'POWER_OF_ATTORNEY', 'EMPLOYER_SAFETY', 'DECEASED_ESTATE', 'ATTORNEY_CLIENT']).optional(),
});

const RevokeAuthBody = z.object({
  reason: z.string().min(1).max(1000),
  caseId: z.string().optional(),
});

export const consentRoutes: FastifyPluginAsync<{ services: AppServices; userRepo: UserRepository }> = async (fastify, opts) => {
  const { consentService } = opts.services;
  const { userRepo } = opts;

  fastify.post('/consent-versions', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = CreateVersionBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await consentService.createConsentVersion(
      body.data.version,
      body.data.documentHash,
      new Date(body.data.effectiveFrom),
      body.data.effectiveUntil ? new Date(body.data.effectiveUntil) : undefined,
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, consentVersion: result.value });
  });

  fastify.post('/authorizations', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = CreateAuthBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const { expiresAt: expiresAtStr, authorizationType, ...authBase } = body.data;
    const result = await consentService.createAuthorization(
      {
        ...authBase,
        signedAt: new Date(authBase.signedAt),
        ...(expiresAtStr !== undefined ? { expiresAt: new Date(expiresAtStr) } : {}),
        ...(authorizationType !== undefined ? { authorizationType } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.code(201).send({ ok: true, authorization: result.value });
  });

  fastify.get('/clients/:clientId/authorizations', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const authorizations = await consentService.getActiveAuthorizations(clientId);
    return reply.send({ ok: true, authorizations });
  });

  fastify.post('/authorizations/:id/revoke', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = RevokeAuthBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await consentService.revokeAuthorization(id, body.data.reason, ctx.actor.id, body.data.caseId);
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, authorization: result.value });
  });
};
