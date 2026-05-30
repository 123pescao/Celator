import { ok, err } from '@celator/core';
import type { Result, ErrorCode } from '@celator/core';

// Authoritative resource-ownership helpers.
// caseClientId and requestClientId MUST come from DB-loaded records, never echoed from request params.

export function assertClientAccess(
  resource: { clientId: string },
  requestClientId: string,
): Result<void, ErrorCode> {
  if (resource.clientId === requestClientId) return ok(undefined);
  return err('FORBIDDEN', 'Access denied — resource belongs to a different client');
}

export function assertCaseAccess(
  caseRecord: { clientId: string },
  requestClientId: string,
): Result<void, ErrorCode> {
  if (caseRecord.clientId === requestClientId) return ok(undefined);
  return err('FORBIDDEN', 'Access denied — case belongs to a different client');
}

// task.caseId is used for reference only; caseRecord must be loaded by the caller from DB.
export function assertTaskAccess(
  task: { caseId: string },
  caseRecord: { clientId: string },
  requestClientId: string,
): Result<void, ErrorCode> {
  void task; // caseId is informational; ownership is derived from the loaded case record
  if (caseRecord.clientId === requestClientId) return ok(undefined);
  return err('FORBIDDEN', 'Access denied — task belongs to a different client');
}
