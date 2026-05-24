-- Phase 2A: Workflow Engine + Target Playbook Foundation
-- Creates enums, playbook templates, and workflow run tracking tables.
-- No PII is stored in any playbook or workflow model.

-- Enums
CREATE TYPE "PlaybookStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DEPRECATED');
CREATE TYPE "WorkflowRunStatus" AS ENUM ('IN_PROGRESS', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "WorkflowStepStatus" AS ENUM ('PENDING', 'READY', 'IN_PROGRESS', 'WAITING', 'COMPLETED', 'BLOCKED', 'SKIPPED', 'FAILED');
CREATE TYPE "WorkflowStepKind" AS ENUM ('VERIFY_TARGET_REQUIREMENTS', 'PREPARE_REMOVAL_DRAFT', 'OPERATOR_REVIEW', 'MANUAL_SUBMISSION', 'WAIT_FOR_CONFIRMATION', 'RECORD_OUTCOME', 'VERIFY_REMOVAL', 'CLOSE_TASK', 'CUSTOM');

-- removal_playbooks
CREATE TABLE "removal_playbooks" (
    "id"                     TEXT NOT NULL,
    "name"                   TEXT NOT NULL,
    "version"                TEXT NOT NULL,
    "source_type"            "SourceType",
    "data_source_target_id"  TEXT REFERENCES "data_source_targets"("id") ON UPDATE CASCADE ON DELETE SET NULL,
    "status"                 "PlaybookStatus" NOT NULL DEFAULT 'ACTIVE',
    "description"            TEXT,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "removal_playbooks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "removal_playbooks_name_version_key" ON "removal_playbooks"("name", "version");
CREATE INDEX "removal_playbooks_status_idx" ON "removal_playbooks"("status");
CREATE INDEX "removal_playbooks_dst_status_idx" ON "removal_playbooks"("data_source_target_id", "status");
CREATE INDEX "removal_playbooks_src_status_idx" ON "removal_playbooks"("source_type", "status");

-- removal_playbook_steps
CREATE TABLE "removal_playbook_steps" (
    "id"                       TEXT NOT NULL,
    "playbook_id"              TEXT NOT NULL REFERENCES "removal_playbooks"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "step_order"               INTEGER NOT NULL,
    "step_kind"                "WorkflowStepKind" NOT NULL,
    "title"                    TEXT NOT NULL,
    "instructions"             TEXT NOT NULL,
    "requires_approval"        BOOLEAN NOT NULL DEFAULT false,
    "requires_manual_submission" BOOLEAN NOT NULL DEFAULT false,
    "required_evidence_type"   TEXT,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,
    CONSTRAINT "removal_playbook_steps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "removal_playbook_steps_playbook_id_step_order_key" ON "removal_playbook_steps"("playbook_id", "step_order");
CREATE INDEX "removal_playbook_steps_playbook_id_idx" ON "removal_playbook_steps"("playbook_id");

-- task_workflow_runs
CREATE TABLE "task_workflow_runs" (
    "id"                  TEXT NOT NULL,
    "task_id"             TEXT NOT NULL REFERENCES "cleanup_tasks"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "client_id"           TEXT NOT NULL REFERENCES "clients"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "playbook_id"         TEXT NOT NULL REFERENCES "removal_playbooks"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "status"              "WorkflowRunStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "current_step_order"  INTEGER,
    "started_at"          TIMESTAMP(3),
    "completed_at"        TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "task_workflow_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "task_workflow_runs_task_id_idx" ON "task_workflow_runs"("task_id");
CREATE INDEX "task_workflow_runs_client_created_idx" ON "task_workflow_runs"("client_id", "created_at");
CREATE INDEX "task_workflow_runs_status_idx" ON "task_workflow_runs"("status");

-- task_workflow_step_runs
CREATE TABLE "task_workflow_step_runs" (
    "id"                  TEXT NOT NULL,
    "workflow_run_id"     TEXT NOT NULL REFERENCES "task_workflow_runs"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "playbook_step_id"    TEXT NOT NULL REFERENCES "removal_playbook_steps"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "step_order"          INTEGER NOT NULL,
    "step_kind"           "WorkflowStepKind" NOT NULL,
    "status"              "WorkflowStepStatus" NOT NULL DEFAULT 'PENDING',
    "operator_notes"      TEXT,
    "safe_result_summary" TEXT,
    "evidence_record_id"  TEXT REFERENCES "evidence_records"("id") ON UPDATE CASCADE ON DELETE SET NULL,
    "manual_submission_id" TEXT REFERENCES "manual_removal_submissions"("id") ON UPDATE CASCADE ON DELETE SET NULL,
    "started_at"          TIMESTAMP(3),
    "completed_at"        TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "task_workflow_step_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "task_workflow_step_runs_run_id_idx" ON "task_workflow_step_runs"("workflow_run_id");
CREATE INDEX "task_workflow_step_runs_run_order_idx" ON "task_workflow_step_runs"("workflow_run_id", "step_order");
