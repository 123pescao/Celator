/**
 * Result<T, E> — Explicit success/failure type.
 *
 * Use this instead of throwing across service boundaries.
 * Security services always return blocked=true with a reason rather than throwing
 * for policy decisions. Exceptions are reserved for programming errors.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E extends string = string> = { readonly ok: false; readonly error: E; readonly message: string };
export type Result<T, E extends string = string> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E extends string>(error: E, message: string): Err<E> {
  return { ok: false, error, message };
}

export function isOk<T, E extends string>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

export function isErr<T, E extends string>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}

export function unwrap<T, E extends string>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`unwrap() called on Err: [${result.error}] ${result.message}`);
  }
  return result.value;
}
