import { describe, it, expect } from 'vitest';
import { checkDbHealth } from '@celator/db';

// All tests use an injected queryFn — no live Postgres required.

describe('checkDbHealth', () => {
  describe('reachable', () => {
    it('returns reachable=true when query resolves', async () => {
      const result = await checkDbHealth(() => Promise.resolve([{ '?column?': 1 }]));
      expect(result.reachable).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('includes latencyMs as a number', async () => {
      const result = await checkDbHealth(() => Promise.resolve([]));
      expect(typeof result.latencyMs).toBe('number');
    });
  });

  describe('unreachable — error classification', () => {
    it('classifies ECONNREFUSED correctly', async () => {
      const result = await checkDbHealth(() =>
        Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
      );
      expect(result.reachable).toBe(false);
      expect(result.error).toBe('DB_CONNECTION_REFUSED');
      expect(result.latencyMs).toBeUndefined();
    });

    it('classifies ENOTFOUND correctly', async () => {
      const result = await checkDbHealth(() =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND db.internal')),
      );
      expect(result.reachable).toBe(false);
      expect(result.error).toBe('DB_HOST_NOT_FOUND');
    });

    it('classifies auth errors without leaking credentials', async () => {
      const result = await checkDbHealth(() =>
        Promise.reject(new Error('password authentication failed for user "celator"')),
      );
      expect(result.reachable).toBe(false);
      expect(result.error).toBe('DB_AUTH_FAILED');
      // The raw error message must not appear in the result
      expect(JSON.stringify(result)).not.toContain('celator');
      expect(JSON.stringify(result)).not.toContain('password authentication failed');
    });

    it('classifies generic errors as DB_UNREACHABLE', async () => {
      const result = await checkDbHealth(() =>
        Promise.reject(new Error('some unexpected database driver error')),
      );
      expect(result.reachable).toBe(false);
      expect(result.error).toBe('DB_UNREACHABLE');
    });

    it('handles non-Error rejections safely', async () => {
      const result = await checkDbHealth(() => Promise.reject('raw string rejection'));
      expect(result.reachable).toBe(false);
      expect(result.error).toBe('DB_UNREACHABLE');
    });
  });

  describe('timeout', () => {
    it('returns DB_HEALTH_TIMEOUT when query exceeds timeoutMs', async () => {
      const neverResolves = (): Promise<never> =>
        new Promise<never>(() => { /* intentionally hangs */ });

      const result = await checkDbHealth(neverResolves, 50);
      expect(result.reachable).toBe(false);
      expect(result.error).toBe('DB_HEALTH_TIMEOUT');
    });

    it('does not expose DATABASE_URL in any error result', async () => {
      process.env['DATABASE_URL'] = 'postgresql://secret-user:secret-pass@host:5432/db';
      const result = await checkDbHealth(() =>
        Promise.reject(new Error('ECONNREFUSED secret-pass@host:5432')),
      );
      expect(JSON.stringify(result)).not.toContain('secret-pass');
      expect(JSON.stringify(result)).not.toContain('secret-user');
      delete process.env['DATABASE_URL'];
    });
  });

  describe('response shape', () => {
    it('reachable result never includes an error field', async () => {
      const result = await checkDbHealth(() => Promise.resolve([]));
      expect('error' in result).toBe(false);
    });

    it('unreachable result never includes a latencyMs field', async () => {
      const result = await checkDbHealth(() => Promise.reject(new Error('ECONNREFUSED')));
      expect('latencyMs' in result).toBe(false);
    });
  });
});
