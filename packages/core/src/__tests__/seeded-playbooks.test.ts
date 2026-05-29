/**
 * seeded-playbooks.test.ts
 *
 * Validates static invariants on PLAYBOOK_DEFINITIONS without touching the DB.
 * Uses the production checkRedactedPreview gate so tests are gated by the same
 * function as the live service — any future PII policy tightening automatically
 * tightens these checks too.
 */

import { describe, it, expect } from 'vitest';
import { checkRedactedPreview } from '@celator/security';
import { PLAYBOOK_DEFINITIONS } from '../playbook-library.js';

describe('PLAYBOOK_DEFINITIONS (Phase 2D)', () => {
  it('defines exactly 5 playbooks', () => {
    expect(PLAYBOOK_DEFINITIONS).toHaveLength(5);
  });

  it('all playbooks have unique name+version combinations', () => {
    const keys = PLAYBOOK_DEFINITIONS.map((p) => `${p.name}||${p.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('includes PEOPLE_SEARCH and OTHER sourceType playbooks (Phase 2D additions)', () => {
    const sourceTypes = PLAYBOOK_DEFINITIONS.map((p) => p.sourceType);
    expect(sourceTypes).toContain('PEOPLE_SEARCH');
    expect(sourceTypes).toContain('OTHER');
  });

  for (const playbook of PLAYBOOK_DEFINITIONS) {
    describe(`Playbook: "${playbook.name}" (${playbook.sourceType})`, () => {
      it('has at least 8 steps', () => {
        expect(playbook.steps.length).toBeGreaterThanOrEqual(8);
      });

      it('has non-empty name and description', () => {
        expect(playbook.name.trim().length).toBeGreaterThan(0);
        expect(playbook.description.trim().length).toBeGreaterThan(0);
      });

      it('name and description pass PII check', () => {
        expect(checkRedactedPreview(playbook.name)).toBeNull();
        expect(checkRedactedPreview(playbook.description)).toBeNull();
      });

      it('step orders are unique and start at 1 with no gaps', () => {
        const orders = playbook.steps.map((s) => s.stepOrder).sort((a, b) => a - b);
        expect(new Set(orders).size).toBe(orders.length);
        orders.forEach((order, i) => expect(order).toBe(i + 1));
      });

      it('has at least one MANUAL_SUBMISSION step', () => {
        const kinds = playbook.steps.map((s) => s.stepKind);
        expect(kinds).toContain('MANUAL_SUBMISSION');
      });

      it('has a CLOSE_TASK step', () => {
        const kinds = playbook.steps.map((s) => s.stepKind);
        expect(kinds).toContain('CLOSE_TASK');
      });

      it('all step titles pass PII check and are non-empty', () => {
        for (const step of playbook.steps) {
          expect(step.title.trim().length).toBeGreaterThan(0);
          expect(checkRedactedPreview(step.title), `step ${step.stepOrder} title`).toBeNull();
        }
      });

      it('all step instructions pass PII check and are non-empty', () => {
        for (const step of playbook.steps) {
          expect(step.instructions.trim().length).toBeGreaterThan(0);
          expect(checkRedactedPreview(step.instructions), `step ${step.stepOrder} instructions`).toBeNull();
        }
      });
    });
  }
});
