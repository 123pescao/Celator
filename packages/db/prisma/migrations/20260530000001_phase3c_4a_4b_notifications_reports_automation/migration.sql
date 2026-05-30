-- Phase 3C: Notifications / Reminder Delivery Foundation
-- Phase 4A: Reports, Exports, and Proof Packet Foundation
-- Phase 4B: Controlled Automation Adapter Framework Foundation

-- Phase 3C enums
CREATE TYPE "NotificationChannel" AS ENUM ('DRY_RUN');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SCHEDULED', 'DELIVERED', 'FAILED', 'CANCELLED');

-- Phase 4A enums
CREATE TYPE "ReportType" AS ENUM ('CASE_SUMMARY', 'EVIDENCE_SUMMARY', 'FULL_CASE_EXPORT', 'PROOF_PACKET');
CREATE TYPE "ExportFormat" AS ENUM ('JSON', 'CSV', 'PDF_STUB');
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED', 'EXPIRED');

-- Phase 4B enum
CREATE TYPE "AutomationPlanStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING_DRY_RUN', 'DRY_RUN_COMPLETE', 'CANCELLED');

-- Phase 3C: scheduled_notifications table
CREATE TABLE "scheduled_notifications" (
    "id"                   TEXT         NOT NULL,
    "client_id"            TEXT         NOT NULL,
    "case_id"              TEXT,
    "task_id"              TEXT,
    "follow_up_reminder_id" TEXT,
    "channel"              "NotificationChannel" NOT NULL DEFAULT 'DRY_RUN',
    "status"               "NotificationStatus"  NOT NULL DEFAULT 'PENDING',
    "subject_safe"         TEXT         NOT NULL,
    "body_safe"            TEXT         NOT NULL,
    "scheduled_for"        TIMESTAMP(3) NOT NULL,
    "delivered_at"         TIMESTAMP(3),
    "failed_at"            TIMESTAMP(3),
    "cancelled_at"         TIMESTAMP(3),
    "failure_reason"       TEXT,
    "created_by_user_id"   TEXT,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scheduled_notifications_client_id_status_idx" ON "scheduled_notifications"("client_id", "status");
CREATE INDEX "scheduled_notifications_status_scheduled_for_idx" ON "scheduled_notifications"("status", "scheduled_for");
CREATE INDEX "scheduled_notifications_follow_up_reminder_id_idx" ON "scheduled_notifications"("follow_up_reminder_id");

ALTER TABLE "scheduled_notifications" ADD CONSTRAINT "scheduled_notifications_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scheduled_notifications" ADD CONSTRAINT "scheduled_notifications_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cleanup_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "scheduled_notifications" ADD CONSTRAINT "scheduled_notifications_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "cleanup_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "scheduled_notifications" ADD CONSTRAINT "scheduled_notifications_follow_up_reminder_id_fkey"
    FOREIGN KEY ("follow_up_reminder_id") REFERENCES "follow_up_reminders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 4A: case_reports table
CREATE TABLE "case_reports" (
    "id"                   TEXT         NOT NULL,
    "client_id"            TEXT         NOT NULL,
    "case_id"              TEXT,
    "report_type"          "ReportType" NOT NULL,
    "export_format"        "ExportFormat" NOT NULL,
    "status"               "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "redacted_summary"     TEXT         NOT NULL,
    "requested_by_user_id" TEXT,
    "generated_at"         TIMESTAMP(3),
    "failed_at"            TIMESTAMP(3),
    "expires_at"           TIMESTAMP(3),
    "failure_reason"       TEXT,
    "vault_access_log_id"  TEXT,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "case_reports_client_id_status_idx" ON "case_reports"("client_id", "status");
CREATE INDEX "case_reports_case_id_status_idx" ON "case_reports"("case_id", "status");
CREATE INDEX "case_reports_status_expires_at_idx" ON "case_reports"("status", "expires_at");

ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cleanup_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 4B: automation_plans table
CREATE TABLE "automation_plans" (
    "id"                         TEXT                   NOT NULL,
    "task_id"                    TEXT                   NOT NULL,
    "client_id"                  TEXT                   NOT NULL,
    "status"                     "AutomationPlanStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "intent_json"                JSONB                  NOT NULL,
    "dry_run_result_json"        JSONB,
    "approved_by_user_id"        TEXT,
    "rejected_by_user_id"        TEXT,
    "rejection_reason"           TEXT,
    "cancelled_by_user_id"       TEXT,
    "approved_at"                TIMESTAMP(3),
    "rejected_at"                TIMESTAMP(3),
    "dry_run_started_at"         TIMESTAMP(3),
    "dry_run_completed_at"       TIMESTAMP(3),
    "cancelled_at"               TIMESTAMP(3),
    "emergency_pause_blocked_at" TIMESTAMP(3),
    "created_by_user_id"         TEXT,
    "created_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                 TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_plans_task_id_status_idx" ON "automation_plans"("task_id", "status");
CREATE INDEX "automation_plans_client_id_created_at_idx" ON "automation_plans"("client_id", "created_at");
CREATE INDEX "automation_plans_status_idx" ON "automation_plans"("status");

ALTER TABLE "automation_plans" ADD CONSTRAINT "automation_plans_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "cleanup_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automation_plans" ADD CONSTRAINT "automation_plans_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
