import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (_request, reply) => {
    return reply.code(200).send({
      ok: true,
      service: 'celator-api',
      timestamp: new Date().toISOString(),
    });
  });
};
