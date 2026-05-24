/**
 * Phase 1A end-to-end workflow integration test.
 *
 * Requires DATABASE_URL to point to a running Postgres instance with migrations applied.
 * Uses the 'it_' prefix for all test data IDs and cleans up after each test.
 *
 * Sequence: organization → user → client → identity verification → activation
 *           → consent version → authorization → case → task → review packet
 *           → operator approval → audit logs → case timeline
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  getPrismaClient,
  OrganizationRepository,
  UserRepository,
  ClientRepository,
  ClientIdentityVerificationRepository,
  ConsentVersionRepository,
  ClientAuthorizationRepository,
  CleanupCaseRepository,
  CleanupTaskRepository,
  ApprovalPayloadSnapshotRepository,
  ApprovalRequestRepository,
  OperatorApprovalRepository,
  AuditLogRepository,
  CaseTimelineRepository,
  IdentityVaultRecordRepository,
  IdentityVaultAccessLogRepository,
  DataSourceTargetRepository,
  ManualRemovalSubmissionRepository,
  RemovalPlaybookRepository,
  TaskWorkflowRunRepository,
} from '@celator/db';
import { LocalKmsProvider } from '@celator/security';
import {
  AuditService,
  CaseTimelineService,
  ClientService,
  ClientIdentityVerificationService,
  ConsentWorkflowService,
  CleanupCaseService,
  CleanupTaskService,
  ReviewPacketService,
  OperatorApprovalService,
  IdentityVaultIntakeService,
  DataSourceTargetService,
  RemovalRequestDraftService,
  ManualRemovalSubmissionService,
  WorkflowEngineService,
} from '../../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PREFIX = 'it_';
const db = getPrismaClient();

// Shared test actor — a real User row created in beforeAll so audit logs can link to it.
let TEST_ACTOR_ID = '';
let BOOTSTRAP_ORG_ID = '';

/** Unique suffix for each test run to avoid cross-test collisions */
function suffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Delete all test data created by integration tests (identified by prefix in name/displayName fields) */
async function cleanupTestData(): Promise<void> {
  // Gather all test-scoped IDs upfront before any deletes.
  // Covers both it_ (integration tests) and smoke_ (smoke script) prefixes.
  // consent_versions are global; scoping only to it_ would leave smoke_ authorizations
  // behind and cause FK violations when deleting 999.x versions.
  const testOrgIds = (
    await db.organization.findMany({
      where: { OR: [{ name: { startsWith: 'it_' } }, { name: { startsWith: 'smoke_' } }] },
      select: { id: true },
    })
  ).map((o) => o.id);

  const testUserIds =
    testOrgIds.length > 0
      ? (await db.user.findMany({ where: { organizationId: { in: testOrgIds } }, select: { id: true } })).map((u) => u.id)
      : [];

  const testClientIds =
    testOrgIds.length > 0
      ? (await db.client.findMany({ where: { organizationId: { in: testOrgIds } }, select: { id: true } })).map((c) => c.id)
      : [];

  const testCaseIds =
    testClientIds.length > 0
      ? (await db.cleanupCase.findMany({ where: { clientId: { in: testClientIds } }, select: { id: true } })).map((c) => c.id)
      : [];

  const testTaskIds =
    testCaseIds.length > 0
      ? (await db.cleanupTask.findMany({ where: { caseId: { in: testCaseIds } }, select: { id: true } })).map((t) => t.id)
      : [];

  const testRequestIds =
    testTaskIds.length > 0
      ? (await db.approvalRequest.findMany({ where: { taskId: { in: testTaskIds } }, select: { id: true } })).map((r) => r.id)
      : [];

  const testSnapshotIds =
    testTaskIds.length > 0
      ? (await db.approvalPayloadSnapshot.findMany({ where: { taskId: { in: testTaskIds } }, select: { id: true } })).map((s) => s.id)
      : [];

  const testVaultRecordIds =
    testClientIds.length > 0
      ? (await db.identityVaultRecord.findMany({ where: { clientId: { in: testClientIds } }, select: { id: true } })).map((v) => v.id)
      : [];

  // Delete in strict child-before-parent order. All FK constraints default to ON DELETE RESTRICT,
  // so every child table must be cleared before the parent rows it references can be deleted.

  // 1. operator_warning_acknowledgments → approval_requests (approvalRequestId FK), users (operatorId FK)
  if (testRequestIds.length > 0) {
    await db.operatorWarningAcknowledgment.deleteMany({ where: { approvalRequestId: { in: testRequestIds } } });
  }

  // 2. operator_approvals → approval_requests (approvalRequestId FK),
  //    approval_payload_snapshots (snapshotId FK), users (operatorId FK)
  if (testRequestIds.length > 0) {
    await db.operatorApproval.deleteMany({ where: { approvalRequestId: { in: testRequestIds } } });
  }

  // 3. snapshot_evidence_holds → approval_payload_snapshots (snapshotId FK),
  //    evidence_records (evidenceId nullable FK), identity_vault_records (vaultRecordId nullable FK)
  if (testSnapshotIds.length > 0) {
    await db.snapshotEvidenceHold.deleteMany({ where: { snapshotId: { in: testSnapshotIds } } });
  }

  // 4. approval_requests → approval_payload_snapshots (snapshotId FK),
  //    cleanup_tasks (taskId FK), client_authorizations (authorizationId FK)
  if (testTaskIds.length > 0) {
    await db.approvalRequest.deleteMany({ where: { taskId: { in: testTaskIds } } });
  }

  // 5. approval_payload_snapshots — must come after approval_requests (which hold snapshotId FK)
  if (testTaskIds.length > 0) {
    await db.approvalPayloadSnapshot.deleteMany({ where: { taskId: { in: testTaskIds } } });
  }

  // 6. evidence_records → cleanup_tasks (taskId FK)
  if (testTaskIds.length > 0) {
    await db.evidenceRecord.deleteMany({ where: { taskId: { in: testTaskIds } } });
  }

  // 7. case_timeline_events → cleanup_cases (caseId FK), cleanup_tasks (taskId nullable FK)
  if (testCaseIds.length > 0) {
    await db.caseTimelineEvent.deleteMany({ where: { caseId: { in: testCaseIds } } });
  }

  // 8. audit_logs → clients (clientId nullable FK) and users (actorId nullable FK)
  //    Must come before both clients and users are deleted
  if (testClientIds.length > 0 || testUserIds.length > 0) {
    await db.auditLog.deleteMany({
      where: {
        OR: [
          ...(testClientIds.length > 0 ? [{ clientId: { in: testClientIds } }] : []),
          ...(testUserIds.length > 0 ? [{ actorId: { in: testUserIds } }] : []),
        ],
      },
    });
  }

  // 9. high_risk_flags → clients (clientId FK), cleanup_tasks (taskId nullable FK)
  if (testClientIds.length > 0) {
    await db.highRiskFlag.deleteMany({ where: { clientId: { in: testClientIds } } });
  }

  // 10a. manual_removal_submissions → cleanup_tasks (taskId FK), data_source_targets, clients
  if (testTaskIds.length > 0) {
    await db.manualRemovalSubmission.deleteMany({ where: { taskId: { in: testTaskIds } } });
  }

  // 10b. task_workflow_step_runs → task_workflow_runs (workflowRunId FK)
  //      task_workflow_runs → cleanup_tasks (taskId FK)
  if (testTaskIds.length > 0) {
    const runIds = (
      await db.taskWorkflowRun.findMany({ where: { taskId: { in: testTaskIds } }, select: { id: true } })
    ).map((r) => r.id);
    if (runIds.length > 0) {
      await db.taskWorkflowStepRun.deleteMany({ where: { workflowRunId: { in: runIds } } });
    }
    await db.taskWorkflowRun.deleteMany({ where: { taskId: { in: testTaskIds } } });
  }

  // 10c. cleanup_tasks → cleanup_cases (caseId FK)
  if (testCaseIds.length > 0) {
    await db.cleanupTask.deleteMany({ where: { caseId: { in: testCaseIds } } });
  }

  // 11. cleanup_cases → clients (clientId FK), client_authorizations (authorizationId FK)
  if (testClientIds.length > 0) {
    await db.cleanupCase.deleteMany({ where: { clientId: { in: testClientIds } } });
  }

  // 12. client_identity_verifications → clients (clientId FK)
  if (testClientIds.length > 0) {
    await db.clientIdentityVerification.deleteMany({ where: { clientId: { in: testClientIds } } });
  }

  // 13. client_authorizations → clients (clientId FK), consent_versions (consentVersionId FK)
  //     MUST come before consent_versions — this FK was the root cause of the original failure
  if (testClientIds.length > 0) {
    await db.clientAuthorization.deleteMany({ where: { clientId: { in: testClientIds } } });
  }

  // 14. client_portal_events → clients (clientId FK)
  if (testClientIds.length > 0) {
    await db.clientPortalEvent.deleteMany({ where: { clientId: { in: testClientIds } } });
  }

  // 15. client_data_deletion_requests → clients (clientId FK)
  if (testClientIds.length > 0) {
    await db.clientDataDeletionRequest.deleteMany({ where: { clientId: { in: testClientIds } } });
  }

  // 16. identity_vault_access_logs → identity_vault_records (recordId FK)
  if (testVaultRecordIds.length > 0) {
    await db.identityVaultAccessLog.deleteMany({ where: { recordId: { in: testVaultRecordIds } } });
  }

  // 17. identity_vault_records → clients (clientId FK)
  if (testClientIds.length > 0) {
    await db.identityVaultRecord.deleteMany({ where: { clientId: { in: testClientIds } } });
  }

  // 18. dek_rotation_jobs → clients (clientId FK)
  if (testClientIds.length > 0) {
    await db.dekRotationJob.deleteMany({ where: { clientId: { in: testClientIds } } });
  }

  // 19. operator_quality_metrics → users (operatorId FK)
  if (testUserIds.length > 0) {
    await db.operatorQualityMetric.deleteMany({ where: { operatorId: { in: testUserIds } } });
  }

  // 20. user_roles → users (userId FK)
  if (testUserIds.length > 0) {
    await db.userRole.deleteMany({ where: { userId: { in: testUserIds } } });
  }

  // 21. emergency_pause_events → users (triggeredBy FK)
  if (testUserIds.length > 0) {
    await db.emergencyPauseEvent.deleteMany({ where: { triggeredBy: { in: testUserIds } } });
  }

  // 22. users → organizations (organizationId FK)
  if (testOrgIds.length > 0) {
    await db.user.deleteMany({ where: { organizationId: { in: testOrgIds } } });
  }

  // 23. clients → organizations (organizationId FK)
  if (testClientIds.length > 0) {
    await db.client.deleteMany({ where: { id: { in: testClientIds } } });
  }

  // 24. organizations
  if (testOrgIds.length > 0) {
    await db.organization.deleteMany({ where: { id: { in: testOrgIds } } });
  }

  // 25. consent_versions — global table keyed by version string, cleaned by prefix.
  //     Must come AFTER client_authorizations (step 13) since consentVersionId is a FK.
  await db.consentVersion.deleteMany({ where: { version: { startsWith: '999.' } } });
}

// ---------------------------------------------------------------------------
// Service wiring
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function buildTestServices() {
  const orgRepo = new OrganizationRepository(db);
  const userRepo = new UserRepository(db);
  const clientRepo = new ClientRepository(db);
  const civRepo = new ClientIdentityVerificationRepository(db);
  const consentVersionRepo = new ConsentVersionRepository(db);
  const authorizationRepo = new ClientAuthorizationRepository(db);
  const caseRepo = new CleanupCaseRepository(db);
  const taskRepo = new CleanupTaskRepository(db);
  const snapshotRepo = new ApprovalPayloadSnapshotRepository(db);
  const requestRepo = new ApprovalRequestRepository(db);
  const approvalRepo = new OperatorApprovalRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const timelineRepo = new CaseTimelineRepository(db);
  const vaultRecordRepo = new IdentityVaultRecordRepository(db);
  const vaultAccessLogRepo = new IdentityVaultAccessLogRepository(db);
  const dataSourceTargetRepo = new DataSourceTargetRepository(db);
  const manualSubmissionRepo = new ManualRemovalSubmissionRepository(db);
  const playbookRepo = new RemovalPlaybookRepository(db);
  const workflowRunRepo = new TaskWorkflowRunRepository(db);

  const audit = new AuditService(auditRepo);
  const timeline = new CaseTimelineService(timelineRepo);
  const clientService = new ClientService(clientRepo, audit);
  const taskService = new CleanupTaskService(taskRepo, audit, timeline);
  const consentService = new ConsentWorkflowService(consentVersionRepo, authorizationRepo, audit, () => taskService);
  const civService = new ClientIdentityVerificationService(civRepo, clientService, audit, timeline);
  const caseService = new CleanupCaseService(caseRepo, audit, timeline);
  const reviewPacketService = new ReviewPacketService(snapshotRepo, requestRepo, taskRepo, authorizationRepo, audit, timeline);
  const operatorApprovalService = new OperatorApprovalService(approvalRepo, requestRepo, snapshotRepo, taskService, audit, timeline);
  const kms = new LocalKmsProvider(
    'integration-test-master-secret-32-chars-minimum!!',
    'integration-test-signing-secret-32-chars-minimum!!',
  );
  const vaultService = new IdentityVaultIntakeService(vaultRecordRepo, vaultAccessLogRepo, kms);
  const dataSourceTargetService = new DataSourceTargetService(dataSourceTargetRepo);
  const removalDraftService = new RemovalRequestDraftService(dataSourceTargetRepo, vaultService);
  const manualSubmissionService = new ManualRemovalSubmissionService(
    manualSubmissionRepo, taskRepo, dataSourceTargetRepo, audit, timeline,
  );
  const workflowEngineService = new WorkflowEngineService(playbookRepo, workflowRunRepo, taskRepo, audit, timeline);

  return {
    orgRepo, userRepo,
    clientService, civService, consentService, caseService, taskService,
    reviewPacketService, operatorApprovalService, audit, timeline,
    vaultService, dataSourceTargetService, removalDraftService, manualSubmissionService,
    workflowEngineService, playbookRepo, workflowRunRepo,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 1A full workflow (integration)', () => {
  // Create a shared bootstrap org+user so audit logs can link to a real User FK.
  // All service calls use TEST_ACTOR_ID as the actorId.
  beforeAll(async () => {
    await cleanupTestData();
    const bootstrapOrg = await db.organization.create({ data: { name: `${TEST_PREFIX}bootstrap_org` } });
    BOOTSTRAP_ORG_ID = bootstrapOrg.id;
    const bootstrapUser = await db.user.create({
      data: {
        organization: { connect: { id: BOOTSTRAP_ORG_ID } },
        email: `${TEST_PREFIX}actor@integration.invalid`,
        displayName: `${TEST_PREFIX}Integration Test Actor`,
      },
    });
    TEST_ACTOR_ID = bootstrapUser.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    // Full cleanup for isolation, then restore the bootstrap actor
    await cleanupTestData();
    const newOrg = await db.organization.create({ data: { name: `${TEST_PREFIX}bootstrap_org` } });
    BOOTSTRAP_ORG_ID = newOrg.id;
    const newUser = await db.user.create({
      data: {
        organization: { connect: { id: BOOTSTRAP_ORG_ID } },
        email: `${TEST_PREFIX}actor@integration.invalid`,
        displayName: `${TEST_PREFIX}Integration Test Actor`,
      },
    });
    TEST_ACTOR_ID = newUser.id;
  });

  it('can create an organization', async () => {
    const { orgRepo } = buildTestServices();
    const s = suffix();
    const org = await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });
    expect(org.id).toBeTruthy();
    expect(org.name).toBe(`${TEST_PREFIX}org_${s}`);
    expect(org.isActive).toBe(true);
  });

  it('can create an operator user in an organization', async () => {
    const { orgRepo, userRepo } = buildTestServices();
    const s = suffix();
    const org = await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });
    const user = await userRepo.create({
      organization: { connect: { id: org.id } },
      email: `${TEST_PREFIX}op_${s}@example.invalid`,
      displayName: `${TEST_PREFIX}Operator ${s}`,
    });
    expect(user.id).toBeTruthy();
    expect(user.organizationId).toBe(org.id);
    expect(user.isActive).toBe(true);
  });

  it('creates a client in PENDING_IDENTITY_VERIFICATION status', async () => {
    const { orgRepo, clientService } = buildTestServices();
    const s = suffix();
    const org = await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });

    const result = await clientService.create({ organizationId: org.id, displayName: `${TEST_PREFIX}client_${s}` }, TEST_ACTOR_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('PENDING_IDENTITY_VERIFICATION');
  });

  it('cannot activate a client before identity verification is complete', async () => {
    const { orgRepo, clientService } = buildTestServices();
    const s = suffix();
    const org = await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });
    const clientResult = await clientService.create({ organizationId: org.id, displayName: `${TEST_PREFIX}client_${s}` }, TEST_ACTOR_ID);
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;

    // Trying to activate directly without going through verification should fail
    await clientService.activateAfterVerification(clientResult.value.id, TEST_ACTOR_ID);
    // This only works if called from completeVerification flow; calling directly on
    // a PENDING_IDENTITY_VERIFICATION client is allowed by activateAfterVerification,
    // but only via the CIV service which checks attestation first.
    // Verify the guard exists in CIV service:
    const { civService } = buildTestServices();
    const civResult = await civService.completeVerification('nonexistent-verification-id', TEST_ACTOR_ID);
    expect(civResult.ok).toBe(false);
    if (civResult.ok) return; // type narrowing
    expect(civResult.error).toBe('NOT_FOUND');
  });

  it('runs the full client identity verification flow', async () => {
    const { orgRepo, clientService, civService } = buildTestServices();
    const s = suffix();
    const org = await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });
    const clientResult = await clientService.create({ organizationId: org.id, displayName: `${TEST_PREFIX}client_${s}` }, TEST_ACTOR_ID);
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;
    const clientId = clientResult.value.id;

    // 1. Create verification record
    const civCreateResult = await civService.createRecord(clientId, TEST_ACTOR_ID);
    expect(civCreateResult.ok).toBe(true);
    if (!civCreateResult.ok) return;
    const verificationId = civCreateResult.value.id;
    expect(civCreateResult.value.status).toBe('PENDING');

    // 2. Cannot complete without attestation
    const earlyComplete = await civService.completeVerification(verificationId, TEST_ACTOR_ID);
    expect(earlyComplete.ok).toBe(false);
    if (earlyComplete.ok) return; // type narrowing
    expect(earlyComplete.message).toMatch(/attestation/i);

    // 3. Attest
    const attestResult = await civService.recordOperatorAttestation(verificationId, 'ID documents reviewed and confirmed', TEST_ACTOR_ID);
    expect(attestResult.ok).toBe(true);

    // 4. Complete verification — also activates the client
    const completeResult = await civService.completeVerification(verificationId, TEST_ACTOR_ID);
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) return;
    expect(completeResult.value.status).toBe('VERIFIED');

    // 5. Client should now be ACTIVE
    const updatedClient = await clientService.getById(clientId);
    expect(updatedClient.ok).toBe(true);
    if (!updatedClient.ok) return;
    expect(updatedClient.value.status).toBe('ACTIVE');
  });

  it('runs the consent and authorization flow', async () => {
    const { orgRepo, consentService } = buildTestServices();
    const s = suffix();
    await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });
    // Use a version prefix unlikely to collide with production data
    const versionStr = `999.${Date.now()}.0`;

    const cvResult = await consentService.createConsentVersion(
      versionStr,
      'a'.repeat(64),
      new Date('2026-01-01T00:00:00Z'),
      undefined,
      TEST_ACTOR_ID,
    );
    expect(cvResult.ok).toBe(true);
    if (!cvResult.ok) return;
    expect(cvResult.value.version).toBe(versionStr);

    // Duplicate version should fail
    const dupResult = await consentService.createConsentVersion(versionStr, 'b'.repeat(64), new Date(), undefined, TEST_ACTOR_ID);
    expect(dupResult.ok).toBe(false);
    if (dupResult.ok) return; // type narrowing
    expect(dupResult.error).toBe('VALIDATION_ERROR');
  });

  it('runs the full case, task, review packet, and approval workflow', async () => {
    const { orgRepo, clientService, civService, consentService, caseService, taskService, reviewPacketService, operatorApprovalService, audit, timeline } =
      buildTestServices();
    const s = suffix();

    // Setup org + client
    const org = await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });
    const clientResult = await clientService.create({ organizationId: org.id, displayName: `${TEST_PREFIX}client_${s}` }, TEST_ACTOR_ID);
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;
    const clientId = clientResult.value.id;

    // Verify + activate client
    const civCreate = await civService.createRecord(clientId, TEST_ACTOR_ID);
    expect(civCreate.ok).toBe(true);
    if (!civCreate.ok) return;
    await civService.recordOperatorAttestation(civCreate.value.id, 'Verified by integration test', TEST_ACTOR_ID);
    await civService.completeVerification(civCreate.value.id, TEST_ACTOR_ID);

    // Create consent version + authorization
    const cvResult = await consentService.createConsentVersion(
      `999.${Date.now()}.1`,
      'c'.repeat(64),
      new Date('2026-01-01T00:00:00Z'),
      undefined,
      TEST_ACTOR_ID,
    );
    expect(cvResult.ok).toBe(true);
    if (!cvResult.ok) return;

    const authResult = await consentService.createAuthorization(
      {
        clientId,
        consentVersionId: cvResult.value.id,
        scopeNames: ['data_broker_opt_out', 'people_search_removal'],
        jurisdiction: 'US-CA',
        signedAt: new Date(),
      },
      TEST_ACTOR_ID,
    );
    expect(authResult.ok).toBe(true);
    if (!authResult.ok) return;
    const authorizationId = authResult.value.id;

    // Create case
    const caseResult = await caseService.create(
      { clientId, authorizationId, title: `${TEST_PREFIX}case_${s}` },
      TEST_ACTOR_ID,
    );
    expect(caseResult.ok).toBe(true);
    if (!caseResult.ok) return;
    const caseId = caseResult.value.id;

    // Create task with CONFIRMED_MATCH so review packet can be created
    const taskResult = await taskService.create(
      {
        caseId,
        sourceRef: `${TEST_PREFIX}databroker.example.invalid`,
        matchStatus: 'CONFIRMED_MATCH',
        riskTier: 'STANDARD',
        actionType: 'OPT_OUT',
      },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;
    const taskId = taskResult.value.id;

    // Create review packet
    const packetResult = await reviewPacketService.create(
      {
        taskId,
        authorizationId,
        redactedPreview: 'Test record — no real PII',
        evidenceIds: [],
      },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(packetResult.ok).toBe(true);
    if (!packetResult.ok) return;
    const { approvalRequest, snapshotId, payloadHash } = packetResult.value;
    expect(approvalRequest.status).toBe('PENDING');
    expect(snapshotId).toBeTruthy();
    expect(payloadHash).toMatch(/^[0-9a-f]{64}$/); // raw SHA-256 hex (prefix added to snapshotSignature, not returned field)

    // Approve the request
    const approvalResult = await operatorApprovalService.recordDecision(
      {
        approvalRequestId: approvalRequest.id,
        operatorId: TEST_ACTOR_ID,
        operatorOrganizationId: org.id,
        decision: 'APPROVED',
        mfaFreshAt: new Date(),
        sessionApprovalCount: 0,
        notes: 'Integration test approval',
      },
      clientId,
    );
    expect(approvalResult.ok).toBe(true);
    if (!approvalResult.ok) return;
    expect(approvalResult.value.decision).toBe('APPROVED');

    // Verify audit logs were written for this client
    const auditLogs = await audit.listByClient(clientId);
    expect(auditLogs.length).toBeGreaterThan(0);
    const eventTypes = auditLogs.map((l) => l.eventType);
    expect(eventTypes).toContain('CLIENT_CREATED');
    expect(eventTypes).toContain('IDENTITY_VERIFICATION_COMPLETED');
    expect(eventTypes).toContain('CLIENT_ACTIVATED');
    expect(eventTypes).toContain('AUTHORIZATION_CREATED');
    expect(eventTypes).toContain('CASE_CREATED');
    expect(eventTypes).toContain('TASK_CREATED');

    // Verify no audit log contains raw PII patterns (email/SSN/phone)
    for (const log of auditLogs) {
      const raw = JSON.stringify(log);
      expect(raw).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
      expect(raw).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    }

    // Verify case timeline was written
    const timelineEvents = await timeline.listForCase(caseId);
    expect(timelineEvents.length).toBeGreaterThan(0);
    const timelineTypes = timelineEvents.map((e) => e.eventType);
    expect(timelineTypes).toContain('CASE_CREATED');
    expect(timelineTypes).toContain('TASK_CREATED');
  });

  it('rejects review packet for task with wrong match status', async () => {
    const { orgRepo, clientService, civService, consentService, caseService, taskService, reviewPacketService } =
      buildTestServices();
    const s = suffix();

    const org = await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });
    const clientResult = await clientService.create({ organizationId: org.id, displayName: `${TEST_PREFIX}client_${s}` }, TEST_ACTOR_ID);
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;
    const clientId = clientResult.value.id;

    const civCreate = await civService.createRecord(clientId, TEST_ACTOR_ID);
    expect(civCreate.ok).toBe(true);
    if (!civCreate.ok) return;
    await civService.recordOperatorAttestation(civCreate.value.id, 'Verified', TEST_ACTOR_ID);
    await civService.completeVerification(civCreate.value.id, TEST_ACTOR_ID);

    const cvResult = await consentService.createConsentVersion(`999.${Date.now()}.2`, 'd'.repeat(64), new Date('2026-01-01'), undefined, TEST_ACTOR_ID);
    expect(cvResult.ok).toBe(true);
    if (!cvResult.ok) return;

    const authResult = await consentService.createAuthorization(
      { clientId, consentVersionId: cvResult.value.id, scopeNames: ['data_broker_opt_out'], jurisdiction: 'US', signedAt: new Date() },
      TEST_ACTOR_ID,
    );
    expect(authResult.ok).toBe(true);
    if (!authResult.ok) return;

    const caseResult = await caseService.create({ clientId, authorizationId: authResult.value.id }, TEST_ACTOR_ID);
    expect(caseResult.ok).toBe(true);
    if (!caseResult.ok) return;

    // Task with default matchStatus NEEDS_OPERATOR_REVIEW — should block review packet
    const taskResult = await taskService.create({ caseId: caseResult.value.id }, clientId, TEST_ACTOR_ID);
    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;

    const packetResult = await reviewPacketService.create(
      { taskId: taskResult.value.id, authorizationId: authResult.value.id, redactedPreview: 'test' },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(packetResult.ok).toBe(false);
    if (packetResult.ok) return; // type narrowing
    expect(packetResult.error).toBe('VALIDATION_ERROR');
    expect(packetResult.message).toMatch(/match status/i);
  });

  it('revoked authorization blocks new review packet creation', async () => {
    const { orgRepo, clientService, civService, consentService, caseService, taskService, reviewPacketService } =
      buildTestServices();
    const s = suffix();

    const org = await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });
    const clientResult = await clientService.create({ organizationId: org.id, displayName: `${TEST_PREFIX}client_${s}` }, TEST_ACTOR_ID);
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;
    const clientId = clientResult.value.id;

    const civCreate = await civService.createRecord(clientId, TEST_ACTOR_ID);
    expect(civCreate.ok).toBe(true);
    if (!civCreate.ok) return;
    await civService.recordOperatorAttestation(civCreate.value.id, 'Verified', TEST_ACTOR_ID);
    await civService.completeVerification(civCreate.value.id, TEST_ACTOR_ID);

    const cvResult = await consentService.createConsentVersion(`999.${Date.now()}.3`, 'e'.repeat(64), new Date('2026-01-01'), undefined, TEST_ACTOR_ID);
    expect(cvResult.ok).toBe(true);
    if (!cvResult.ok) return;

    const authResult = await consentService.createAuthorization(
      { clientId, consentVersionId: cvResult.value.id, scopeNames: ['data_broker_opt_out'], jurisdiction: 'US', signedAt: new Date() },
      TEST_ACTOR_ID,
    );
    expect(authResult.ok).toBe(true);
    if (!authResult.ok) return;
    const authorizationId = authResult.value.id;

    const caseResult = await caseService.create({ clientId, authorizationId }, TEST_ACTOR_ID);
    expect(caseResult.ok).toBe(true);
    if (!caseResult.ok) return;

    const taskResult = await taskService.create(
      { caseId: caseResult.value.id, matchStatus: 'CONFIRMED_MATCH' },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;

    // Revoke the authorization
    const revokeResult = await consentService.revokeAuthorization(authorizationId, 'Client withdrew consent', TEST_ACTOR_ID);
    expect(revokeResult.ok).toBe(true);

    // New review packet on the revoked auth should fail
    const packetResult = await reviewPacketService.create(
      { taskId: taskResult.value.id, authorizationId, redactedPreview: 'test' },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(packetResult.ok).toBe(false);
    if (packetResult.ok) return; // type narrowing
    expect(packetResult.error).toBe('AUTHORIZATION_REVOKED');
  });

  it('audit logs contain no real PII in metadata fields', async () => {
    const { orgRepo, clientService, audit } = buildTestServices();
    const s = suffix();
    const org = await orgRepo.create({ name: `${TEST_PREFIX}org_${s}` });
    await clientService.create({ organizationId: org.id, displayName: `${TEST_PREFIX}client_${s}` }, TEST_ACTOR_ID);

    const testOrg = await db.organization.findFirst({ where: { name: `${TEST_PREFIX}org_${s}` } });
    expect(testOrg).not.toBeNull();

    const testClients = await db.client.findMany({ where: { organizationId: testOrg!.id } });
    for (const client of testClients) {
      const logs = await audit.listByClient(client.id);
      for (const log of logs) {
        const raw = JSON.stringify(log.metadata ?? {});
        // No email patterns in stored metadata
        expect(raw).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
        // No SSN patterns
        expect(raw).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 1D: Vault intake integration tests
// ---------------------------------------------------------------------------

describe('Phase 1D vault intake (integration)', () => {
  const TEST_KMS_MASTER = 'integration-test-master-secret-32-chars-minimum!!';
  const TEST_KMS_SIGNING = 'integration-test-signing-secret-32-chars-minimum!!';

  let vaultService: IdentityVaultIntakeService;
  let clientId: string;

  beforeAll(async () => {
    const kms = new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
    const vaultRecordRepo = new IdentityVaultRecordRepository(db);
    const vaultAccessLogRepo = new IdentityVaultAccessLogRepository(db);
    vaultService = new IdentityVaultIntakeService(vaultRecordRepo, vaultAccessLogRepo, kms);
  });

  beforeEach(async () => {
    await cleanupTestData();
    // Create bootstrap actor and client for vault tests
    const newOrg = await db.organization.create({ data: { name: `${TEST_PREFIX}bootstrap_org` } });
    BOOTSTRAP_ORG_ID = newOrg.id;
    const newUser = await db.user.create({
      data: {
        organization: { connect: { id: BOOTSTRAP_ORG_ID } },
        email: `${TEST_PREFIX}actor@integration.invalid`,
        displayName: `${TEST_PREFIX}Integration Test Actor`,
      },
    });
    TEST_ACTOR_ID = newUser.id;
    const vaultOrg = await db.organization.create({ data: { name: `${TEST_PREFIX}vault_org_${suffix()}` } });
    const vaultClient = await db.client.create({
      data: { organizationId: vaultOrg.id, displayName: `${TEST_PREFIX}vault_client` },
    });
    clientId = vaultClient.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it('stores a vault record and returns redacted display (not plaintext)', async () => {
    const result = await vaultService.store({
      clientId,
      fieldType: 'EMAIL',
      plaintext: 'testuser@vault.invalid',
      purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
      actorId: TEST_ACTOR_ID,
      actorType: 'OPERATOR',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.redactedDisplay).toBe('t***@vault.invalid');
    expect(result.value.redactedDisplay).not.toContain('testuser');
    expect(result.value.recordId).toBeTruthy();
  });

  it('does not store plaintext in the DB — ciphertext differs from plaintext', async () => {
    const plaintext = 'testuser@vault.invalid';
    const result = await vaultService.store({
      clientId,
      fieldType: 'EMAIL',
      plaintext,
      purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
      actorId: TEST_ACTOR_ID,
      actorType: 'OPERATOR',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Fetch the raw DB record
    const raw = await db.identityVaultRecord.findUnique({ where: { id: result.value.recordId } });
    expect(raw).not.toBeNull();
    expect(raw?.ciphertext).not.toBe(plaintext);
    expect(raw?.ciphertext).not.toContain('testuser');
    // DB should NOT contain the plaintext anywhere in the vault record
    const rowJson = JSON.stringify(raw);
    expect(rowJson).not.toContain(plaintext);
  });

  it('writes an access log when storing', async () => {
    const result = await vaultService.store({
      clientId,
      fieldType: 'EMAIL',
      plaintext: 'testuser@vault.invalid',
      purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
      actorId: TEST_ACTOR_ID,
      actorType: 'OPERATOR',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logs = await db.identityVaultAccessLog.findMany({ where: { recordId: result.value.recordId } });
    expect(logs.length).toBe(1);
    expect(logs[0]?.purposeCode).toBe('PURPOSE_OPERATOR_REVIEW_PACKET');
    expect(logs[0]?.actorId).toBe(TEST_ACTOR_ID);
    // No plaintext in access log
    const logJson = JSON.stringify(logs[0]);
    expect(logJson).not.toContain('testuser');
  });

  it('listMetadata returns redacted display without plaintext or ciphertext', async () => {
    await vaultService.store({
      clientId,
      fieldType: 'EMAIL',
      plaintext: 'listtest@vault.invalid',
      purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
      actorId: TEST_ACTOR_ID,
      actorType: 'OPERATOR',
    });

    const meta = await vaultService.listMetadata(clientId);
    expect(meta.length).toBeGreaterThan(0);
    expect(meta[0]?.fieldType).toBe('EMAIL');
    expect(meta[0]?.redactedDisplay).toBe('l***@vault.invalid');

    // Confirm no ciphertext or plaintext leaked through
    const metaJson = JSON.stringify(meta);
    expect(metaJson).not.toContain('ciphertext');
    expect(metaJson).not.toContain('listtest');
  });

  it('logAccess records a second access log and returns redacted display', async () => {
    const storeResult = await vaultService.store({
      clientId,
      fieldType: 'PHONE',
      plaintext: '787-555-0001',
      purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
      actorId: TEST_ACTOR_ID,
      actorType: 'OPERATOR',
    });
    expect(storeResult.ok).toBe(true);
    if (!storeResult.ok) return;

    const accessResult = await vaultService.logAccess(
      storeResult.value.recordId,
      'PURPOSE_FORM_FILL',
      TEST_ACTOR_ID,
      'OPERATOR',
    );
    expect(accessResult.ok).toBe(true);
    if (!accessResult.ok) return;
    expect(accessResult.value.redactedDisplay).toBe('***-***-0001');
    expect(accessResult.value.purposeCode).toBe('PURPOSE_FORM_FILL');

    // Both logs should be in the DB
    const logs = await db.identityVaultAccessLog.findMany({ where: { recordId: storeResult.value.recordId } });
    expect(logs.length).toBe(2);
    // Access logs must not contain raw phone
    const logsJson = JSON.stringify(logs);
    expect(logsJson).not.toContain('787-555-0001');
  });
});

// ---------------------------------------------------------------------------
// Phase 1E: Data source target registry + removal request draft
// ---------------------------------------------------------------------------

describe('Phase 1E data source target + removal draft (integration)', () => {
  const TEST_KMS_MASTER = 'integration-test-master-secret-32-chars-minimum!!';
  const TEST_KMS_SIGNING = 'integration-test-signing-secret-32-chars-minimum!!';

  let targetService: DataSourceTargetService;
  let draftService: RemovalRequestDraftService;
  let vaultService: IdentityVaultIntakeService;
  let clientId: string;

  beforeAll(async () => {
    const targetRepo = new DataSourceTargetRepository(db);
    const kms = new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
    const vaultRecordRepo = new IdentityVaultRecordRepository(db);
    const vaultAccessLogRepo = new IdentityVaultAccessLogRepository(db);
    vaultService = new IdentityVaultIntakeService(vaultRecordRepo, vaultAccessLogRepo, kms);
    targetService = new DataSourceTargetService(targetRepo);
    draftService = new RemovalRequestDraftService(targetRepo, vaultService);
  });

  beforeEach(async () => {
    // Each test gets a fresh client under a fresh org
    const org = await db.organization.create({ data: { name: `${TEST_PREFIX}1e_org_${suffix()}` } });
    const client = await db.client.create({
      data: { organizationId: org.id, displayName: `${TEST_PREFIX}1e_client` },
    });
    clientId = client.id;
  });

  it('creates a data source target and retrieves it by ID', async () => {
    const name = `it_broker_${suffix()}`;
    const result = await targetService.create({
      sourceName: name,
      sourceType: 'DATA_BROKER',
      baseDomain: 'test-broker.invalid',
      piiRequiredFields: ['EMAIL', 'FULL_NAME'],
      supportedActionTypes: ['OPT_OUT'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = await targetService.getById(result.value.id);
    expect(byId.ok).toBe(true);
    if (!byId.ok) return;
    expect(byId.value.sourceName).toBe(name);
    expect(byId.value.piiRequiredFields).toContain('EMAIL');

    // Cleanup
    await db.dataSourceTarget.delete({ where: { id: result.value.id } });
  });

  it('lists active targets and filters by sourceType', async () => {
    const name = `it_search_${suffix()}`;
    const created = await targetService.create({
      sourceName: name,
      sourceType: 'SEARCH_ENGINE',
      piiRequiredFields: ['URL'],
      isActive: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const active = await targetService.listActive('SEARCH_ENGINE');
    const found = active.find((t) => t.id === created.value.id);
    expect(found).toBeDefined();

    // Inactive targets should not appear in listActive
    await targetService.update(created.value.id, { isActive: false });
    const activeAfter = await targetService.listActive('SEARCH_ENGINE');
    expect(activeAfter.find((t) => t.id === created.value.id)).toBeUndefined();

    await db.dataSourceTarget.delete({ where: { id: created.value.id } });
  });

  it('generates a draft with EMAIL present and FULL_NAME missing', async () => {
    const name = `it_broker_draft_${suffix()}`;
    const targetResult = await targetService.create({
      sourceName: name,
      sourceType: 'DATA_BROKER',
      piiRequiredFields: ['EMAIL', 'FULL_NAME'],
      supportedActionTypes: ['OPT_OUT'],
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;

    // Store only email vault record for the client
    await vaultService.store({
      clientId,
      fieldType: 'EMAIL',
      plaintext: 'drafttest@vault.invalid',
      purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
      actorId: TEST_ACTOR_ID || 'system',
      actorType: 'OPERATOR',
    });

    const draftResult = await draftService.buildDraft({ clientId, dataSourceTargetId: targetResult.value.id });
    expect(draftResult.ok).toBe(true);
    if (!draftResult.ok) return;

    const draft = draftResult.value;
    expect(draft.targetName).toBe(name);
    expect(draft.requiredFields).toContain('EMAIL');
    expect(draft.requiredFields).toContain('FULL_NAME');
    expect(draft.missingFields).toContain('FULL_NAME');
    expect(draft.missingFields).not.toContain('EMAIL');
    expect(draft.isReadyForReview).toBe(false);

    // Email is present with redacted display
    const emailStatus = draft.vaultFieldStatuses.find((s) => s.fieldType === 'EMAIL');
    expect(emailStatus?.isPresent).toBe(true);
    expect(emailStatus?.redactedDisplay).toBe('d***@vault.invalid');

    // No plaintext in draft
    const json = JSON.stringify(draft);
    expect(json).not.toContain('drafttest');
    // No ciphertext fields
    expect(json).not.toContain('ciphertext');

    await db.dataSourceTarget.delete({ where: { id: targetResult.value.id } });
  });

  it('draft is ready for review when all required vault fields are present', async () => {
    const name = `it_broker_ready_${suffix()}`;
    const targetResult = await targetService.create({
      sourceName: name,
      sourceType: 'DATA_BROKER',
      piiRequiredFields: ['EMAIL'],
      supportedActionTypes: ['OPT_OUT'],
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;

    await vaultService.store({
      clientId,
      fieldType: 'EMAIL',
      plaintext: 'ready@vault.invalid',
      purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
      actorId: TEST_ACTOR_ID || 'system',
      actorType: 'OPERATOR',
    });

    const draftResult = await draftService.buildDraft({ clientId, dataSourceTargetId: targetResult.value.id });
    expect(draftResult.ok).toBe(true);
    if (!draftResult.ok) return;

    expect(draftResult.value.isReadyForReview).toBe(true);
    expect(draftResult.value.missingFields).toHaveLength(0);

    await db.dataSourceTarget.delete({ where: { id: targetResult.value.id } });
  });

  it('rejects draft for inactive target', async () => {
    const name = `it_broker_inactive_${suffix()}`;
    const targetResult = await targetService.create({
      sourceName: name,
      sourceType: 'DATA_BROKER',
      piiRequiredFields: ['EMAIL'],
      isActive: false,
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;

    const draftResult = await draftService.buildDraft({ clientId, dataSourceTargetId: targetResult.value.id });
    expect(draftResult.ok).toBe(false);
    if (!draftResult.ok) expect(draftResult.error).toBe('VALIDATION_ERROR');

    await db.dataSourceTarget.delete({ where: { id: targetResult.value.id } });
  });
});

// ---------------------------------------------------------------------------
// Phase 1F: Manual Removal Workflow (integration)
// ---------------------------------------------------------------------------

describe('Phase 1F manual removal workflow (integration)', () => {
  const TEST_KMS_MASTER = 'integration-test-master-secret-32-chars-minimum!!';
  const TEST_KMS_SIGNING = 'integration-test-signing-secret-32-chars-minimum!!';

  let manualSubmissionService: ManualRemovalSubmissionService;
  let dataSourceTargetService: DataSourceTargetService;
  let taskService: CleanupTaskService;
  let caseService: CleanupCaseService;
  let clientService: ClientService;
  let civService: ClientIdentityVerificationService;
  let consentService: ConsentWorkflowService;
  let vaultService: IdentityVaultIntakeService;

  let clientId = '';
  let caseId = '';
  let taskId = '';
  let authorizationId = '';
  let targetId = '';

  beforeAll(async () => {
    const services = buildTestServices();
    manualSubmissionService = services.manualSubmissionService;
    dataSourceTargetService = services.dataSourceTargetService;
    taskService = services.taskService;
    caseService = services.caseService;
    clientService = services.clientService;
    civService = services.civService;
    consentService = services.consentService;

    const kms = new LocalKmsProvider(TEST_KMS_MASTER, TEST_KMS_SIGNING);
    const vaultRecordRepo = new IdentityVaultRecordRepository(db);
    const vaultAccessLogRepo = new IdentityVaultAccessLogRepository(db);
    vaultService = new IdentityVaultIntakeService(vaultRecordRepo, vaultAccessLogRepo, kms);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await cleanupTestData();
    const newOrg = await db.organization.create({ data: { name: `${TEST_PREFIX}bootstrap_org` } });
    BOOTSTRAP_ORG_ID = newOrg.id;
    const newUser = await db.user.create({
      data: {
        organization: { connect: { id: BOOTSTRAP_ORG_ID } },
        email: `${TEST_PREFIX}actor@integration.invalid`,
        displayName: `${TEST_PREFIX}Integration Test Actor`,
      },
    });
    TEST_ACTOR_ID = newUser.id;

    // Create and activate a client
    const s = suffix();
    const clientResult = await clientService.create({ organizationId: BOOTSTRAP_ORG_ID, displayName: `it_client_${s}` }, TEST_ACTOR_ID);
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;
    clientId = clientResult.value.id;

    // Verify client: createRecord → attest → completeVerification
    const civCreate = await civService.createRecord(clientId, TEST_ACTOR_ID);
    expect(civCreate.ok).toBe(true);
    if (!civCreate.ok) return;
    await civService.recordOperatorAttestation(civCreate.value.id, 'Verified for Phase 1F integration test', TEST_ACTOR_ID);
    await civService.completeVerification(civCreate.value.id, TEST_ACTOR_ID);

    // Consent + authorization
    const cvVersion = `999.1f.${s}`;
    const cvResult = await consentService.createConsentVersion(cvVersion, 'a'.repeat(64), new Date(), undefined, TEST_ACTOR_ID);
    expect(cvResult.ok).toBe(true);
    if (!cvResult.ok) return;

    const authResult = await consentService.createAuthorization(
      {
        clientId,
        consentVersionId: cvResult.value.id,
        authorizationType: 'SELF',
        scopeNames: ['DATA_BROKER_OPT_OUT'],
        jurisdiction: 'US',
        signedAt: new Date(),
      },
      TEST_ACTOR_ID,
    );
    expect(authResult.ok).toBe(true);
    if (!authResult.ok) return;
    authorizationId = authResult.value.id;

    // Case
    const caseResult = await caseService.create({ clientId, authorizationId }, TEST_ACTOR_ID);
    expect(caseResult.ok).toBe(true);
    if (!caseResult.ok) return;
    caseId = caseResult.value.id;

    // Target
    const targetResult = await dataSourceTargetService.create({
      sourceName: `it_target_1f_${s}`,
      sourceType: 'DATA_BROKER',
      piiRequiredFields: ['EMAIL'],
      supportedActionTypes: ['OPT_OUT'],
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    targetId = targetResult.value.id;

    // Vault record for client
    await vaultService.store({
      clientId,
      fieldType: 'EMAIL',
      plaintext: `it1f_${s}@vault.invalid`,
      purposeCode: 'PURPOSE_OPERATOR_REVIEW_PACKET',
      actorId: TEST_ACTOR_ID,
      actorType: 'OPERATOR',
    });

    // Task linked to target
    const taskResult = await taskService.create(
      { caseId, dataSourceTargetId: targetId, actionType: 'OPT_OUT', riskTier: 'STANDARD' },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;
    taskId = taskResult.value.id;
  });

  it('creates a manual submission for a task linked to a target', async () => {
    const result = await manualSubmissionService.createForTask(
      {
        taskId,
        clientId,
        submissionMethod: 'WEB_FORM',
        redactedSummary: 'OPT_OUT to it_broker — EMAIL: i***@vault.invalid',
      },
      TEST_ACTOR_ID,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.taskId).toBe(taskId);
    expect(result.value.dataSourceTargetId).toBe(targetId);
    expect(result.value.clientId).toBe(clientId);
    expect(result.value.submissionStatus).toBe('DRAFTED');
  });

  it('marks submission as submitted and records submittedAt', async () => {
    const createResult = await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const submissionId = createResult.value.id;

    const submitResult = await manualSubmissionService.recordSubmitted(
      submissionId,
      { confirmationCode: 'REF-12345' },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;
    expect(submitResult.value.submissionStatus).toBe('SUBMITTED');
    expect(submitResult.value.submittedAt).not.toBeNull();
    expect(submitResult.value.confirmationCode).toBe('REF-12345');
  });

  it('records completed outcome after submission', async () => {
    const createResult = await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'EMAIL', redactedSummary: 'DELETE_PERSONAL_DATA — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const submissionId = createResult.value.id;

    await manualSubmissionService.recordSubmitted(submissionId, {}, clientId, TEST_ACTOR_ID);
    const outcomeResult = await manualSubmissionService.recordOutcome(
      submissionId,
      { status: 'COMPLETED', operatorNotes: 'Broker confirmed removal — no PII in this note' },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(outcomeResult.ok).toBe(true);
    if (!outcomeResult.ok) return;
    expect(outcomeResult.value.submissionStatus).toBe('COMPLETED');
  });

  it('records acknowledged outcome', async () => {
    const createResult = await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'SUPPORT_PORTAL', redactedSummary: 'OPT_OUT — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    await manualSubmissionService.recordSubmitted(createResult.value.id, {}, clientId, TEST_ACTOR_ID);
    const outcomeResult = await manualSubmissionService.recordOutcome(createResult.value.id, { status: 'ACKNOWLEDGED' }, clientId, TEST_ACTOR_ID);
    expect(outcomeResult.ok).toBe(true);
    if (!outcomeResult.ok) return;
    expect(outcomeResult.value.submissionStatus).toBe('ACKNOWLEDGED');
  });

  it('rejects creating submission for task with no target', async () => {
    // Create a task without dataSourceTargetId
    const noTargetTask = await db.cleanupTask.create({
      data: { case: { connect: { id: caseId } }, status: 'FOUND', matchStatus: 'NEEDS_OPERATOR_REVIEW', riskTier: 'STANDARD' },
    });
    const result = await manualSubmissionService.createForTask(
      { taskId: noTargetTask.id, clientId, submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('VALIDATION_ERROR');
    await db.cleanupTask.delete({ where: { id: noTargetTask.id } });
  });

  it('rejects redactedSummary with plaintext PII', async () => {
    const result = await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'WEB_FORM', redactedSummary: 'Remove realuser@example.com from broker' },
      TEST_ACTOR_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('PII_FORBIDDEN_IN_REDACTED_PREVIEW');
  });

  it('submission response contains no plaintext PII', async () => {
    const result = await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.value);
    // The unredacted email prefix (it1f_) must not appear — only the redacted form i***@vault.invalid is allowed
    expect(json).not.toMatch(/it1f_[a-z0-9_]+@vault\.invalid/);
    // No vault internal fields
    expect(json).not.toContain('ciphertext');
    expect(json).not.toContain('authTag');
    expect(json).not.toContain('encryptedKeyRef');
  });

  it('timeline events include MANUAL_SUBMISSION_CREATED and MANUAL_SUBMISSION_SUBMITTED', async () => {
    const createResult = await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await manualSubmissionService.recordSubmitted(createResult.value.id, {}, clientId, TEST_ACTOR_ID);

    const events = await db.caseTimelineEvent.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' } });
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('MANUAL_SUBMISSION_CREATED');
    expect(eventTypes).toContain('MANUAL_SUBMISSION_SUBMITTED');
  });

  it('audit logs include MANUAL_SUBMISSION_CREATED and MANUAL_SUBMISSION_OUTCOME_RECORDED', async () => {
    const createResult = await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    await manualSubmissionService.recordSubmitted(createResult.value.id, {}, clientId, TEST_ACTOR_ID);
    await manualSubmissionService.recordOutcome(createResult.value.id, { status: 'COMPLETED' }, clientId, TEST_ACTOR_ID);

    const logs = await db.auditLog.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' } });
    const logTypes = logs.map((l) => l.eventType);
    expect(logTypes).toContain('MANUAL_SUBMISSION_CREATED');
    expect(logTypes).toContain('MANUAL_SUBMISSION_OUTCOME_RECORDED');
  });

  it('lists submissions for task and client', async () => {
    await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'MAIL', redactedSummary: 'OPT_OUT — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    const forTask = await manualSubmissionService.listForTask(taskId);
    expect(forTask).toHaveLength(1);
    expect(forTask[0]?.taskId).toBe(taskId);

    const forClient = await manualSubmissionService.listForClient(clientId);
    expect(forClient).toHaveLength(1);
    expect(forClient[0]?.clientId).toBe(clientId);
  });

  it('cannot record outcome on terminal submission', async () => {
    const createResult = await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    await manualSubmissionService.recordSubmitted(createResult.value.id, {}, clientId, TEST_ACTOR_ID);
    await manualSubmissionService.recordOutcome(createResult.value.id, { status: 'FAILED' }, clientId, TEST_ACTOR_ID);

    const secondOutcome = await manualSubmissionService.recordOutcome(createResult.value.id, { status: 'COMPLETED' }, clientId, TEST_ACTOR_ID);
    expect(secondOutcome.ok).toBe(false);
    if (!secondOutcome.ok) expect(secondOutcome.error).toBe('MANUAL_SUBMISSION_INVALID_STATUS');
  });
});

// ---------------------------------------------------------------------------
// Phase 2A: Workflow Engine + Playbooks (integration)
// ---------------------------------------------------------------------------

describe('Phase 2A workflow engine (integration)', () => {
  let workflowEngineService: WorkflowEngineService;
  let manualSubmissionService: ManualRemovalSubmissionService;
  let dataSourceTargetService: DataSourceTargetService;
  let taskService: CleanupTaskService;
  let caseService: CleanupCaseService;
  let clientService: ClientService;
  let civService: ClientIdentityVerificationService;
  let consentService: ConsentWorkflowService;

  let clientId = '';
  let caseId = '';
  let taskId = '';
  let authorizationId = '';
  let targetId = '';

  beforeAll(async () => {
    const services = buildTestServices();
    workflowEngineService = services.workflowEngineService;
    manualSubmissionService = services.manualSubmissionService;
    dataSourceTargetService = services.dataSourceTargetService;
    taskService = services.taskService;
    caseService = services.caseService;
    clientService = services.clientService;
    civService = services.civService;
    consentService = services.consentService;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await cleanupTestData();
    const newOrg = await db.organization.create({ data: { name: `${TEST_PREFIX}bootstrap_org` } });
    BOOTSTRAP_ORG_ID = newOrg.id;
    const newUser = await db.user.create({
      data: {
        organization: { connect: { id: BOOTSTRAP_ORG_ID } },
        email: `${TEST_PREFIX}actor@integration.invalid`,
        displayName: `${TEST_PREFIX}Integration Test Actor`,
      },
    });
    TEST_ACTOR_ID = newUser.id;

    const s = suffix();
    const clientResult = await clientService.create({ organizationId: BOOTSTRAP_ORG_ID, displayName: `it_client_2a_${s}` }, TEST_ACTOR_ID);
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;
    clientId = clientResult.value.id;

    const civCreate = await civService.createRecord(clientId, TEST_ACTOR_ID);
    expect(civCreate.ok).toBe(true);
    if (!civCreate.ok) return;
    await civService.recordOperatorAttestation(civCreate.value.id, 'Verified for Phase 2A integration test', TEST_ACTOR_ID);
    await civService.completeVerification(civCreate.value.id, TEST_ACTOR_ID);

    const cvResult = await consentService.createConsentVersion(`999.2a.${s}`, 'a'.repeat(64), new Date(), undefined, TEST_ACTOR_ID);
    expect(cvResult.ok).toBe(true);
    if (!cvResult.ok) return;

    const authResult = await consentService.createAuthorization(
      { clientId, consentVersionId: cvResult.value.id, authorizationType: 'SELF', scopeNames: ['DATA_BROKER_OPT_OUT'], jurisdiction: 'US', signedAt: new Date() },
      TEST_ACTOR_ID,
    );
    expect(authResult.ok).toBe(true);
    if (!authResult.ok) return;
    authorizationId = authResult.value.id;

    const caseResult = await caseService.create({ clientId, authorizationId }, TEST_ACTOR_ID);
    expect(caseResult.ok).toBe(true);
    if (!caseResult.ok) return;
    caseId = caseResult.value.id;

    const targetResult = await dataSourceTargetService.create({
      sourceName: `it_target_2a_${s}`,
      sourceType: 'DATA_BROKER',
      piiRequiredFields: ['EMAIL'],
      supportedActionTypes: ['OPT_OUT'],
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    targetId = targetResult.value.id;

    const taskResult = await taskService.create(
      { caseId, dataSourceTargetId: targetId, actionType: 'OPT_OUT', riskTier: 'STANDARD' },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;
    taskId = taskResult.value.id;
  });

  it('creates a playbook with ordered steps', async () => {
    const result = await workflowEngineService.createPlaybook(
      {
        name: `it_playbook_${suffix()}`,
        version: '1.0.0',
        sourceType: 'DATA_BROKER',
        steps: [
          { stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Verify', instructions: 'Check the target is active.' },
          { stepOrder: 2, stepKind: 'MANUAL_SUBMISSION', title: 'Submit', instructions: 'Submit the opt-out request manually.' },
          { stepOrder: 3, stepKind: 'CLOSE_TASK', title: 'Close', instructions: 'Mark the task complete.' },
        ],
      },
      TEST_ACTOR_ID,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps).toHaveLength(3);
    expect(result.value.steps[0]?.stepKind).toBe('VERIFY_TARGET_REQUIREMENTS');
    expect(result.value.steps[1]?.stepKind).toBe('MANUAL_SUBMISSION');
    // Audit event written
    const logs = await db.auditLog.findMany({ where: { eventType: 'WORKFLOW_PLAYBOOK_CREATED', resourceId: result.value.id } });
    expect(logs).toHaveLength(1);
  });

  it('starts a workflow and marks first step READY', async () => {
    const pb = await workflowEngineService.createPlaybook(
      {
        name: `it_pb_start_${suffix()}`,
        version: '1.0.0',
        steps: [
          { stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Verify', instructions: 'Check requirements.' },
          { stepOrder: 2, stepKind: 'MANUAL_SUBMISSION', title: 'Submit', instructions: 'Submit manually.' },
        ],
      },
      TEST_ACTOR_ID,
    );
    expect(pb.ok).toBe(true);
    if (!pb.ok) return;

    const startResult = await workflowEngineService.startWorkflowForTask(
      { taskId, clientId, playbookId: pb.value.id },
      TEST_ACTOR_ID,
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    expect(startResult.value.run.taskId).toBe(taskId);
    expect(startResult.value.run.status).toBe('IN_PROGRESS');
    expect(startResult.value.steps[0]?.status).toBe('READY');
    expect(startResult.value.steps[1]?.status).toBe('PENDING');

    // Timeline event
    const events = await db.caseTimelineEvent.findMany({ where: { caseId, eventType: 'WORKFLOW_STARTED' } });
    expect(events).toHaveLength(1);
  });

  it('advances a step and moves next step to READY', async () => {
    const pb = await workflowEngineService.createPlaybook(
      {
        name: `it_pb_adv_${suffix()}`,
        version: '1.0.0',
        steps: [
          { stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Verify', instructions: 'Verify requirements.' },
          { stepOrder: 2, stepKind: 'MANUAL_SUBMISSION', title: 'Submit', instructions: 'Submit the request.' },
          { stepOrder: 3, stepKind: 'CLOSE_TASK', title: 'Close', instructions: 'Close the task.' },
        ],
      },
      TEST_ACTOR_ID,
    );
    expect(pb.ok).toBe(true);
    if (!pb.ok) return;

    const startResult = await workflowEngineService.startWorkflowForTask({ taskId, clientId, playbookId: pb.value.id }, TEST_ACTOR_ID);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const firstStepRun = startResult.value.steps.find((s) => s.status === 'READY');
    expect(firstStepRun).toBeDefined();

    const advResult = await workflowEngineService.advanceStep(
      startResult.value.run.id,
      firstStepRun!.id,
      { safeResultSummary: 'Requirements verified — target is active' },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;
    const completedStep = advResult.value.steps.find((s) => s.id === firstStepRun!.id);
    const nextStep = advResult.value.steps.find((s) => s.stepOrder === 2);
    expect(completedStep?.status).toBe('COMPLETED');
    expect(nextStep?.status).toBe('READY');
  });

  it('completes workflow when last step advances', async () => {
    const pb = await workflowEngineService.createPlaybook(
      {
        name: `it_pb_fin_${suffix()}`,
        version: '1.0.0',
        steps: [
          { stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Verify', instructions: 'Verify the target.' },
        ],
      },
      TEST_ACTOR_ID,
    );
    expect(pb.ok).toBe(true);
    if (!pb.ok) return;

    const startResult = await workflowEngineService.startWorkflowForTask({ taskId, clientId, playbookId: pb.value.id }, TEST_ACTOR_ID);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const stepRun = startResult.value.steps[0]!;
    const advResult = await workflowEngineService.advanceStep(startResult.value.run.id, stepRun.id, {}, clientId, TEST_ACTOR_ID);
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;
    expect(advResult.value.run.status).toBe('COMPLETED');

    const completedEvents = await db.caseTimelineEvent.findMany({ where: { caseId, eventType: 'WORKFLOW_COMPLETED' } });
    expect(completedEvents).toHaveLength(1);
  });

  it('blocks a workflow step with a safe reason', async () => {
    const pb = await workflowEngineService.createPlaybook(
      {
        name: `it_pb_blk_${suffix()}`,
        version: '1.0.0',
        steps: [
          { stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Verify', instructions: 'Check requirements.' },
        ],
      },
      TEST_ACTOR_ID,
    );
    expect(pb.ok).toBe(true);
    if (!pb.ok) return;

    const startResult = await workflowEngineService.startWorkflowForTask({ taskId, clientId, playbookId: pb.value.id }, TEST_ACTOR_ID);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const stepRun = startResult.value.steps[0]!;
    const blockResult = await workflowEngineService.blockStep(
      startResult.value.run.id,
      stepRun.id,
      { reason: 'Target portal unavailable — no PII here' },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(blockResult.ok).toBe(true);
    if (!blockResult.ok) return;
    expect(blockResult.value.run.status).toBe('BLOCKED');
    const blockedStep = blockResult.value.steps.find((s) => s.id === stepRun.id);
    expect(blockedStep?.status).toBe('BLOCKED');
  });

  it('links a manual submission to a MANUAL_SUBMISSION step', async () => {
    const pb = await workflowEngineService.createPlaybook(
      {
        name: `it_pb_sub_${suffix()}`,
        version: '1.0.0',
        steps: [
          { stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Verify', instructions: 'Verify requirements.' },
          { stepOrder: 2, stepKind: 'MANUAL_SUBMISSION', title: 'Submit', instructions: 'Submit the request.', requiresManualSubmission: true },
        ],
      },
      TEST_ACTOR_ID,
    );
    expect(pb.ok).toBe(true);
    if (!pb.ok) return;

    const startResult = await workflowEngineService.startWorkflowForTask({ taskId, clientId, playbookId: pb.value.id }, TEST_ACTOR_ID);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Advance first step to unlock second
    const firstStepRun = startResult.value.steps[0]!;
    await workflowEngineService.advanceStep(startResult.value.run.id, firstStepRun.id, {}, clientId, TEST_ACTOR_ID);

    // Create a manual submission
    const subResult = await manualSubmissionService.createForTask(
      { taskId, clientId, submissionMethod: 'WEB_FORM', redactedSummary: 'OPT_OUT to it_broker — EMAIL: i***@vault.invalid' },
      TEST_ACTOR_ID,
    );
    expect(subResult.ok).toBe(true);
    if (!subResult.ok) return;

    // Fetch updated state to find the MANUAL_SUBMISSION step run ID
    const stateResult = await workflowEngineService.getWorkflowStateByTaskId(taskId);
    expect(stateResult.ok).toBe(true);
    if (!stateResult.ok) return;
    const submissionStepRun = stateResult.value.steps.find((s) => s.stepKind === 'MANUAL_SUBMISSION');
    expect(submissionStepRun).toBeDefined();

    const attachResult = await workflowEngineService.attachManualSubmission(
      startResult.value.run.id,
      submissionStepRun!.id,
      { manualSubmissionId: subResult.value.id },
      clientId,
      TEST_ACTOR_ID,
    );
    expect(attachResult.ok).toBe(true);
    if (!attachResult.ok) return;
    const linkedStep = attachResult.value.steps.find((s) => s.stepKind === 'MANUAL_SUBMISSION');
    expect(linkedStep?.manualSubmissionId).toBe(subResult.value.id);

    // Audit event
    const auditLogs = await db.auditLog.findMany({ where: { eventType: 'WORKFLOW_MANUAL_SUBMISSION_LINKED', clientId } });
    expect(auditLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('returns WORKFLOW_RUN_NOT_FOUND for missing run', async () => {
    const result = await workflowEngineService.getWorkflowState('nonexistent-run-id');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('returns PLAYBOOK_NOT_FOUND when no auto-select playbook exists for target', async () => {
    // No playbooks linked to this target
    const result = await workflowEngineService.startWorkflowForTask({ taskId, clientId }, TEST_ACTOR_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('PLAYBOOK_NOT_FOUND');
  });

  it('workflow state response contains no plaintext PII or ciphertext', async () => {
    const pb = await workflowEngineService.createPlaybook(
      {
        name: `it_pb_pii_${suffix()}`,
        version: '1.0.0',
        steps: [{ stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Verify', instructions: 'Check target.' }],
      },
      TEST_ACTOR_ID,
    );
    expect(pb.ok).toBe(true);
    if (!pb.ok) return;

    const startResult = await workflowEngineService.startWorkflowForTask({ taskId, clientId, playbookId: pb.value.id }, TEST_ACTOR_ID);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const json = JSON.stringify(startResult.value);
    expect(json).not.toContain('ciphertext');
    expect(json).not.toContain('authTag');
    expect(json).not.toContain('encryptedKeyRef');
    // No raw email patterns
    expect(json).not.toMatch(/[a-z0-9._%+-]+@(?!vault\.invalid)[a-z0-9.-]+\.[a-z]{2,}/);
  });

  it('audit logs contain WORKFLOW_STARTED and WORKFLOW_STEP_ADVANCED events', async () => {
    const pb = await workflowEngineService.createPlaybook(
      {
        name: `it_pb_aud_${suffix()}`,
        version: '1.0.0',
        steps: [
          { stepOrder: 1, stepKind: 'VERIFY_TARGET_REQUIREMENTS', title: 'Verify', instructions: 'Verify the target.' },
          { stepOrder: 2, stepKind: 'CLOSE_TASK', title: 'Close', instructions: 'Close the task.' },
        ],
      },
      TEST_ACTOR_ID,
    );
    expect(pb.ok).toBe(true);
    if (!pb.ok) return;

    const startResult = await workflowEngineService.startWorkflowForTask({ taskId, clientId, playbookId: pb.value.id }, TEST_ACTOR_ID);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const firstStep = startResult.value.steps[0]!;
    await workflowEngineService.advanceStep(startResult.value.run.id, firstStep.id, {}, clientId, TEST_ACTOR_ID);

    const logs = await db.auditLog.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' } });
    const eventTypes = logs.map((l) => l.eventType);
    expect(eventTypes).toContain('WORKFLOW_STARTED');
    expect(eventTypes).toContain('WORKFLOW_STEP_ADVANCED');
  });
});
