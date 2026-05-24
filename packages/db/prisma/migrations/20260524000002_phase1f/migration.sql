-- Phase 1F: Manual Removal Workflow MVP

-- Enums for manual submission tracking
CREATE TYPE "SubmissionMethod" AS ENUM ('WEB_FORM', 'EMAIL', 'SUPPORT_PORTAL', 'PHONE', 'MAIL', 'OTHER');

CREATE TYPE "SubmissionStatus" AS ENUM ('DRAFTED', 'READY_FOR_MANUAL_SUBMISSION', 'SUBMITTED', 'ACKNOWLEDGED', 'REJECTED', 'NEEDS_MORE_INFO', 'COMPLETED', 'FAILED');

-- ManualRemovalSubmission table
CREATE TABLE "manual_removal_submissions" (
    "id"                   TEXT NOT NULL,
    "task_id"              TEXT NOT NULL REFERENCES "cleanup_tasks"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "data_source_target_id" TEXT NOT NULL REFERENCES "data_source_targets"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "client_id"            TEXT NOT NULL REFERENCES "clients"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "submitted_by_user_id" TEXT,
    "submission_method"    "SubmissionMethod" NOT NULL,
    "submission_status"    "SubmissionStatus" NOT NULL DEFAULT 'DRAFTED',
    "submitted_at"         TIMESTAMP(3),
    "confirmation_code"    TEXT,
    "confirmation_url"     TEXT,
    "operator_notes"       TEXT,
    "redacted_summary"     TEXT NOT NULL,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_removal_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "manual_removal_submissions_task_id_idx"
    ON "manual_removal_submissions"("task_id");

CREATE INDEX "manual_removal_submissions_client_id_created_at_idx"
    ON "manual_removal_submissions"("client_id", "created_at");

CREATE INDEX "manual_removal_submissions_submission_status_idx"
    ON "manual_removal_submissions"("submission_status");
