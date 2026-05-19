import { describe, it, expect } from 'vitest';
import { EmergencyPauseService } from '../pause/emergency-pause.service.js';

const ADMIN_ACTOR = { actorId: 'admin_001', actorType: 'ADMIN' };
const LONG_REASON = 'Security incident detected — halting all submissions pending investigation';
const LONG_RESOLUTION = 'Incident resolved. Root cause identified and patched. Safe to resume.';

describe('EmergencyPauseService', () => {
  describe('triggering pauses', () => {
    it('triggers a GLOBAL pause', () => {
      const svc = new EmergencyPauseService();
      const { pause } = svc.triggerPause('GLOBAL', undefined, LONG_REASON, ADMIN_ACTOR);
      expect(pause.status).toBe('ACTIVE');
      expect(pause.scope).toBe('GLOBAL');
      expect(pause.requiresDualAdmin).toBe(true);
    });

    it('triggers a CLIENT-scoped pause', () => {
      const svc = new EmergencyPauseService();
      const { pause } = svc.triggerPause('CLIENT', 'client_001', LONG_REASON, ADMIN_ACTOR);
      expect(pause.scope).toBe('CLIENT');
      expect(pause.scopeRef).toBe('client_001');
    });

    it('rejects short reason', () => {
      const svc = new EmergencyPauseService();
      expect(() => svc.triggerPause('GLOBAL', undefined, 'short', ADMIN_ACTOR)).toThrow();
    });
  });

  describe('isPausedFor', () => {
    it('GLOBAL pause blocks all contexts', () => {
      const svc = new EmergencyPauseService();
      svc.triggerPause('GLOBAL', undefined, LONG_REASON, ADMIN_ACTOR);
      expect(svc.isPausedFor({ clientId: 'any_client' })).toBe(true);
      expect(svc.isPausedFor({ operatorId: 'any_op' })).toBe(true);
      expect(svc.isPausedFor({})).toBe(true);
    });

    it('CLIENT pause blocks only that client', () => {
      const svc = new EmergencyPauseService();
      svc.triggerPause('CLIENT', 'client_blocked', LONG_REASON, ADMIN_ACTOR);
      expect(svc.isPausedFor({ clientId: 'client_blocked' })).toBe(true);
      expect(svc.isPausedFor({ clientId: 'client_not_blocked' })).toBe(false);
    });

    it('OPERATOR pause blocks execution for that operator', () => {
      const svc = new EmergencyPauseService();
      svc.triggerPause('OPERATOR', 'op_compromised', LONG_REASON, ADMIN_ACTOR);
      expect(svc.isPausedFor({ operatorId: 'op_compromised' })).toBe(true);
      expect(svc.isPausedFor({ operatorId: 'op_other' })).toBe(false);
    });

    it('BROKER pause blocks matching broker', () => {
      const svc = new EmergencyPauseService();
      svc.triggerPause('BROKER', 'broker-xyz', LONG_REASON, ADMIN_ACTOR);
      expect(svc.isPausedFor({ brokerRef: 'broker-xyz' })).toBe(true);
      expect(svc.isPausedFor({ brokerRef: 'broker-other' })).toBe(false);
    });

    it('JURISDICTION pause blocks matching jurisdiction', () => {
      const svc = new EmergencyPauseService();
      svc.triggerPause('JURISDICTION', 'US-CA', LONG_REASON, ADMIN_ACTOR);
      expect(svc.isPausedFor({ jurisdiction: 'US-CA' })).toBe(true);
      expect(svc.isPausedFor({ jurisdiction: 'US-TX' })).toBe(false);
    });

    it('resolved pause does not block', () => {
      const svc = new EmergencyPauseService();
      const { pause } = svc.triggerPause('CLIENT', 'client_temp', LONG_REASON, ADMIN_ACTOR);
      svc.resolvePause(pause.id, LONG_RESOLUTION, ADMIN_ACTOR);
      expect(svc.isPausedFor({ clientId: 'client_temp' })).toBe(false);
    });
  });

  describe('resolving pauses', () => {
    it('resolves a pause and writes audit log', () => {
      const svc = new EmergencyPauseService();
      const { pause } = svc.triggerPause('CLIENT', 'client_001', LONG_REASON, ADMIN_ACTOR);
      const { pause: resolved } = svc.resolvePause(pause.id, LONG_RESOLUTION, ADMIN_ACTOR);
      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.resolvedBy).toBe('admin_001');
      expect(resolved.resolutionSummary).toBe(LONG_RESOLUTION);

      const logs = svc.getAuditLog();
      expect(logs.some((l) => l.eventType === 'EMERGENCY_PAUSE_RESOLVED')).toBe(true);
    });

    it('cannot resolve an already-resolved pause', () => {
      const svc = new EmergencyPauseService();
      const { pause } = svc.triggerPause('CLIENT', 'c1', LONG_REASON, ADMIN_ACTOR);
      svc.resolvePause(pause.id, LONG_RESOLUTION, ADMIN_ACTOR);
      expect(() => svc.resolvePause(pause.id, LONG_RESOLUTION, ADMIN_ACTOR)).toThrow(/not active/i);
    });

    it('rejects short resolution summary', () => {
      const svc = new EmergencyPauseService();
      const { pause } = svc.triggerPause('CLIENT', 'c1', LONG_REASON, ADMIN_ACTOR);
      expect(() => svc.resolvePause(pause.id, 'too short', ADMIN_ACTOR)).toThrow();
    });

    it('trigger and resolve write audit log entries', () => {
      const svc = new EmergencyPauseService();
      const { pause } = svc.triggerPause('GLOBAL', undefined, LONG_REASON, ADMIN_ACTOR);
      svc.resolvePause(pause.id, LONG_RESOLUTION, ADMIN_ACTOR);
      const logs = svc.getAuditLog();
      expect(logs.some((l) => l.eventType === 'EMERGENCY_PAUSE_TRIGGERED')).toBe(true);
      expect(logs.some((l) => l.eventType === 'EMERGENCY_PAUSE_RESOLVED')).toBe(true);
    });
  });

  describe('listActivePauses', () => {
    it('lists only active pauses', () => {
      const svc = new EmergencyPauseService();
      const { pause: p1 } = svc.triggerPause('CLIENT', 'c1', LONG_REASON, ADMIN_ACTOR);
      svc.triggerPause('CLIENT', 'c2', LONG_REASON, ADMIN_ACTOR);
      svc.resolvePause(p1.id, LONG_RESOLUTION, ADMIN_ACTOR);
      const active = svc.listActivePauses();
      expect(active).toHaveLength(1);
      expect(active[0]?.scopeRef).toBe('c2');
    });
  });
});
