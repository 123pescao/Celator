import { describe, it, expect } from 'vitest';
import { assertClientAccess, assertCaseAccess, assertTaskAccess } from '../auth/authz.js';

describe('assertClientAccess', () => {
  it('returns ok(undefined) when resource.clientId === requestClientId', () => {
    const result = assertClientAccess({ clientId: 'client_001' }, 'client_001');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });

  it('returns err(FORBIDDEN) when resource.clientId !== requestClientId', () => {
    const result = assertClientAccess({ clientId: 'client_001' }, 'client_002');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('FORBIDDEN');
  });

  it('error code is exactly FORBIDDEN — not UNAUTHORIZED or NOT_FOUND', () => {
    const result = assertClientAccess({ clientId: 'client_A' }, 'client_B');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('FORBIDDEN');
      expect(result.error).not.toBe('UNAUTHORIZED');
      expect(result.error).not.toBe('NOT_FOUND');
    }
  });

  it('returns FORBIDDEN when resource.clientId is non-empty but requestClientId is empty string', () => {
    const result = assertClientAccess({ clientId: 'client_001' }, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('FORBIDDEN');
  });

  it('ok is true and value is undefined (not null or truthy object)', () => {
    const result = assertClientAccess({ clientId: 'same_id' }, 'same_id');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
      expect(result.value).not.toBeNull();
    }
  });
});

describe('assertCaseAccess', () => {
  it('returns ok(undefined) when caseRecord.clientId === requestClientId', () => {
    const result = assertCaseAccess({ clientId: 'client_001' }, 'client_001');
    expect(result.ok).toBe(true);
  });

  it('returns err(FORBIDDEN) when caseRecord.clientId !== requestClientId', () => {
    const result = assertCaseAccess({ clientId: 'client_001' }, 'client_002');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('FORBIDDEN');
  });

  it('error.error is exactly FORBIDDEN in all failure cases', () => {
    const result = assertCaseAccess({ clientId: 'A' }, 'B');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('FORBIDDEN');
  });
});

describe('assertTaskAccess', () => {
  const task = { caseId: 'case_001' };

  it('returns ok(undefined) when caseRecord.clientId === requestClientId', () => {
    const result = assertTaskAccess(task, { clientId: 'client_001' }, 'client_001');
    expect(result.ok).toBe(true);
  });

  it('returns err(FORBIDDEN) when caseRecord.clientId !== requestClientId', () => {
    const result = assertTaskAccess(task, { clientId: 'client_001' }, 'client_002');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('FORBIDDEN');
  });

  it('uses caseRecord.clientId, not task.caseId, for ownership check', () => {
    // The caseRecord is loaded from DB — its clientId is authoritative
    const result = assertTaskAccess({ caseId: 'case_for_client_A' }, { clientId: 'client_A' }, 'client_B');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('FORBIDDEN');
  });

  it('FORBIDDEN when caseClientId is a real id but requestClientId is a different real id', () => {
    const result = assertTaskAccess(task, { clientId: 'clt_abc123' }, 'clt_xyz789');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('FORBIDDEN');
  });

  it('error code is FORBIDDEN in all failure cases', () => {
    const result = assertTaskAccess(task, { clientId: 'X' }, 'Y');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('FORBIDDEN');
  });
});
