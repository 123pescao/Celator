/**
 * PII-Safe Logger — Celator Phase 0
 *
 * A pino-based logger that redacts PII fields from all log output.
 *
 * Rules:
 * - Never logs decrypted identity values.
 * - Never logs full approval payloads.
 * - Redacts known PII field names by key pattern.
 * - Redacts values that match PII patterns (email, phone, SSN, etc.).
 * - Logs safe IDs and hashes only.
 *
 * In production: integrate with your log aggregation system.
 * Add new redaction patterns when new PII field types are introduced.
 */

import pino from 'pino';

// =============================================================
// Redaction field paths
// =============================================================

/**
 * Pino redact paths — removes these fields from structured log output.
 * Uses pino's built-in redact feature which replaces values with [Redacted].
 */
const REDACT_PATHS = [
  // Direct PII fields
  'email',
  'phone',
  'address',
  'dob',
  'dateOfBirth',
  'ssn',
  'socialSecurityNumber',
  'plaintext',
  'ciphertext',
  'password',
  'passwordHash',
  'secret',
  'privateKey',
  'accessToken',
  'refreshToken',
  'token',
  'authorization',
  'apiKey',
  'iv',
  'authTag',

  // Nested variants
  '*.email',
  '*.phone',
  '*.address',
  '*.dob',
  '*.dateOfBirth',
  '*.ssn',
  '*.plaintext',
  '*.ciphertext',
  '*.password',
  '*.secret',
  '*.privateKey',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  '*.authorization',
  '*.apiKey',

  // Array nested variants
  '[*].email',
  '[*].phone',
  '[*].address',
  '[*].dob',
  '[*].plaintext',
  '[*].ciphertext',
  '[*].password',
  '[*].secret',
  '[*].token',
];

// =============================================================
// PII pattern scrubber for string values
// =============================================================

const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[EMAIL_REDACTED]',
  },
  {
    name: 'us_phone',
    pattern: /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: '[PHONE_REDACTED]',
  },
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[SSN_REDACTED]',
  },
  {
    name: 'credit_card',
    pattern: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
    replacement: '[CARD_REDACTED]',
  },
  {
    name: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._\-]+/gi,
    replacement: '[BEARER_REDACTED]',
  },
];

/**
 * Scrub PII patterns from a string value.
 * Use for log message strings, not structured data (pino handles structured via redact paths).
 */
export function scrubPiiFromString(value: string): string {
  let result = value;
  for (const { pattern, replacement } of PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// =============================================================
// Logger factory
// =============================================================

export interface CelatorLoggerOptions {
  level?: string;
  name?: string;
  /** Set to true to pretty-print in development */
  prettyPrint?: boolean;
}

export function createLogger(options: CelatorLoggerOptions = {}): pino.Logger {
  const level = options.level ?? process.env['LOG_LEVEL'] ?? 'info';

  const logger = pino({
    name: options.name ?? 'celator',
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: '[Redacted]',
    },
    // Rename pid/hostname in production for cleaner logs
    base: {
      service: options.name ?? 'celator',
      env: process.env['NODE_ENV'] ?? 'development',
    },
    // Serialize errors properly
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    // Custom message serializer — scrub PII from message strings
    formatters: {
      log(object) {
        // Scrub message string if present
        if (typeof (object as Record<string, unknown>)['msg'] === 'string') {
          (object as Record<string, unknown>)['msg'] = scrubPiiFromString(
            (object as Record<string, unknown>)['msg'] as string,
          );
        }
        return object;
      },
    },
  });

  return logger;
}

// =============================================================
// Default singleton logger
// =============================================================

let _defaultLogger: pino.Logger | undefined;

export function getLogger(name?: string): pino.Logger {
  if (!_defaultLogger) {
    _defaultLogger = createLogger({ name: name ?? 'celator' });
  }
  return _defaultLogger;
}

export function resetLoggerForTesting(): void {
  _defaultLogger = undefined;
}

export type { pino };
