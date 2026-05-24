/**
 * Removal request draft generation route.
 *
 * Produces a reviewable draft for a client + data source target pair.
 * Response shows vault field presence and redacted display values only.
 * Never returns plaintext PII or ciphertext.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../../services-factory.js';
import type { UserRepository } from '@celator/db';
import { requireDevActor } from '../../auth/index.js';

const BuildDraftBody = z.object({
  dataSourceTargetId: z.string().min(1),
});

export const removalDraftRoutes: FastifyPluginAsync<{ services: AppServices; userRepo: UserRepository }> = async (fastify, opts) => {
  const { removalDraftService } = opts.services;
  const { userRepo } = opts;

  fastify.post('/clients/:clientId/removal-drafts', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const ctx = await requireDevActor(request, reply, userRepo);
    if (!ctx) return;

    const body = BuildDraftBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }

    const result = await removalDraftService.buildDraft({
      clientId,
      dataSourceTargetId: body.data.dataSourceTargetId,
    });

    if (!result.ok) {
      const status = result.error === 'DATA_SOURCE_TARGET_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({ ok: false, error: result.error, message: result.message });
    }

    // Explicitly shape the response — no ciphertext, no plaintext fields
    const draft = result.value;
    return reply.code(200).send({
      ok: true,
      draft: {
        targetId: draft.targetId,
        targetName: draft.targetName,
        sourceType: draft.sourceType,
        supportedActionTypes: draft.supportedActionTypes,
        requiredFields: draft.requiredFields,
        vaultFieldStatuses: draft.vaultFieldStatuses.map((s) => ({
          fieldType: s.fieldType,
          isPresent: s.isPresent,
          redactedDisplay: s.redactedDisplay,
          recordId: s.recordId,
        })),
        missingFields: draft.missingFields,
        isReadyForReview: draft.isReadyForReview,
        draftSummary: draft.draftSummary,
      },
    });
  });
};
