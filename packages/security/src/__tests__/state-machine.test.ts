import { describe, it, expect } from 'vitest';
import { CleanupTaskStatusService } from '../state-machine/cleanup-task-status.service.js';
import type { TransitionActor } from '../state-machine/cleanup-task-status.service.js';

const SYSTEM_ACTOR: TransitionActor = { actorId: 'system', actorType: 'SYSTEM' };
const OPERATOR_ACTOR: TransitionActor = { actorId: 'op_001', actorType: 'OPERATOR' };

describe('CleanupTaskStatusService', () => {
  describe('valid transitions', () => {
    it('allows FOUND -> CLASSIFIED', () => {
      const svc = new CleanupTaskStatusService();
      const result = svc.transition('task_001', 'case_001', 'FOUND', 'CLASSIFIED', SYSTEM_ACTOR);
      expect(result.toStatus).toBe('CLASSIFIED');
    });

    it('allows CLASSIFIED -> READY_FOR_OPERATOR_REVIEW', () => {
      const svc = new CleanupTaskStatusService();
      expect(() =>
        svc.transition('task_001', 'case_001', 'CLASSIFIED', 'READY_FOR_OPERATOR_REVIEW', OPERATOR_ACTOR),
      ).not.toThrow();
    });

    it('allows the full happy path to SUBMITTED', () => {
      const svc = new CleanupTaskStatusService();
      const steps: Array<[string, string]> = [
        ['FOUND', 'CLASSIFIED'],
        ['CLASSIFIED', 'READY_FOR_OPERATOR_REVIEW'],
        ['READY_FOR_OPERATOR_REVIEW', 'OPERATOR_APPROVED'],
        ['OPERATOR_APPROVED', 'READY_TO_SUBMIT'],
        ['READY_TO_SUBMIT', 'SUBMITTED'],
      ];
      for (const [from, to] of steps) {
        expect(svc.isTransitionAllowed(from as never, to as never)).toBe(true);
      }
    });

    it('allows SUBMITTED -> DELIVERED -> BROKER_CONFIRMED_RECEIPT -> WAITING_VERIFICATION -> VERIFIED_REMOVED', () => {
      const svc = new CleanupTaskStatusService();
      expect(svc.isTransitionAllowed('SUBMITTED', 'DELIVERED')).toBe(true);
      expect(svc.isTransitionAllowed('DELIVERED', 'BROKER_CONFIRMED_RECEIPT')).toBe(true);
      expect(svc.isTransitionAllowed('BROKER_CONFIRMED_RECEIPT', 'WAITING_VERIFICATION')).toBe(true);
      expect(svc.isTransitionAllowed('WAITING_VERIFICATION', 'VERIFIED_REMOVED')).toBe(true);
    });

    it('allows VERIFIED_REMOVED -> REAPPEARED -> READY_FOR_OPERATOR_REVIEW', () => {
      const svc = new CleanupTaskStatusService();
      expect(svc.isTransitionAllowed('VERIFIED_REMOVED', 'REAPPEARED')).toBe(true);
      expect(svc.isTransitionAllowed('REAPPEARED', 'READY_FOR_OPERATOR_REVIEW')).toBe(true);
    });
  });

  describe('invalid transitions blocked', () => {
    it('blocks direct jump to SUBMITTED from FOUND', () => {
      const svc = new CleanupTaskStatusService();
      expect(() =>
        svc.transition('task_001', 'case_001', 'FOUND', 'SUBMITTED', SYSTEM_ACTOR),
      ).toThrow(/Invalid transition/i);
    });

    it('blocks SUBMITTED -> VERIFIED_REMOVED directly', () => {
      const svc = new CleanupTaskStatusService();
      expect(svc.isTransitionAllowed('SUBMITTED', 'VERIFIED_REMOVED')).toBe(false);
    });

    it('blocks READY_FOR_OPERATOR_REVIEW -> SUBMITTED (must go through OPERATOR_APPROVED -> READY_TO_SUBMIT)', () => {
      const svc = new CleanupTaskStatusService();
      expect(svc.isTransitionAllowed('READY_FOR_OPERATOR_REVIEW', 'SUBMITTED')).toBe(false);
    });

    it('blocks FOUND -> VERIFIED_REMOVED', () => {
      const svc = new CleanupTaskStatusService();
      expect(svc.isTransitionAllowed('FOUND', 'VERIFIED_REMOVED')).toBe(false);
    });

    it('blocks CLASSIFIED -> SUBMITTED', () => {
      const svc = new CleanupTaskStatusService();
      expect(svc.isTransitionAllowed('CLASSIFIED', 'SUBMITTED')).toBe(false);
    });

    it('throws with clear error message on invalid transition', () => {
      const svc = new CleanupTaskStatusService();
      expect(() =>
        svc.transition('task_001', 'case_001', 'SUBMITTED', 'FOUND', SYSTEM_ACTOR),
      ).toThrow(/SUBMITTED.*FOUND|not in the allowed/i);
    });
  });

  describe('safe exits', () => {
    it('allows OPERATOR_APPROVED -> PAUSED_BY_SYSTEM', () => {
      const svc = new CleanupTaskStatusService();
      expect(svc.isTransitionAllowed('OPERATOR_APPROVED', 'PAUSED_BY_SYSTEM')).toBe(true);
    });

    it('allows READY_TO_SUBMIT -> NEEDS_OPERATOR_REVIEW', () => {
      const svc = new CleanupTaskStatusService();
      expect(svc.isTransitionAllowed('READY_TO_SUBMIT', 'NEEDS_OPERATOR_REVIEW')).toBe(true);
    });

    it('allows SUBMITTED -> MANUAL_ONLY', () => {
      const svc = new CleanupTaskStatusService();
      expect(svc.isTransitionAllowed('SUBMITTED', 'MANUAL_ONLY')).toBe(true);
    });
  });

  describe('audit trail', () => {
    it('writes timeline event on valid transition', () => {
      const svc = new CleanupTaskStatusService();
      svc.transition('task_001', 'case_001', 'FOUND', 'CLASSIFIED', SYSTEM_ACTOR);
      const events = svc.getTimelineEvents('task_001');
      expect(events).toHaveLength(1);
      expect(events[0]?.fromStatus).toBe('FOUND');
      expect(events[0]?.toStatus).toBe('CLASSIFIED');
    });

    it('writes audit log entry on valid transition', () => {
      const svc = new CleanupTaskStatusService();
      svc.transition('task_001', 'case_001', 'FOUND', 'CLASSIFIED', OPERATOR_ACTOR);
      const logs = svc.getAuditLog();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.eventType).toBe('CLEANUP_TASK_TRANSITION');
    });
  });
});
