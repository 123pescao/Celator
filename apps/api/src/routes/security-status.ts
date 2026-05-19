import type { FastifyPluginAsync } from 'fastify';
import { EmergencyPauseService } from '@celator/security/pause';

// Singleton pause service for Phase 0 (Phase 1 will inject via DI container)
const pauseService = new EmergencyPauseService();

export const securityStatusRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/security/status', async (_request, reply) => {
    const activePauses = pauseService.listActivePauses();
    const isAnyPauseActive = activePauses.length > 0;

    // Safe status — no secrets, no PII, no internal IDs
    return reply.code(200).send({
      ok: true,
      environment: process.env['NODE_ENV'] ?? 'unknown',
      emergencyPause: {
        active: isAnyPauseActive,
        activePauseCount: activePauses.length,
        scopes: activePauses.map((p) => p.scope),
        // No pauseIds, no reasons, no actor info in this endpoint
      },
      database: {
        // Phase 0: No live DB connection in this status check.
        // Phase 1: Check Prisma $connect with a timeout.
        reachable: false,
        note: 'Phase 0: DB health check not yet implemented',
      },
      phase: 'PHASE_0_SECURITY_FOUNDATION',
      version: '0.0.1',
      timestamp: new Date().toISOString(),
    });
  });
};
