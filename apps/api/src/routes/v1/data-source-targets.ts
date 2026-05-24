/**
 * Data Source Target registry routes.
 * Targets describe data brokers, search engines, and platforms for future removal workflows.
 * No plaintext PII involved in these routes.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

const SOURCE_TYPES = ['DATA_BROKER', 'SEARCH_ENGINE', 'SOCIAL_PLATFORM', 'PUBLIC_RECORD_SITE', 'PEOPLE_SEARCH', 'BREACH_INDEX', 'OTHER'] as const;

const ACTION_TYPES = [
  'OPT_OUT', 'DELETE_PERSONAL_DATA', 'DO_NOT_SELL', 'DO_NOT_SHARE',
  'LIMIT_SENSITIVE_DATA', 'CORRECT_DATA', 'REMOVE_FROM_SEARCH',
  'REFRESH_OUTDATED_CONTENT', 'DELETE_ACCOUNT', 'DEACTIVATE_ACCOUNT',
  'REMOVE_IMAGE', 'SUPPRESS_PROFILE', 'REPORT_DANGEROUS_EXPOSURE',
  'ESCALATE_NON_RESPONSE', 'LEGAL_ESCALATION',
] as const;

const CreateTargetBody = z.object({
  sourceName: z.string().min(1).max(200),
  sourceType: z.enum(SOURCE_TYPES),
  baseDomain: z.string().max(253).optional(),
  jurisdiction: z.string().max(100).optional(),
  supportedActionTypes: z.array(z.enum(ACTION_TYPES)).optional(),
  requiresLogin: z.boolean().optional(),
  requiresCaptcha: z.boolean().optional(),
  manualOnly: z.boolean().optional(),
  piiRequiredFields: z.array(z.string().min(1)).optional(),
  notes: z.string().max(2000).optional(),
  isActive: z.boolean().optional(),
});

const UpdateTargetBody = z.object({
  isActive: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
  supportedActionTypes: z.array(z.enum(ACTION_TYPES)).optional(),
  piiRequiredFields: z.array(z.string().min(1)).optional(),
});

export const dataSourceTargetRoutes: FastifyPluginAsync<{ services: AppServices; userRepo: UserRepository }> = async (fastify, opts) => {
  const { dataSourceTargetService } = opts.services;
  const { userRepo } = opts;

  fastify.post('/data-source-targets', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = CreateTargetBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }

    const result = await dataSourceTargetService.create(body.data);
    if (!result.ok) {
      const status = result.error === 'VALIDATION_ERROR' ? 409 : 500;
      return reply.code(status).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.code(201).send({ ok: true, target: result.value });
  });

  fastify.get('/data-source-targets', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const sourceType = query['sourceType'] as (typeof SOURCE_TYPES)[number] | undefined;
    const activeOnly = query['activeOnly'] !== 'false'; // default true

    const targets = activeOnly
      ? await dataSourceTargetService.listActive(sourceType)
      : await dataSourceTargetService.list();

    return reply.send({ ok: true, targets });
  });

  fastify.get('/data-source-targets/by-name/:sourceName', async (request, reply) => {
    const { sourceName } = request.params as { sourceName: string };
    const result = await dataSourceTargetService.getByName(decodeURIComponent(sourceName));
    if (!result.ok) return reply.code(404).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, target: result.value });
  });

  fastify.get('/data-source-targets/:targetId', async (request, reply) => {
    const { targetId } = request.params as { targetId: string };
    const result = await dataSourceTargetService.getById(targetId);
    if (!result.ok) return reply.code(404).send({ ok: false, error: result.error, message: result.message });
    return reply.send({ ok: true, target: result.value });
  });

  fastify.patch('/data-source-targets/:targetId', async (request, reply) => {
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const { targetId } = request.params as { targetId: string };
    const body = UpdateTargetBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }

    const result = await dataSourceTargetService.update(targetId, body.data);
    if (!result.ok) {
      const status = result.error === 'DATA_SOURCE_TARGET_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({ ok: false, error: result.error, message: result.message });
    }
    return reply.send({ ok: true, target: result.value });
  });
};
