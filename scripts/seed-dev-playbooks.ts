/**
 * seed-dev-playbooks.ts — Seeds generic removal playbooks for development.
 *
 * Playbook definitions live in playbook-definitions.ts and are imported here.
 * No real client PII. No credentials. No scraping instructions.
 *
 * Usage:
 *   cd Celator && node --loader ts-node/esm scripts/seed-dev-playbooks.ts
 */

import 'dotenv/config';
import { getPrismaClient } from '../packages/db/src/index.js';
import { RemovalPlaybookRepository } from '../packages/db/src/repositories/removal-playbook.repository.js';
import { PLAYBOOK_DEFINITIONS } from '../packages/core/src/playbook-library.js';

const db = getPrismaClient();
const repo = new RemovalPlaybookRepository(db);

async function seedPlaybooks(): Promise<void> {
  console.log('Seeding dev playbooks...\n');

  for (const def of PLAYBOOK_DEFINITIONS) {
    // Skip if already exists (idempotent)
    const existing = await db.removalPlaybook.findUnique({
      where: { name_version: { name: def.name, version: def.version } },
    });

    if (existing) {
      console.log(`  [SKIP] "${def.name}" v${def.version} already exists (${existing.id})`);
      continue;
    }

    const playbook = await repo.create({
      name: def.name,
      version: def.version,
      sourceType: def.sourceType,
      description: def.description,
    });

    for (const step of def.steps) {
      await repo.addStep({
        playbookId: playbook.id,
        stepOrder: step.stepOrder,
        stepKind: step.stepKind,
        title: step.title,
        instructions: step.instructions,
        ...(step.requiresApproval !== undefined ? { requiresApproval: step.requiresApproval } : {}),
        ...(step.requiresManualSubmission !== undefined ? { requiresManualSubmission: step.requiresManualSubmission } : {}),
      });
    }

    console.log(`  [CREATED] "${def.name}" v${def.version} — ${def.steps.length} steps — id: ${playbook.id}`);
  }

  console.log('\nSeed complete.');
  await db.$disconnect();
}

seedPlaybooks().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
