/**
 * seed-dev-playbooks.ts — Seeds generic removal playbooks for development.
 *
 * No real client PII. No credentials. No scraping instructions.
 * All instructions are generic and PII-safe operator guidance.
 *
 * Usage:
 *   cd Celator && node --loader ts-node/esm scripts/seed-dev-playbooks.ts
 */

import 'dotenv/config';
import { getPrismaClient } from '../packages/db/src/index.js';
import { RemovalPlaybookRepository } from '../packages/db/src/repositories/removal-playbook.repository.js';

const db = getPrismaClient();
const repo = new RemovalPlaybookRepository(db);

interface PlaybookDef {
  name: string;
  version: string;
  sourceType: 'DATA_BROKER' | 'SEARCH_ENGINE' | 'SOCIAL_PLATFORM';
  description: string;
  steps: Array<{
    stepOrder: number;
    stepKind:
      | 'VERIFY_TARGET_REQUIREMENTS'
      | 'PREPARE_REMOVAL_DRAFT'
      | 'OPERATOR_REVIEW'
      | 'MANUAL_SUBMISSION'
      | 'WAIT_FOR_CONFIRMATION'
      | 'RECORD_OUTCOME'
      | 'VERIFY_REMOVAL'
      | 'CLOSE_TASK';
    title: string;
    instructions: string;
    requiresApproval?: boolean;
    requiresManualSubmission?: boolean;
  }>;
}

const PLAYBOOKS: PlaybookDef[] = [
  {
    name: 'Generic Data Broker Opt-Out',
    version: '1.0.0',
    sourceType: 'DATA_BROKER',
    description: 'Standard 8-step opt-out flow for data broker sites. Covers verification, drafting, submission, and confirmation.',
    steps: [
      {
        stepOrder: 1,
        stepKind: 'VERIFY_TARGET_REQUIREMENTS',
        title: 'Verify Target Requirements',
        instructions:
          'Check the data broker target is active and has the required PII field types configured. Confirm the source URL is reachable and the opt-out process is available. No client data should be accessed at this step.',
      },
      {
        stepOrder: 2,
        stepKind: 'PREPARE_REMOVAL_DRAFT',
        title: 'Prepare Removal Draft',
        instructions:
          'Use the removal draft service to verify the vault has the required PII fields for this target. Review the redacted draft summary. Do not copy raw field values outside the vault.',
      },
      {
        stepOrder: 3,
        stepKind: 'OPERATOR_REVIEW',
        title: 'Operator Review',
        instructions:
          'Review the redacted draft and confirm the task matches the client authorization scope. Verify that no high-risk flags require additional approval. Approve or escalate as needed.',
        requiresApproval: true,
      },
      {
        stepOrder: 4,
        stepKind: 'MANUAL_SUBMISSION',
        title: 'Submit Opt-Out Request',
        instructions:
          'Navigate to the data broker opt-out page. Use the vault access flow to retrieve redacted field values for form completion only. Submit the opt-out form. Record the confirmation code if provided. Do not store raw field values in notes.',
        requiresManualSubmission: true,
      },
      {
        stepOrder: 5,
        stepKind: 'WAIT_FOR_CONFIRMATION',
        title: 'Wait for Broker Confirmation',
        instructions:
          'Allow the broker the standard processing time (typically 7-30 days depending on jurisdiction). Check for a confirmation email to the designated operator inbox. Record any broker acknowledgment code.',
      },
      {
        stepOrder: 6,
        stepKind: 'RECORD_OUTCOME',
        title: 'Record Broker Outcome',
        instructions:
          'Update the submission status with the broker outcome (ACKNOWLEDGED, COMPLETED, REJECTED, or NEEDS_MORE_INFO). Record any confirmation reference in the safe result summary. Do not include raw PII in notes.',
      },
      {
        stepOrder: 7,
        stepKind: 'VERIFY_REMOVAL',
        title: 'Verify Removal',
        instructions:
          'After the broker processing window, check the broker listing page to confirm the record no longer appears. Use only publicly available search without logging in. Record verification result.',
      },
      {
        stepOrder: 8,
        stepKind: 'CLOSE_TASK',
        title: 'Close Task',
        instructions:
          'Update the cleanup task status to reflect the final outcome. If removal is confirmed, mark as completed. If unresolved, escalate or schedule a follow-up. Add a safe result summary.',
      },
    ],
  },
  {
    name: 'Generic Search Engine Result Removal',
    version: '1.0.0',
    sourceType: 'SEARCH_ENGINE',
    description: 'Standard 8-step flow for search engine result removal requests (e.g. outdated content removal, right-to-erasure requests).',
    steps: [
      {
        stepOrder: 1,
        stepKind: 'VERIFY_TARGET_REQUIREMENTS',
        title: 'Verify Removal Eligibility',
        instructions:
          'Confirm the search engine target is active and the result URL meets the removal eligibility criteria (outdated, inaccurate, or covered by applicable privacy law). Do not access client vault data at this step.',
      },
      {
        stepOrder: 2,
        stepKind: 'PREPARE_REMOVAL_DRAFT',
        title: 'Prepare Removal Request Draft',
        instructions:
          'Identify the specific URLs to be removed using only publicly visible references. Prepare a redacted summary of the removal request. Confirm the client authorization covers the relevant action type.',
      },
      {
        stepOrder: 3,
        stepKind: 'OPERATOR_REVIEW',
        title: 'Operator Review',
        instructions:
          'Review the list of URLs and the removal justification. Confirm accuracy and that no false positives are included. Escalate high-risk cases.',
        requiresApproval: true,
      },
      {
        stepOrder: 4,
        stepKind: 'MANUAL_SUBMISSION',
        title: 'Submit Removal Request',
        instructions:
          'Submit the removal request through the search engine removal portal or webmaster tools form. Attach supporting justification if required by the platform. Record the request ID or confirmation code.',
        requiresManualSubmission: true,
      },
      {
        stepOrder: 5,
        stepKind: 'WAIT_FOR_CONFIRMATION',
        title: 'Wait for Search Engine Response',
        instructions:
          'Monitor for the platform decision email or portal status update (typically 1-14 days). Check removal status in the platform dashboard if available.',
      },
      {
        stepOrder: 6,
        stepKind: 'RECORD_OUTCOME',
        title: 'Record Platform Decision',
        instructions:
          'Update the submission with the platform decision (approved, denied, partial). Record any reference code in the safe result summary. If denied, note the reason for operator review.',
      },
      {
        stepOrder: 7,
        stepKind: 'VERIFY_REMOVAL',
        title: 'Verify Removal from Search Index',
        instructions:
          'Search for the previously visible result to confirm it no longer appears in search results. Check across relevant search regions if applicable. Record the verification outcome.',
      },
      {
        stepOrder: 8,
        stepKind: 'CLOSE_TASK',
        title: 'Close Task',
        instructions:
          'Update the cleanup task with the final outcome. If removal is confirmed, mark completed. If the request was denied, assess whether to escalate or re-submit with additional documentation.',
      },
    ],
  },
  {
    name: 'Generic Social Platform Account/Data Removal',
    version: '1.0.0',
    sourceType: 'SOCIAL_PLATFORM',
    description: 'Standard 8-step flow for social platform account or data removal requests (profile deletion, content removal, privacy requests).',
    steps: [
      {
        stepOrder: 1,
        stepKind: 'VERIFY_TARGET_REQUIREMENTS',
        title: 'Verify Platform Requirements',
        instructions:
          'Confirm the social platform target is active. Review the platform removal policy (account deletion, content removal, data download + delete). Confirm client authorization covers the applicable action type.',
      },
      {
        stepOrder: 2,
        stepKind: 'PREPARE_REMOVAL_DRAFT',
        title: 'Prepare Removal Draft',
        instructions:
          'Identify what specifically needs to be removed (account, posts, profile data). Use the removal draft service to review required PII fields. Prepare a redacted description of the removal request.',
      },
      {
        stepOrder: 3,
        stepKind: 'OPERATOR_REVIEW',
        title: 'Operator Review',
        instructions:
          'Review the removal scope and confirm it aligns with the client authorization. Check for high-risk flags or legal hold before proceeding. Document any concerns.',
        requiresApproval: true,
      },
      {
        stepOrder: 4,
        stepKind: 'MANUAL_SUBMISSION',
        title: 'Submit Removal or Deletion Request',
        instructions:
          'Use the platform privacy portal, in-app deletion flow, or formal DSAR (Data Subject Access Request) process. Do not log into the client account on their behalf without documented authorization. Record the request reference or confirmation code.',
        requiresManualSubmission: true,
      },
      {
        stepOrder: 5,
        stepKind: 'WAIT_FOR_CONFIRMATION',
        title: 'Wait for Platform Processing',
        instructions:
          'Allow the platform standard processing time. Platforms may take 30-90 days for full account deletion. Monitor for confirmation emails to the designated contact.',
      },
      {
        stepOrder: 6,
        stepKind: 'RECORD_OUTCOME',
        title: 'Record Platform Outcome',
        instructions:
          'Update the submission with the platform response (confirmed, pending review, rejected). Record any reference ID in the safe result summary. No raw PII in notes.',
      },
      {
        stepOrder: 7,
        stepKind: 'VERIFY_REMOVAL',
        title: 'Verify Removal',
        instructions:
          'Check publicly accessible platform pages to confirm the account or content is no longer visible. Document the verification method and result without capturing any residual personal data.',
      },
      {
        stepOrder: 8,
        stepKind: 'CLOSE_TASK',
        title: 'Close Task',
        instructions:
          'Update the cleanup task with the verified outcome. If removal is confirmed, mark completed. If blocked or incomplete, escalate with supporting evidence.',
      },
    ],
  },
];

async function seedPlaybooks(): Promise<void> {
  console.log('Seeding dev playbooks...\n');

  for (const def of PLAYBOOKS) {
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
