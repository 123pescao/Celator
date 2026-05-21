-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('PENDING_IDENTITY_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DISPUTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AuthorizationType" AS ENUM ('SELF', 'LEGAL_GUARDIAN', 'POWER_OF_ATTORNEY', 'EMPLOYER_SAFETY', 'DECEASED_ESTATE', 'ATTORNEY_CLIENT');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('FOUND', 'CLASSIFIED', 'MATCH_REVIEW_REQUIRED', 'CLIENT_CONFIRMATION_REQUIRED', 'READY_FOR_OPERATOR_REVIEW', 'OPERATOR_APPROVED', 'OPERATOR_REJECTED', 'READY_TO_SUBMIT', 'SUBMITTED', 'DELIVERED', 'BROKER_CONFIRMED_RECEIPT', 'BROKER_REJECTED', 'MORE_INFO_REQUESTED', 'WAITING_VERIFICATION', 'VERIFIED_REMOVED', 'PARTIALLY_REMOVED', 'FAILED', 'REAPPEARED', 'MANUAL_ONLY', 'ESCALATED', 'FALSE_POSITIVE', 'SKIPPED', 'NEEDS_OPERATOR_REVIEW', 'BLOCKED_CONSENT_SCOPE', 'PAUSED_BY_SYSTEM');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('CONFIRMED_MATCH', 'CLIENT_CONFIRMED', 'LIKELY_MATCH', 'POSSIBLE_MATCH', 'NEEDS_CLIENT_REVIEW', 'NEEDS_OPERATOR_REVIEW', 'FALSE_POSITIVE');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'USED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "RiskTier" AS ENUM ('STANDARD', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OperatorDecision" AS ENUM ('APPROVED', 'REJECTED', 'ESCALATED', 'NEEDS_MORE_EVIDENCE');

-- CreateEnum
CREATE TYPE "EmergencyPauseScope" AS ENUM ('GLOBAL', 'CLIENT', 'BROKER', 'OPERATOR', 'JURISDICTION');

-- CreateEnum
CREATE TYPE "EmergencyPauseStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'CLIENT', 'OPERATOR', 'ADMIN', 'SERVICE');

-- CreateEnum
CREATE TYPE "VaultPurposeCode" AS ENUM ('PURPOSE_OPERATOR_REVIEW_PACKET', 'PURPOSE_FORM_FILL', 'PURPOSE_REPORT_GENERATION', 'PURPOSE_CLIENT_EXPORT', 'PURPOSE_DEK_ROTATION');

-- CreateEnum
CREATE TYPE "HighRiskFlagType" AS ENUM ('MINOR_DATA', 'DOMESTIC_VIOLENCE_SAFETY', 'PUBLIC_FIGURE', 'MEDICAL_DATA', 'FINANCIAL_DATA', 'LEGAL_DATA', 'COURT_RECORD', 'PROPERTY_RECORD', 'UNCERTAIN_MATCH', 'ID_DOCUMENT_REQUIRED', 'LEGAL_ESCALATION');

-- CreateEnum
CREATE TYPE "WarningType" AS ENUM ('MATCH_CONFIDENCE_LOW', 'PLAYBOOK_NOT_RECENTLY_TESTED', 'PREVIOUSLY_REJECTED_BY_BROKER', 'SENSITIVE_DATA_REQUIRED', 'SAME_OPERATOR_PREPARED', 'HIGH_RISK_FLAG_PRESENT', 'RESUBMISSION', 'SNAPSHOT_APPROACHING_EXPIRY', 'SEGREGATION_OF_DUTIES_REQUIRED', 'PLAYBOOK_EXCEPTION_ACTIVE', 'BROKER_ON_LEGAL_HOLD');

-- CreateEnum
CREATE TYPE "DekRotationStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('OPT_OUT', 'DELETE_PERSONAL_DATA', 'DO_NOT_SELL', 'DO_NOT_SHARE', 'LIMIT_SENSITIVE_DATA', 'CORRECT_DATA', 'REMOVE_FROM_SEARCH', 'REFRESH_OUTDATED_CONTENT', 'DELETE_ACCOUNT', 'DEACTIVATE_ACCOUNT', 'REMOVE_IMAGE', 'SUPPRESS_PROFILE', 'REPORT_DANGEROUS_EXPOSURE', 'ESCALATE_NON_RESPONSE', 'LEGAL_ESCALATION');

-- CreateEnum
CREATE TYPE "IdentityVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'REQUIRES_DOCUMENT_REVIEW');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastMfaAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "ClientStatus" NOT NULL DEFAULT 'PENDING_IDENTITY_VERIFICATION',
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hasDisputeFlag" BOOLEAN NOT NULL DEFAULT false,
    "hasComplianceHold" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_identity_verifications" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "IdentityVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "operatorAttestation" TEXT,
    "operatorId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_identity_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_authorizations" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "authorizationType" "AuthorizationType" NOT NULL DEFAULT 'SELF',
    "scopeNames" TEXT[],
    "jurisdiction" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "consentVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_versions" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_scope_mappings" (
    "id" TEXT NOT NULL,
    "scopeName" TEXT NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "permitted" BOOLEAN NOT NULL,
    "requiredLanguageNote" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_scope_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_vault_records" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "isCryptoShredded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_vault_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_vault_access_logs" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "purposeCode" "VaultPurposeCode" NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_vault_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dek_rotation_jobs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "oldKeyVersion" TEXT NOT NULL,
    "newKeyVersion" TEXT NOT NULL,
    "status" "DekRotationStatus" NOT NULL DEFAULT 'PENDING',
    "recordsTotal" INTEGER NOT NULL DEFAULT 0,
    "recordsRotated" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dek_rotation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleanup_cases" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "cleanup_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleanup_tasks" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'FOUND',
    "actionType" "ActionType",
    "matchStatus" "MatchStatus" NOT NULL DEFAULT 'NEEDS_OPERATOR_REVIEW',
    "riskTier" "RiskTier" NOT NULL DEFAULT 'STANDARD',
    "sourceRef" TEXT,
    "findingUrl" TEXT,
    "preparedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cleanup_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allowed_status_transitions" (
    "id" TEXT NOT NULL,
    "fromStatus" "TaskStatus" NOT NULL,
    "toStatus" "TaskStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allowed_status_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_payload_snapshots" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "snapshotSignature" TEXT NOT NULL,
    "signingKeyVersion" TEXT NOT NULL,
    "snapshotStatus" "SnapshotStatus" NOT NULL DEFAULT 'ACTIVE',
    "snapshotExpiresAt" TIMESTAMP(3) NOT NULL,
    "riskTier" "RiskTier" NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "redactedPreview" TEXT NOT NULL,
    "invalidationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_payload_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshot_evidence_holds" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "evidenceId" TEXT,
    "vaultRecordId" TEXT,
    "heldUntil" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snapshot_evidence_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "preparedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_approvals" (
    "id" TEXT NOT NULL,
    "approvalRequestId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "decision" "OperatorDecision" NOT NULL,
    "mfaFreshAt" TIMESTAMP(3) NOT NULL,
    "sessionApprovalCount" INTEGER NOT NULL DEFAULT 0,
    "reviewStartedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "operator_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_warning_acknowledgments" (
    "id" TEXT NOT NULL,
    "approvalRequestId" TEXT NOT NULL,
    "warningType" "WarningType" NOT NULL,
    "operatorId" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_warning_acknowledgments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_quality_metrics" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "approvalsInSession" INTEGER NOT NULL DEFAULT 0,
    "rejectionsInSession" INTEGER NOT NULL DEFAULT 0,
    "avgReviewTimeSecondsSession" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bulkApprovalAttempted" BOOLEAN NOT NULL DEFAULT false,
    "selfApprovalFlagged" BOOLEAN NOT NULL DEFAULT false,
    "highRiskApprovalsInSession" INTEGER NOT NULL DEFAULT 0,
    "sessionStartedAt" TIMESTAMP(3) NOT NULL,
    "sessionEndedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_quality_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_pause_events" (
    "id" TEXT NOT NULL,
    "scope" "EmergencyPauseScope" NOT NULL,
    "scopeRef" TEXT,
    "status" "EmergencyPauseStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionSummary" TEXT,
    "requiresDualAdmin" BOOLEAN NOT NULL DEFAULT false,
    "secondAdminApprovedBy" TEXT,
    "secondAdminApprovedAt" TIMESTAMP(3),

    CONSTRAINT "emergency_pause_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "clientId" TEXT,
    "resourceId" TEXT,
    "resourceType" TEXT,
    "outcome" TEXT NOT NULL,
    "blockedBy" TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_timeline_events" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "taskId" TEXT,
    "eventType" TEXT NOT NULL,
    "fromStatus" "TaskStatus",
    "toStatus" "TaskStatus",
    "actorId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_timeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_records" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "isImmutable" BOOLEAN NOT NULL DEFAULT false,
    "retainUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "high_risk_flags" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taskId" TEXT,
    "flagType" "HighRiskFlagType" NOT NULL,
    "flaggedBy" TEXT NOT NULL,
    "flaggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "notes" TEXT,

    CONSTRAINT "high_risk_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_hold_sources" (
    "id" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "heldBy" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,

    CONSTRAINT "legal_hold_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portal_events" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "ipHash" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_portal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_data_deletion_requests" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedBy" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "retainedRecords" JSONB,
    "cryptoShredded" BOOLEAN NOT NULL DEFAULT false,
    "cryptoShredAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "client_data_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organizationId_idx" ON "users"("organizationId");

-- CreateIndex
CREATE INDEX "users_isActive_idx" ON "users"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_key" ON "role_permissions"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "user_roles_userId_idx" ON "user_roles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_userId_roleId_key" ON "user_roles"("userId", "roleId");

-- CreateIndex
CREATE INDEX "clients_organizationId_idx" ON "clients"("organizationId");

-- CreateIndex
CREATE INDEX "clients_status_idx" ON "clients"("status");

-- CreateIndex
CREATE INDEX "client_identity_verifications_clientId_idx" ON "client_identity_verifications"("clientId");

-- CreateIndex
CREATE INDEX "client_identity_verifications_status_idx" ON "client_identity_verifications"("status");

-- CreateIndex
CREATE INDEX "client_authorizations_clientId_idx" ON "client_authorizations"("clientId");

-- CreateIndex
CREATE INDEX "client_authorizations_revokedAt_idx" ON "client_authorizations"("revokedAt");

-- CreateIndex
CREATE INDEX "client_authorizations_expiresAt_idx" ON "client_authorizations"("expiresAt");

-- CreateIndex
CREATE INDEX "consent_versions_effectiveFrom_idx" ON "consent_versions"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "consent_versions_version_key" ON "consent_versions"("version");

-- CreateIndex
CREATE INDEX "consent_scope_mappings_scopeName_actionType_jurisdiction_ef_idx" ON "consent_scope_mappings"("scopeName", "actionType", "jurisdiction", "effectiveFrom");

-- CreateIndex
CREATE INDEX "identity_vault_records_clientId_idx" ON "identity_vault_records"("clientId");

-- CreateIndex
CREATE INDEX "identity_vault_records_clientId_fieldType_idx" ON "identity_vault_records"("clientId", "fieldType");

-- CreateIndex
CREATE INDEX "identity_vault_access_logs_recordId_idx" ON "identity_vault_access_logs"("recordId");

-- CreateIndex
CREATE INDEX "identity_vault_access_logs_clientId_accessedAt_idx" ON "identity_vault_access_logs"("clientId", "accessedAt");

-- CreateIndex
CREATE INDEX "dek_rotation_jobs_clientId_status_idx" ON "dek_rotation_jobs"("clientId", "status");

-- CreateIndex
CREATE INDEX "cleanup_cases_clientId_idx" ON "cleanup_cases"("clientId");

-- CreateIndex
CREATE INDEX "cleanup_tasks_caseId_status_idx" ON "cleanup_tasks"("caseId", "status");

-- CreateIndex
CREATE INDEX "cleanup_tasks_status_idx" ON "cleanup_tasks"("status");

-- CreateIndex
CREATE INDEX "cleanup_tasks_riskTier_status_idx" ON "cleanup_tasks"("riskTier", "status");

-- CreateIndex
CREATE UNIQUE INDEX "allowed_status_transitions_fromStatus_toStatus_key" ON "allowed_status_transitions"("fromStatus", "toStatus");

-- CreateIndex
CREATE INDEX "approval_payload_snapshots_taskId_idx" ON "approval_payload_snapshots"("taskId");

-- CreateIndex
CREATE INDEX "approval_payload_snapshots_snapshotStatus_snapshotExpiresAt_idx" ON "approval_payload_snapshots"("snapshotStatus", "snapshotExpiresAt");

-- CreateIndex
CREATE INDEX "snapshot_evidence_holds_snapshotId_idx" ON "snapshot_evidence_holds"("snapshotId");

-- CreateIndex
CREATE INDEX "snapshot_evidence_holds_evidenceId_idx" ON "snapshot_evidence_holds"("evidenceId");

-- CreateIndex
CREATE INDEX "approval_requests_taskId_status_idx" ON "approval_requests"("taskId", "status");

-- CreateIndex
CREATE INDEX "approval_requests_status_expiresAt_idx" ON "approval_requests"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "operator_approvals_approvalRequestId_key" ON "operator_approvals"("approvalRequestId");

-- CreateIndex
CREATE INDEX "operator_approvals_operatorId_approvedAt_idx" ON "operator_approvals"("operatorId", "approvedAt");

-- CreateIndex
CREATE INDEX "operator_approvals_snapshotId_idx" ON "operator_approvals"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "operator_warning_acknowledgments_approvalRequestId_warningT_key" ON "operator_warning_acknowledgments"("approvalRequestId", "warningType");

-- CreateIndex
CREATE INDEX "operator_quality_metrics_operatorId_createdAt_idx" ON "operator_quality_metrics"("operatorId", "createdAt");

-- CreateIndex
CREATE INDEX "emergency_pause_events_status_scope_idx" ON "emergency_pause_events"("status", "scope");

-- CreateIndex
CREATE INDEX "emergency_pause_events_scopeRef_status_idx" ON "emergency_pause_events"("scopeRef", "status");

-- CreateIndex
CREATE INDEX "audit_logs_clientId_createdAt_idx" ON "audit_logs"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_eventType_createdAt_idx" ON "audit_logs"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "case_timeline_events_caseId_createdAt_idx" ON "case_timeline_events"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "case_timeline_events_taskId_createdAt_idx" ON "case_timeline_events"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "evidence_records_taskId_idx" ON "evidence_records"("taskId");

-- CreateIndex
CREATE INDEX "high_risk_flags_clientId_resolvedAt_idx" ON "high_risk_flags"("clientId", "resolvedAt");

-- CreateIndex
CREATE INDEX "high_risk_flags_taskId_idx" ON "high_risk_flags"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "legal_hold_sources_sourceRef_key" ON "legal_hold_sources"("sourceRef");

-- CreateIndex
CREATE INDEX "legal_hold_sources_releasedAt_idx" ON "legal_hold_sources"("releasedAt");

-- CreateIndex
CREATE INDEX "client_portal_events_clientId_createdAt_idx" ON "client_portal_events"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "client_data_deletion_requests_clientId_idx" ON "client_data_deletion_requests"("clientId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_identity_verifications" ADD CONSTRAINT "client_identity_verifications_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_authorizations" ADD CONSTRAINT "client_authorizations_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_authorizations" ADD CONSTRAINT "client_authorizations_consentVersionId_fkey" FOREIGN KEY ("consentVersionId") REFERENCES "consent_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_vault_records" ADD CONSTRAINT "identity_vault_records_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_vault_access_logs" ADD CONSTRAINT "identity_vault_access_logs_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "identity_vault_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dek_rotation_jobs" ADD CONSTRAINT "dek_rotation_jobs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleanup_cases" ADD CONSTRAINT "cleanup_cases_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleanup_cases" ADD CONSTRAINT "cleanup_cases_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "client_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleanup_tasks" ADD CONSTRAINT "cleanup_tasks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cleanup_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_evidence_holds" ADD CONSTRAINT "snapshot_evidence_holds_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "approval_payload_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_evidence_holds" ADD CONSTRAINT "snapshot_evidence_holds_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_evidence_holds" ADD CONSTRAINT "snapshot_evidence_holds_vaultRecordId_fkey" FOREIGN KEY ("vaultRecordId") REFERENCES "identity_vault_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "cleanup_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "client_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "approval_payload_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_approvals" ADD CONSTRAINT "operator_approvals_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_approvals" ADD CONSTRAINT "operator_approvals_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "approval_payload_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_approvals" ADD CONSTRAINT "operator_approvals_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_warning_acknowledgments" ADD CONSTRAINT "operator_warning_acknowledgments_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_warning_acknowledgments" ADD CONSTRAINT "operator_warning_acknowledgments_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_quality_metrics" ADD CONSTRAINT "operator_quality_metrics_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_pause_events" ADD CONSTRAINT "emergency_pause_events_triggeredBy_fkey" FOREIGN KEY ("triggeredBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_timeline_events" ADD CONSTRAINT "case_timeline_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cleanup_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_timeline_events" ADD CONSTRAINT "case_timeline_events_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "cleanup_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "cleanup_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "high_risk_flags" ADD CONSTRAINT "high_risk_flags_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "high_risk_flags" ADD CONSTRAINT "high_risk_flags_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "cleanup_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_events" ADD CONSTRAINT "client_portal_events_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_data_deletion_requests" ADD CONSTRAINT "client_data_deletion_requests_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

