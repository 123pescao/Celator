/**
 * Celator API — Phase 0 Foundation
 *
 * Minimal Fastify server for developer health checks and security status.
 * No product endpoints in Phase 0. No PII access endpoints.
 *
 * Phase 1 will add:
 * - Client onboarding
 * - Operator dashboard
 * - Approval workflow
 * - Case management
 */

import 'dotenv/config';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { createLogger } from '@celator/security/logger';
import { healthRoutes } from './routes/health.js';
import { securityStatusRoutes } from './routes/security-status.js';
import { adminRoutes } from './routes/v1/admin.js';
import { clientRoutes } from './routes/v1/clients.js';
import { caseRoutes } from './routes/v1/cases.js';
import { reviewPacketRoutes } from './routes/v1/review-packets.js';
import { consentRoutes } from './routes/v1/consent.js';
import { buildServices } from './services-factory.js';

const logger = createLogger({ name: 'celator-api' });

const PORT = parseInt(process.env['API_PORT'] ?? '3000', 10);
const HOST = process.env['API_HOST'] ?? '127.0.0.1';

async function start(): Promise<void> {
  const { services, repos } = buildServices();

  const fastify = Fastify({
    logger: false, // We use pino directly via createLogger
    disableRequestLogging: true,
  });

  // Security headers
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
      },
    },
  });

  // Request logging middleware (PII-safe)
  fastify.addHook('onRequest', (request, _reply, done) => {
    logger.info({
      reqId: request.id,
      method: request.method,
      url: request.url,
    }, 'incoming request');
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    logger.info({
      reqId: request.id,
      statusCode: reply.statusCode,
      url: request.url,
    }, 'request completed');
    done();
  });

  // Routes
  await fastify.register(healthRoutes);
  await fastify.register(securityStatusRoutes);

  // Phase 1A/1B — developer testing endpoints (prefix /api/v1)
  await fastify.register(adminRoutes, { prefix: '/api/v1', repos });
  await fastify.register(clientRoutes, { prefix: '/api/v1', services });
  await fastify.register(caseRoutes, { prefix: '/api/v1', services });
  await fastify.register(reviewPacketRoutes, { prefix: '/api/v1', services });
  await fastify.register(consentRoutes, { prefix: '/api/v1', services });

  // Global error handler — never expose stack traces in responses
  fastify.setErrorHandler((error, request, reply) => {
    logger.error({
      reqId: request.id,
      err: error,
    }, 'unhandled request error');
    void reply.code(500).send({
      ok: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    });
  });

  // 404 handler
  fastify.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({
      ok: false,
      error: 'NOT_FOUND',
      message: 'Route not found',
    });
  });

  await fastify.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST, env: process.env['NODE_ENV'] }, 'celator-api started');
}

start().catch((err) => {
  logger.error({ err }, 'failed to start celator-api');
  process.exit(1);
});
