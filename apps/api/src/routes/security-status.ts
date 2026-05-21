import type { FastifyPluginAsync } from 'fastify';
import { EmergencyPauseService } from '@celator/security/pause';
import { checkDbHealth } from '@celator/db';

// Singleton pause service — in-memory, safe for Phase 1A
const pauseService = new EmergencyPauseService();

export const securityStatusRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/security/status', async (_request, reply) => {
    const activePauses = pauseService.listActivePauses();
    const isAnyPauseActive = activePauses.length > 0;

    const dbHealth = await checkDbHealth();

    // Safe status — no secrets, no PII, no internal IDs, no DATABASE_URL
    return reply.code(200).send({
      ok: true,
      environment: process.env['NODE_ENV'] ?? 'unknown',
      emergencyPause: {
        active: isAnyPauseActive,
        activePauseCount: activePauses.length,
        scopes: activePauses.map((p) => p.scope),
      },
      database: {
        reachable: dbHealth.reachable,
        ...(dbHealth.latencyMs !== undefined ? { latencyMs: dbHealth.latencyMs } : {}),
        ...(dbHealth.error !== undefined ? { error: dbHealth.error } : {}),
      },
      phase: 'PHASE_1A_DB_CASE_MANAGEMENT',
      version: '0.0.1',
      timestamp: new Date().toISOString(),
    });
  });
};
