/**
 * Identity Vault intake and access routes — dev-testing only.
 * Requires a valid actor via X-Dev-Actor-Id header.
 * Never returns plaintext. All responses use redactedDisplay.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

const StoreVaultRecordBody = z.object({
  fieldType: z.enum(['EMAIL', 'PHONE', 'ADDRESS', 'FULL_NAME', 'DOB', 'USERNAME', 'GOVERNMENT_ID', 'URL', 'OTHER']),
  value: z.string().min(1).max(4000),
  purposeCode: z.enum([
    'PURPOSE_OPERATOR_REVIEW_PACKET',
    'PURPOSE_FORM_FILL',
    'PURPOSE_REPORT_GENERATION',
    'PURPOSE_CLIENT_EXPORT',
    'PURPOSE_DEK_ROTATION',
  ]).optional().default('PURPOSE_OPERATOR_REVIEW_PACKET'),
});

const LogVaultAccessBody = z.object({
  purposeCode: z.enum([
    'PURPOSE_OPERATOR_REVIEW_PACKET',
    'PURPOSE_FORM_FILL',
    'PURPOSE_REPORT_GENERATION',
    'PURPOSE_CLIENT_EXPORT',
    'PURPOSE_DEK_ROTATION',
  ]),
  reason: z.string().min(1).max(500),
});

export const vaultRoutes: FastifyPluginAsync<{ services: AppServices; userRepo: UserRepository }> = async (fastify, opts) => {
  const { vaultService } = opts.services;
  const { userRepo } = opts;

  // Store a vault record for a client
  fastify.post('/clients/:clientId/vault-records', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = StoreVaultRecordBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }

    const result = await vaultService.store({
      clientId,
      fieldType: body.data.fieldType,
      plaintext: body.data.value,
      purposeCode: body.data.purposeCode,
      actorId: ctx.actor.id,
      actorType: 'OPERATOR',
    });

    if (!result.ok) {
      const status = result.error === 'VAULT_FIELD_TYPE_INVALID' || result.error === 'VAULT_PURPOSE_DENIED' ? 400 : 500;
      return reply.code(status).send({ ok: false, error: result.error, message: result.message });
    }

    return reply.code(201).send({
      ok: true,
      record: {
        id: result.value.recordId,
        fieldType: result.value.fieldType,
        redactedDisplay: result.value.redactedDisplay,
        createdAt: result.value.createdAt,
      },
    });
  });

  // List vault record metadata for a client (no plaintext, no ciphertext)
  fastify.get('/clients/:clientId/vault-records', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const metadata = await vaultService.listMetadata(clientId);
    return reply.send({
      ok: true,
      records: metadata.map((r) => ({
        id: r.id,
        fieldType: r.fieldType,
        redactedDisplay: r.redactedDisplay,
        isCryptoShredded: r.isCryptoShredded,
        createdAt: r.createdAt,
      })),
    });
  });

  // Log an access to a vault record — returns redactedDisplay only, never plaintext
  fastify.post('/vault-records/:recordId/access', async (request, reply) => {
    const { recordId } = request.params as { recordId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = LogVaultAccessBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }

    const result = await vaultService.logAccess(recordId, body.data.purposeCode, ctx.actor.id, 'OPERATOR');

    if (!result.ok) {
      const status = result.error === 'VAULT_RECORD_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({ ok: false, error: result.error, message: result.message });
    }

    return reply.send({
      ok: true,
      access: {
        recordId: result.value.recordId,
        fieldType: result.value.fieldType,
        redactedDisplay: result.value.redactedDisplay,
        purposeCode: result.value.purposeCode,
        accessedAt: result.value.accessedAt,
      },
    });
  });
};
