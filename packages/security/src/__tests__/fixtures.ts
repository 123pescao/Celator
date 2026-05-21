/**
 * Test fixtures for Celator Phase 0 tests.
 * Uses SYNTHETIC data only — no real PII.
 */

import { LocalKmsProvider } from '../kms/local-kms.js';
import { IdentityVaultService } from '../vault/identity-vault.service.js';
import { ApprovalSnapshotService } from '../approval/approval-snapshot.service.js';
import { ConsentPolicyService } from '../consent/consent-policy.service.js';
import { EmergencyPauseService } from '../pause/emergency-pause.service.js';
import { ApprovalGateService } from '../gate/approval-gate.service.js';
import type { GateClient, GateOperator, GateTask, GateApproval, GateContext } from '../gate/approval-gate.service.js';
import type { ClientAuthorizationRef } from '../consent/consent-policy.service.js';
import type { ApprovalSnapshot } from '../approval/approval-snapshot.service.js';

// Test KMS secrets — development only, synthetic
export const TEST_KMS_MASTER = 'test-master-secret-for-celator-phase0-testing-only';
export const TEST_KMS_SIGNING = 'test-signing-secret-for-celator-phase0-testing-only';

export function makeKms(): LocalKmsProvider {
  return new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
}

export function makeVault(kms = makeKms()): IdentityVaultService {
  return new IdentityVaultService(kms);
}

export function makeSnapshotService(kms = makeKms()): ApprovalSnapshotService {
  return new ApprovalSnapshotService(kms);
}

export function makeConsentPolicy(): ConsentPolicyService {
  return new ConsentPolicyService();
}

export function makePauseService(): EmergencyPauseService {
  return new EmergencyPauseService();
}

export function makeGateServices(): {
  kms: LocalKmsProvider;
  snapshots: ApprovalSnapshotService;
  consent: ConsentPolicyService;
  pause: EmergencyPauseService;
  gate: ApprovalGateService;
} {
  const kms = makeKms();
  const snapshots = new ApprovalSnapshotService(kms);
  const consent = new ConsentPolicyService();
  const pause = new EmergencyPauseService();
  const gate = new ApprovalGateService(consent, pause, snapshots);
  return { kms, snapshots, consent, pause, gate };
}

// =============================================================
// Synthetic test actors
// =============================================================

export const TEST_CLIENT_ID = 'client_test_001';
export const TEST_CASE_ID = 'case_test_001';
export const TEST_TASK_ID = 'task_test_001';
export const TEST_OPERATOR_ID = 'operator_test_001';
export const TEST_ORG_ID = 'org_test_001';
export const TEST_SNAPSHOT_ID = 'snap_test_001';

export function makeTestClient(overrides?: Partial<GateClient>): GateClient {
  return {
    id: TEST_CLIENT_ID,
    status: 'ACTIVE',
    hasDisputeFlag: false,
    hasComplianceHold: false,
    identityVerified: true,
    ...overrides,
  };
}

export function makeTestOperator(overrides?: Partial<GateOperator>): GateOperator {
  return {
    id: TEST_OPERATOR_ID,
    organizationId: TEST_ORG_ID,
    isActive: true,
    mfaEnabled: true,
    lastMfaAt: new Date(Date.now() - 60_000), // 1 minute ago
    ...overrides,
  };
}

export function makeTestTask(overrides?: Partial<GateTask>): GateTask {
  return {
    id: TEST_TASK_ID,
    caseId: TEST_CASE_ID,
    status: 'OPERATOR_APPROVED',
    actionType: 'OPT_OUT',
    matchStatus: 'CONFIRMED_MATCH',
    riskTier: 'STANDARD',
    sourceRef: 'test-broker-001',
    highRiskFlags: [],
    ...overrides,
  };
}

export function makeTestAuthorization(overrides?: Partial<ClientAuthorizationRef>): ClientAuthorizationRef {
  return {
    id: 'auth_test_001',
    clientId: TEST_CLIENT_ID,
    scopeNames: ['DATA_BROKER_OPT_OUT'],
    jurisdiction: 'US-CA',
    signedAt: new Date('2024-06-01'),
    ...overrides,
  };
}

export function makeTestApproval(payloadHash: string, overrides?: Partial<GateApproval>): GateApproval {
  const now = new Date();
  const mfaAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago
  return {
    id: 'approval_test_001',
    snapshotId: TEST_SNAPSHOT_ID,
    operatorId: TEST_OPERATOR_ID,
    operatorOrganizationId: TEST_ORG_ID,
    mfaFreshAt: mfaAt,
    sessionApprovalCount: 3,
    // 6 minutes covers the HIGH-risk minimum review time of 300s (5 minutes)
    reviewStartedAt: new Date(now.getTime() - 6 * 60 * 1000),
    approvedAt: now,
    approvedPayloadHash: payloadHash,
    ...overrides,
  };
}

export function makeTestSnapshot(
  service: ApprovalSnapshotService,
  payloadHash: string,
  overrides?: Partial<ApprovalSnapshot>,
): ApprovalSnapshot {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 14);
  return {
    id: TEST_SNAPSHOT_ID,
    taskId: TEST_TASK_ID,
    payloadHash,
    snapshotSignature: 'test-signature-will-verify-below',
    signingKeyVersion: service['kms'].getCurrentSigningKeyVersion(),
    snapshotStatus: 'ACTIVE',
    snapshotExpiresAt: expiresAt,
    riskTier: 'STANDARD',
    actionType: 'OPT_OUT',
    redactedPreview: 'Opt-out request for [BROKER] — [CLIENT_NAME_REDACTED]',
    evidenceIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export async function makeValidGateContext(
  services: ReturnType<typeof makeGateServices>,
): Promise<GateContext> {
  const { snapshots } = services;

  const payload = {
    taskId: TEST_TASK_ID,
    clientId: TEST_CLIENT_ID,
    caseId: TEST_CASE_ID,
    actionType: 'OPT_OUT' as const,
    sourceRef: 'test-broker-001',
    submissionFields: { optOutType: 'DATA_BROKER_OPT_OUT' },
    evidenceIds: ['ev_001'],
  };

  const canonical = snapshots.canonicalizePayload(payload);
  const payloadHash = snapshots.hashPayload(canonical);

  // Create a real signed snapshot
  const { snapshot, evidenceHolds } = await snapshots.createSnapshot(
    TEST_TASK_ID,
    payload,
    'STANDARD',
    'OPT_OUT',
    ['ev_001'],
    'Opt-out for test broker — [CLIENT_REDACTED]',
  );

  // Fix the snapshot in our test snapshot service's map
  void evidenceHolds;

  const client = makeTestClient();
  const authorization = makeTestAuthorization();
  const operator = makeTestOperator();
  const approval = makeTestApproval(payloadHash, { snapshotId: snapshot.id });

  // Fix the snapshot signature using the real signing key
  snapshot.snapshotSignature = await services.kms.signSnapshot(
    payloadHash,
    snapshot.signingKeyVersion,
  );

  return {
    task: makeTestTask(),
    client,
    authorization,
    operator,
    approval,
    snapshot,
    currentPayloadHash: payloadHash,
    brokerRef: 'test-broker-001',
    jurisdiction: 'US-CA',
    isLegalHoldOnSource: false,
    isResubmission: false,
    evidenceAvailable: true,
    dataMinimizationEnforced: true,
    optionalFieldsIncluded: [],
    acknowledgedWarnings: [],
    requiredWarnings: [],
    isOrganizationSingleOperator: false,
  };
}
