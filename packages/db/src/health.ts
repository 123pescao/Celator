import { getPrismaClient } from './client.js';

const DEFAULT_TIMEOUT_MS = 3000;

export interface DbHealthResult {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

// Classifies a raw error message into a safe, credential-free string.
function safeErrorCode(msg: string): string {
  if (msg.includes('ECONNREFUSED')) return 'DB_CONNECTION_REFUSED';
  if (msg.includes('ENOTFOUND')) return 'DB_HOST_NOT_FOUND';
  if (msg.includes('timeout') || msg.includes('TIMEOUT')) return 'DB_HEALTH_TIMEOUT';
  if (msg.includes('password') || msg.includes('auth')) return 'DB_AUTH_FAILED';
  return 'DB_UNREACHABLE';
}

/**
 * Checks DB reachability by running a lightweight query.
 *
 * The queryFn parameter is injectable so unit tests can exercise all branches
 * without a live database.  Production callers omit it and get the real
 * Prisma $queryRaw`SELECT 1`.
 */
export async function checkDbHealth(
  queryFn: () => Promise<unknown> = () => getPrismaClient().$queryRaw`SELECT 1`,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DbHealthResult> {
  const start = Date.now();

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('DB_HEALTH_TIMEOUT'));
    }, timeoutMs);
  });

  try {
    await Promise.race([queryFn(), timeoutPromise]);
    clearTimeout(timer);
    return { reachable: true, latencyMs: Date.now() - start };
  } catch (e) {
    clearTimeout(timer);
    const raw = e instanceof Error ? e.message : String(e);
    const error = timedOut ? 'DB_HEALTH_TIMEOUT' : safeErrorCode(raw);
    return { reachable: false, error };
  }
}
