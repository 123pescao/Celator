/**
 * Wire up repositories and services for the API.
 * This is constructed once at startup — not per-request.
 */

import { getPrismaClient } from '@celator/db';
import {
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
  EvidenceRecordRepository,
  IdentityVaultRecordRepository,
  IdentityVaultAccessLogRepository,
  DataSourceTargetRepository,
  ManualRemovalSubmissionRepository,
  RemovalPlaybookRepository,
  TaskWorkflowRunRepository,
  RemovalRequestPacketRepository,
  FollowUpReminderRepository,
  EmergencyPauseRepository,
  ClientIntakeSessionRepository,
  ScheduledNotificationRepository,
  CaseReportRepository,
  AutomationPlanRepository,
} from '@celator/db';
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
  RemovalRequestPacketService,
  EvidenceService,
  FollowUpReminderService,
  OperatorCommandCenterService,
  ClientIntakeService,
  NotificationService,
  CaseReportService,
  AutomationPlanService,
} from '@celator/core';
import { getKmsProvider } from '@celator/security';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function buildServices() {
  const db = getPrismaClient();

  // Repositories
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
  const evidenceRepo = new EvidenceRecordRepository(db);
  const vaultRecordRepo = new IdentityVaultRecordRepository(db);
  const vaultAccessLogRepo = new IdentityVaultAccessLogRepository(db);
  const dataSourceTargetRepo = new DataSourceTargetRepository(db);
  const manualSubmissionRepo = new ManualRemovalSubmissionRepository(db);
  const playbookRepo = new RemovalPlaybookRepository(db);
  const workflowRunRepo = new TaskWorkflowRunRepository(db);
  const packetRepo = new RemovalRequestPacketRepository(db);
  const followUpRepo = new FollowUpReminderRepository(db);
  const emergencyPauseRepo = new EmergencyPauseRepository(db);
  const intakeSessionRepo = new ClientIntakeSessionRepository(db);
  const notificationRepo = new ScheduledNotificationRepository(db);
  const reportRepo = new CaseReportRepository(db);
  const automationPlanRepo = new AutomationPlanRepository(db);

  // Services
  const audit = new AuditService(auditRepo);
  const timeline = new CaseTimelineService(timelineRepo);
  const clientService = new ClientService(clientRepo, audit);

  // CleanupTaskService is needed by ConsentWorkflowService (lazy ref to break circular dep)
  const taskService = new CleanupTaskService(taskRepo, audit, timeline);
  const consentService = new ConsentWorkflowService(
    consentVersionRepo,
    authorizationRepo,
    audit,
    () => taskService,
  );
  const civService = new ClientIdentityVerificationService(civRepo, clientService, audit, timeline);
  const caseService = new CleanupCaseService(caseRepo, audit, timeline);
  const reviewPacketService = new ReviewPacketService(
    snapshotRepo,
    requestRepo,
    taskRepo,
    authorizationRepo,
    audit,
    timeline,
  );
  const operatorApprovalService = new OperatorApprovalService(
    approvalRepo,
    requestRepo,
    snapshotRepo,
    taskService,
    audit,
    timeline,
  );

  const vaultService = new IdentityVaultIntakeService(vaultRecordRepo, vaultAccessLogRepo, getKmsProvider());
  const dataSourceTargetService = new DataSourceTargetService(dataSourceTargetRepo);
  const removalDraftService = new RemovalRequestDraftService(dataSourceTargetRepo, vaultService);
  const manualSubmissionService = new ManualRemovalSubmissionService(
    manualSubmissionRepo,
    taskRepo,
    dataSourceTargetRepo,
    audit,
    timeline,
  );
  const workflowEngineService = new WorkflowEngineService(playbookRepo, workflowRunRepo, taskRepo, audit, timeline);
  const packetService = new RemovalRequestPacketService(packetRepo, taskRepo, dataSourceTargetRepo, vaultService, audit, timeline);
  const evidenceService = new EvidenceService(evidenceRepo, taskRepo, audit);
  const followUpService = new FollowUpReminderService(followUpRepo, taskRepo, audit, timeline);
  const operatorCommandCenterService = new OperatorCommandCenterService(
    clientRepo, caseRepo, taskRepo, workflowRunRepo, packetRepo,
    followUpRepo, evidenceRepo, manualSubmissionRepo, timelineRepo,
  );
  const intakeService = new ClientIntakeService(
    intakeSessionRepo, caseRepo, taskRepo, workflowRunRepo, packetRepo,
    followUpRepo, emergencyPauseRepo, audit,
  );
  const notificationService = new NotificationService(notificationRepo, followUpRepo, taskRepo, audit);
  const caseReportService = new CaseReportService(reportRepo, vaultService, audit);
  const automationPlanService = new AutomationPlanService(automationPlanRepo, taskRepo, emergencyPauseRepo, audit);

  return {
    repos: { orgRepo, userRepo, clientRepo, civRepo, consentVersionRepo, authorizationRepo, caseRepo, taskRepo, snapshotRepo, requestRepo, approvalRepo, auditRepo, timelineRepo, evidenceRepo, vaultRecordRepo, vaultAccessLogRepo, dataSourceTargetRepo, manualSubmissionRepo, playbookRepo, workflowRunRepo, packetRepo, followUpRepo, emergencyPauseRepo, intakeSessionRepo, notificationRepo, reportRepo, automationPlanRepo },
    services: { audit, timeline, clientService, civService, consentService, caseService, taskService, reviewPacketService, operatorApprovalService, vaultService, dataSourceTargetService, removalDraftService, manualSubmissionService, workflowEngineService, packetService, evidenceService, followUpService, operatorCommandCenterService, intakeService, notificationService, caseReportService, automationPlanService },
  };
}

export type AppServices = ReturnType<typeof buildServices>['services'];
export type AppRepos = ReturnType<typeof buildServices>['repos'];
