import { PrismaClient } from '../generated/client/index.js';

let _client: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!_client) {
    _client = new PrismaClient({
      log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
      errorFormat: 'minimal',
    });
  }
  return _client;
}

export async function disconnectPrisma(): Promise<void> {
  if (_client) {
    await _client.$disconnect();
    _client = undefined;
  }
}

export { PrismaClient } from '../generated/client/index.js';
export type * from '../generated/client/index.js';
