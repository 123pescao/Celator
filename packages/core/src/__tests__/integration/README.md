# Integration Tests

Integration tests require a running PostgreSQL instance.

## Setup

1. Start the database:
   ```
   docker compose up -d
   ```

2. Run migrations:
   ```
   pnpm --filter @celator/db prisma:migrate:deploy
   ```

3. Run integration tests:
   ```
   pnpm --filter @celator/core test:integration
   ```

## What is tested

Integration tests wire real repositories (via PrismaClient) against the actual DB schema:

- `client-flow.integration.test.ts` — full client lifecycle: create → verify → activate
- `case-flow.integration.test.ts` — create case → add tasks → transition task statuses
- `consent-revocation.integration.test.ts` — create auth → revoke → verify tasks blocked

Integration tests are NOT run in CI by default because they require a live database.
Add `DATABASE_URL` to the CI environment to enable them.
