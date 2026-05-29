-- Phase 2C: Follow-Up Scheduler + Evidence Tracking
-- Adds FollowUpStatus enum and follow_up_reminders table.
-- Adds nullable clientId column to evidence_records for direct ownership scoping.

-- Enum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'DUE', 'COMPLETED', 'CANCELLED');

-- Add clientId to evidence_records (nullable — existing rows get NULL, new rows always set)
ALTER TABLE "evidence_records"
    ADD COLUMN "clientId" TEXT REFERENCES "clients"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX "evidence_records_clientId_idx" ON "evidence_records"("clientId");

-- follow_up_reminders
CREATE TABLE "follow_up_reminders" (
    "id"                   TEXT NOT NULL,
    "task_id"              TEXT NOT NULL REFERENCES "cleanup_tasks"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "client_id"            TEXT NOT NULL REFERENCES "clients"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "status"               "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "due_at"               TIMESTAMP(3) NOT NULL,
    "safe_note"            TEXT,
    "completed_at"         TIMESTAMP(3),
    "cancelled_at"         TIMESTAMP(3),
    "created_by_user_id"   TEXT,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "follow_up_reminders_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "follow_up_reminders_task_id_idx" ON "follow_up_reminders"("task_id");
CREATE INDEX "follow_up_reminders_client_due_idx" ON "follow_up_reminders"("client_id", "due_at");
CREATE INDEX "follow_up_reminders_status_due_idx" ON "follow_up_reminders"("status", "due_at");
