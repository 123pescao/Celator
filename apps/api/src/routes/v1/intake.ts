import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const CreateSessionBody = z.object({
  orgId: z.string().min(1),
  requestedActionTypes: z.array(z.string()).optional(),
  requestedSourceTypes: z.array(z.string()).optional(),
  safeContactRef: z.string().max(500).optional(),
  expiresAt: z.string().datetime().optional(),
});

const LinkClientBody = z.object({
  clientId: z.string().min(1),
});

const UpdateScopeBody = z.object({
  requestedActionTypes: z.array(z.string()).optional(),
  requestedSourceTypes: z.array(z.string()).optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export const intakeRoutes: FastifyPluginAsync<{
  services: AppServices;
  userRepo: UserRepository;
}> = async (fastify, opts) => {
  const { intakeService } = opts.services;
  const { userRepo } = opts;

  // POST /intake/sessions — create intake session
  fastify.post('/intake/sessions', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = CreateSessionBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await intakeService.createSession(
      {
        orgId: body.data.orgId,
        ...(body.data.requestedActionTypes !== undefined ? { requestedActionTypes: body.data.requestedActionTypes } : {}),
        ...(body.data.requestedSourceTypes !== undefined ? { requestedSourceTypes: body.data.requestedSourceTypes } : {}),
        ...(body.data.safeContactRef !== undefined ? { safeContactRef: body.data.safeContactRef } : {}),
        ...(body.data.expiresAt !== undefined ? { expiresAt: new Date(body.data.expiresAt) } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.code(201).send({ ok: true, session: result.value });
  });

  // GET /intake/sessions/:sessionId — get session
  fastify.get('/intake/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await intakeService.getSafeSession(sessionId);
    if (!result.ok) {
      const code = result.error === 'INTAKE_SESSION_NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, session: result.value });
  });

  // PATCH /intake/sessions/:sessionId/scope — update requested scope
  fastify.patch('/intake/sessions/:sessionId/scope', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = UpdateScopeBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await intakeService.updateRequestedScope(
      sessionId,
      {
        ...(body.data.requestedActionTypes !== undefined ? { requestedActionTypes: body.data.requestedActionTypes } : {}),
        ...(body.data.requestedSourceTypes !== undefined ? { requestedSourceTypes: body.data.requestedSourceTypes } : {}),
      },
      ctx.actor.id,
    );
    if (!result.ok) {
      const code = result.error === 'INTAKE_SESSION_NOT_FOUND' ? 404 : result.error === 'INTAKE_INVALID_STATUS' ? 409 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, session: result.value });
  });

  // POST /intake/sessions/:sessionId/link-client — link client to session
  fastify.post('/intake/sessions/:sessionId/link-client', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const body = LinkClientBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    const result = await intakeService.linkClient(sessionId, body.data.clientId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'INTAKE_SESSION_NOT_FOUND' ? 404 : result.error === 'INTAKE_INVALID_STATUS' ? 409 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, session: result.value });
  });

  // POST /intake/sessions/:sessionId/mark-consent-pending
  fastify.post('/intake/sessions/:sessionId/mark-consent-pending', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await intakeService.markConsentPending(sessionId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'INTAKE_SESSION_NOT_FOUND' ? 404 : result.error === 'INTAKE_INVALID_STATUS' ? 409 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, session: result.value });
  });

  // POST /intake/sessions/:sessionId/mark-identity-pending
  fastify.post('/intake/sessions/:sessionId/mark-identity-pending', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await intakeService.markIdentityPending(sessionId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'INTAKE_SESSION_NOT_FOUND' ? 404 : result.error === 'INTAKE_INVALID_STATUS' ? 409 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, session: result.value });
  });

  // POST /intake/sessions/:sessionId/mark-ready-for-review
  fastify.post('/intake/sessions/:sessionId/mark-ready-for-review', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await intakeService.markReadyForReview(sessionId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'INTAKE_SESSION_NOT_FOUND' ? 404 : result.error === 'INTAKE_INVALID_STATUS' ? 409 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, session: result.value });
  });

  // POST /intake/sessions/:sessionId/complete
  fastify.post('/intake/sessions/:sessionId/complete', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await intakeService.completeSession(sessionId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'INTAKE_SESSION_NOT_FOUND' ? 404 : result.error === 'INTAKE_INVALID_STATUS' ? 409 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, session: result.value });
  });

  // POST /intake/sessions/:sessionId/cancel
  fastify.post('/intake/sessions/:sessionId/cancel', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await intakeService.cancelSession(sessionId, ctx.actor.id);
    if (!result.ok) {
      const code = result.error === 'INTAKE_SESSION_NOT_FOUND' ? 404 : result.error === 'INTAKE_INVALID_STATUS' ? 409 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, session: result.value });
  });

  // GET /organizations/:orgId/intake-sessions — list sessions for org
  fastify.get('/organizations/:orgId/intake-sessions', async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireDevActor(request, reply, userRepo, orgId);
    if (!ctx) return;
    const sessions = await intakeService.listSessionsForOrg(orgId);
    return reply.send({ ok: true, sessions });
  });

  // GET /clients/:clientId/portal-summary — client portal summary
  fastify.get('/clients/:clientId/portal-summary', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;
    const result = await intakeService.getClientPortalSummary(clientId);
    if (!result.ok) {
      const code = result.error === 'CLIENT_NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: result.error, message: result.message });
    }
    // Strip any internal fields — summary is safe by construction
    return reply.send({ ok: true, summary: result.value });
  });
};
