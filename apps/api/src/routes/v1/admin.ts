/**
 * Developer-testing routes for Organization and User management.
 * NOT production auth — uses X-Dev-Actor-Id header.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppRepos } from '../../services-factory.js';

const CreateOrgBody = z.object({
  name: z.string().min(1).max(200),
});

const CreateUserBody = z.object({
  organizationId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1).max(200),
  role: z.enum(['ADMIN', 'OPERATOR', 'REVIEWER', 'AUDITOR']).optional(),
});

export const adminRoutes: FastifyPluginAsync<{ repos: AppRepos }> = async (fastify, opts) => {
  const { orgRepo, userRepo } = opts.repos;

  fastify.post('/organizations', async (request, reply) => {
    const body = CreateOrgBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    try {
      const org = await orgRepo.create({ name: body.data.name });
      return reply.code(201).send({ ok: true, organization: org });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, error: 'CREATE_FAILED', message: msg });
    }
  });

  fastify.get('/organizations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const org = await orgRepo.findById(id);
    if (!org) return reply.code(404).send({ ok: false, error: 'NOT_FOUND', message: `Organization ${id} not found` });
    return reply.send({ ok: true, organization: org });
  });

  fastify.post('/users', async (request, reply) => {
    const body = CreateUserBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }
    try {
      const user = await userRepo.create({
        organization: { connect: { id: body.data.organizationId } },
        email: body.data.email,
        displayName: body.data.displayName,
      });
      return reply.code(201).send({ ok: true, user });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Unique constraint on email
      if (msg.includes('Unique constraint') || msg.includes('unique')) {
        return reply.code(409).send({ ok: false, error: 'EMAIL_ALREADY_EXISTS', message: 'A user with this email already exists' });
      }
      return reply.code(400).send({ ok: false, error: 'CREATE_FAILED', message: msg });
    }
  });

  fastify.get('/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await userRepo.findById(id);
    if (!user) return reply.code(404).send({ ok: false, error: 'NOT_FOUND', message: `User ${id} not found` });
    return reply.send({ ok: true, user });
  });
};
