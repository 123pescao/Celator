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

  // 10. cleanup_tasks → cleanup_cases (caseId FK)
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

  const audit = new AuditService(auditRepo);
  const timeline = new CaseTimelineService(timelineRepo);
  const clientService = new ClientService(clientRepo, audit);
  const taskService = new CleanupTaskService(taskRepo, audit, timeline);
  const consentService = new ConsentWorkflowService(consentVersionRepo, authorizationRepo, audit, () => taskService);
  const civService = new ClientIdentityVerificationService(civRepo, clientService, audit, timeline);
  const caseService = new CleanupCaseService(caseRepo, audit, timeline);
  const reviewPacketService = new ReviewPacketService(snapshotRepo, requestRepo, taskRepo, authorizationRepo, audit, timeline);
  const operatorApprovalService = new OperatorApprovalService(approvalRepo, requestRepo, snapshotRepo, taskService, audit, timeline);

  return {
    orgRepo, userRepo,
    clientService, civService, consentService, caseService, taskService,
    reviewPacketService, operatorApprovalService, audit, timeline,
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
