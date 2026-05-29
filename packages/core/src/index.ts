/**
 * @celator/core — Shared types and utilities for Celator.
 *
 * This package contains:
 * - Shared Zod schemas for input validation
 * - Result type helpers (never throw across service boundaries)
 * - Shared error codes
 * - Safe ID generation
 *
 * No PII. No secrets. No database calls.
 */

export * from './result.js';
export * from './errors.js';
export * from './services/index.js';
export { PLAYBOOK_DEFINITIONS } from './playbook-library.js';
export type { PlaybookDef, PlaybookStepDef } from './playbook-library.js';
