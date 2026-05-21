import { beforeAll, afterAll } from 'vitest';
import { disconnectPrisma } from '@celator/db';

// Fail immediately if DATABASE_URL is not set — clear signal to the developer
beforeAll(() => {
  if (!process.env['DATABASE_URL']) {
    throw new Error(
      'DATABASE_URL is not set. Integration tests require a running Postgres instance.\n' +
        'Start Postgres: podman run -d --name celator-postgres -e POSTGRES_USER=celator ' +
        '-e POSTGRES_PASSWORD=celator -e POSTGRES_DB=celator -p 5432:5432 postgres:16-alpine\n' +
        'Then set DATABASE_URL=postgresql://celator:celator@localhost:5432/celator',
    );
  }
});

// Disconnect cleanly after all integration tests finish
afterAll(async () => {
  await disconnectPrisma();
});
