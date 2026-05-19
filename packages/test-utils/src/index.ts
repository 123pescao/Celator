/**
 * @celator/test-utils — Shared test helpers.
 *
 * Provides:
 * - waitMs: async wait helper
 * - assertNever: exhaustiveness check helper
 * - syntheticId: deterministic synthetic ID generator for tests
 *
 * Uses SYNTHETIC data only. No real PII.
 */

/**
 * Wait for a given number of milliseconds. Useful for testing time-sensitive logic.
 */
export async function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exhaustiveness check helper. Use in switch/if-else to ensure all cases are handled.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${String(value)}`);
}

/**
 * Generates a deterministic synthetic ID for tests.
 * Uses a simple counter to avoid collisions within a test run.
 */
let _counter = 0;
export function syntheticId(prefix: string): string {
  return `${prefix}_test_${++_counter}`;
}

/**
 * Resets the synthetic ID counter. Call in beforeEach if needed.
 */
export function resetSyntheticIdCounter(): void {
  _counter = 0;
}

/**
 * Deep-freeze an object for use in tests where immutability is critical.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (typeof obj !== 'object' || obj === null) return obj as Readonly<T>;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === 'object' && val !== null) {
      deepFreeze(val);
    }
  }
  return Object.freeze(obj) as Readonly<T>;
}
