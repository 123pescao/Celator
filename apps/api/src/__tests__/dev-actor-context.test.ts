import { describe, it, expect, vi } from 'vitest';
import { requireDevActor, resolveDevActor } from '../auth/dev-actor-context.js';
import type { UserRepository } from '@celator/db';
import type { FastifyRequest, FastifyReply } from 'fastify';

const ACTIVE_USER = {
  id: 'user_001',
  organizationId: 'org_001',
  email: 'op@example.com',
  displayName: 'Operator One',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const INACTIVE_USER = { ...ACTIVE_USER, id: 'user_002', isActive: false };

function makeRepo(user: typeof ACTIVE_USER | null = ACTIVE_USER): UserRepository {
  return {
    findById: vi.fn().mockResolvedValue(user),
  } as unknown as UserRepository;
}

function makeRequest(actorId?: string): FastifyRequest {
  return {
    headers: actorId ? { 'x-dev-actor-id': actorId } : {},
  } as unknown as FastifyRequest;
}

function makeReply(): { code: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; _code: number; _body: unknown } {
  const reply = {
    _code: 200,
    _body: undefined as unknown,
    code: vi.fn(),
    send: vi.fn(),
  };
  reply.code.mockReturnValue(reply);
  reply.send.mockImplementation((body: unknown) => {
    reply._body = body;
    return reply;
  });
  return reply;
}

describe('requireDevActor', () => {
  it('returns 401 ACTOR_REQUIRED when header is missing', async () => {
    const repo = makeRepo();
    const req = makeRequest(); // no header
    const reply = makeReply();

    const ctx = await requireDevActor(req, reply as unknown as FastifyReply, repo);

    expect(ctx).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply._body).toMatchObject({ ok: false, error: 'ACTOR_REQUIRED' });
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('returns 401 ACTOR_INVALID when user does not exist in DB', async () => {
    const repo = makeRepo(null);
    const req = makeRequest('missing_user');
    const reply = makeReply();

    const ctx = await requireDevActor(req, reply as unknown as FastifyReply, repo);

    expect(ctx).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply._body).toMatchObject({ ok: false, error: 'ACTOR_INVALID' });
  });

  it('returns 403 ACTOR_INACTIVE when user is inactive', async () => {
    const repo = makeRepo(INACTIVE_USER);
    const req = makeRequest('user_002');
    const reply = makeReply();

    const ctx = await requireDevActor(req, reply as unknown as FastifyReply, repo);

    expect(ctx).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply._body).toMatchObject({ ok: false, error: 'ACTOR_INACTIVE' });
  });

  it('returns 403 ACTOR_ORG_MISMATCH when actor org does not match required org', async () => {
    const repo = makeRepo(ACTIVE_USER); // org_001
    const req = makeRequest('user_001');
    const reply = makeReply();

    const ctx = await requireDevActor(req, reply as unknown as FastifyReply, repo, 'org_999');

    expect(ctx).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply._body).toMatchObject({ ok: false, error: 'ACTOR_ORG_MISMATCH' });
  });

  it('returns actor context for a valid active user', async () => {
    const repo = makeRepo(ACTIVE_USER);
    const req = makeRequest('user_001');
    const reply = makeReply();

    const ctx = await requireDevActor(req, reply as unknown as FastifyReply, repo);

    expect(ctx).not.toBeNull();
    expect(ctx?.actor.id).toBe('user_001');
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('returns actor context when orgId matches', async () => {
    const repo = makeRepo(ACTIVE_USER); // org_001
    const req = makeRequest('user_001');
    const reply = makeReply();

    const ctx = await requireDevActor(req, reply as unknown as FastifyReply, repo, 'org_001');

    expect(ctx).not.toBeNull();
    expect(ctx?.actor.organizationId).toBe('org_001');
  });

  it('does not enforce org constraint when orgId is undefined', async () => {
    const repo = makeRepo(ACTIVE_USER);
    const req = makeRequest('user_001');
    const reply = makeReply();

    const ctx = await requireDevActor(req, reply as unknown as FastifyReply, repo, undefined);

    expect(ctx).not.toBeNull();
  });
});

describe('resolveDevActor', () => {
  it('returns null when header is missing', async () => {
    const repo = makeRepo();
    const req = makeRequest();

    const ctx = await resolveDevActor(req, repo);
    expect(ctx).toBeNull();
  });

  it('returns null when user not found', async () => {
    const repo = makeRepo(null);
    const req = makeRequest('unknown');

    const ctx = await resolveDevActor(req, repo);
    expect(ctx).toBeNull();
  });

  it('returns null when user is inactive', async () => {
    const repo = makeRepo(INACTIVE_USER);
    const req = makeRequest('user_002');

    const ctx = await resolveDevActor(req, repo);
    expect(ctx).toBeNull();
  });

  it('returns actor context for valid active user', async () => {
    const repo = makeRepo(ACTIVE_USER);
    const req = makeRequest('user_001');

    const ctx = await resolveDevActor(req, repo);
    expect(ctx?.actor.id).toBe('user_001');
  });
});
