/**
 * Dev seed script: upsert a small set of generic data source targets.
 *
 * Uses .invalid domains. No real credentials, no real PII.
 * Safe to run multiple times (upsert by sourceName).
 *
 * Usage: pnpm ts-node --esm scripts/seed-dev-targets.ts
 *   OR:  npx tsx scripts/seed-dev-targets.ts
 */

import 'dotenv/config';
import { getPrismaClient } from '../packages/db/src/client.js';

const TARGETS = [
  {
    sourceName: 'Example People Search',
    sourceType: 'PEOPLE_SEARCH' as const,
    baseDomain: 'people-search.invalid',
    piiRequiredFields: ['FULL_NAME', 'EMAIL', 'ADDRESS'],
    supportedActionTypes: ['OPT_OUT'] as const,
    requiresLogin: false,
    requiresCaptcha: false,
    manualOnly: true,
    notes: 'Dev seed: example people search site. Uses .invalid domain.',
    isActive: true,
  },
  {
    sourceName: 'Example Data Broker',
    sourceType: 'DATA_BROKER' as const,
    baseDomain: 'databroker.invalid',
    piiRequiredFields: ['FULL_NAME', 'EMAIL'],
    supportedActionTypes: ['OPT_OUT', 'DELETE_PERSONAL_DATA', 'DO_NOT_SELL'] as const,
    requiresLogin: false,
    requiresCaptcha: false,
    manualOnly: false,
    notes: 'Dev seed: example data broker. Uses .invalid domain.',
    isActive: true,
  },
  {
    sourceName: 'Example Search Engine Removal',
    sourceType: 'SEARCH_ENGINE' as const,
    baseDomain: 'search.invalid',
    piiRequiredFields: ['URL', 'FULL_NAME'],
    supportedActionTypes: ['REMOVE_FROM_SEARCH', 'REFRESH_OUTDATED_CONTENT'] as const,
    requiresLogin: false,
    requiresCaptcha: false,
    manualOnly: true,
    notes: 'Dev seed: example search engine removal form. Uses .invalid domain.',
    isActive: true,
  },
  {
    sourceName: 'Example Social Platform',
    sourceType: 'SOCIAL_PLATFORM' as const,
    baseDomain: 'social.invalid',
    piiRequiredFields: ['USERNAME', 'EMAIL'],
    supportedActionTypes: ['DELETE_ACCOUNT', 'DEACTIVATE_ACCOUNT', 'SUPPRESS_PROFILE'] as const,
    requiresLogin: true,
    requiresCaptcha: false,
    manualOnly: false,
    notes: 'Dev seed: example social platform. Requires login. Uses .invalid domain.',
    isActive: true,
  },
  {
    sourceName: 'Example Public Record Site',
    sourceType: 'PUBLIC_RECORD_SITE' as const,
    baseDomain: 'publicrecords.invalid',
    piiRequiredFields: ['FULL_NAME', 'ADDRESS', 'DOB'],
    supportedActionTypes: ['OPT_OUT', 'DELETE_PERSONAL_DATA'] as const,
    requiresLogin: false,
    requiresCaptcha: true,
    manualOnly: true,
    notes: 'Dev seed: example public records site. Uses .invalid domain.',
    isActive: true,
  },
];

async function seed(): Promise<void> {
  const db = getPrismaClient();

  console.log(`Seeding ${TARGETS.length} data source targets...`);

  for (const target of TARGETS) {
    const result = await db.dataSourceTarget.upsert({
      where: { sourceName: target.sourceName },
      update: {
        isActive: target.isActive,
        notes: target.notes,
        supportedActionTypes: [...target.supportedActionTypes],
        piiRequiredFields: target.piiRequiredFields,
      },
      create: {
        sourceName: target.sourceName,
        sourceType: target.sourceType,
        baseDomain: target.baseDomain,
        piiRequiredFields: target.piiRequiredFields,
        supportedActionTypes: [...target.supportedActionTypes],
        requiresLogin: target.requiresLogin,
        requiresCaptcha: target.requiresCaptcha,
        manualOnly: target.manualOnly,
        notes: target.notes,
        isActive: target.isActive,
      },
    });
    console.log(`  ✓ ${result.sourceName} (${result.id})`);
  }

  console.log('Done.');
  await db.$disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
