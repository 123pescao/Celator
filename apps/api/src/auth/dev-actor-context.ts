/**
 * Dev actor context — NOT production auth.
 * Reads x-dev-actor-id header, resolves the user from DB, and enforces basic
 * constraints (active, optionally org-scoped). Returns 401/403 on failure.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { User } from '@celator/db';
import type { UserRepository } from '@celator/db';

export interface DevActorContext {
  actor: User;
}

export async function resolveDevActor(
  request: FastifyRequest,
  userRepo: UserRepository,
): Promise<DevActorContext | null> {
  const actorId = request.headers['x-dev-actor-id'] as string | undefined;
  if (!actorId) return null;
  const user = await userRepo.findById(actorId);
  if (!user || !user.isActive) return null;
  return { actor: user };
}

/**
 * Resolve and validate the actor from the x-dev-actor-id request header.
 * Sends 401/403 and returns null when validation fails — the caller must
 * return immediately on null to avoid sending a second reply.
 *
 * @param orgId - When provided, enforces that actor.organizationId === orgId.
 */
export async function requireDevActor(
  request: FastifyRequest,
  reply: FastifyReply,
  userRepo: UserRepository,
  orgId?: string,
): Promise<DevActorContext | null> {
  const actorId = request.headers['x-dev-actor-id'] as string | undefined;

  if (!actorId) {
    await reply.code(401).send({ ok: false, error: 'ACTOR_REQUIRED' });
    return null;
  }

  const user = await userRepo.findById(actorId);

  if (!user) {
    await reply.code(401).send({ ok: false, error: 'ACTOR_INVALID' });
    return null;
  }

  if (!user.isActive) {
    await reply.code(403).send({ ok: false, error: 'ACTOR_INACTIVE' });
    return null;
  }

  if (orgId !== undefined && user.organizationId !== orgId) {
    await reply.code(403).send({ ok: false, error: 'ACTOR_ORG_MISMATCH' });
    return null;
  }

  return { actor: user };
}
