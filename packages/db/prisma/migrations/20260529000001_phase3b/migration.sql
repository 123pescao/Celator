-- Phase 3B: Client Intake Session

CREATE TYPE "ClientIntakeStatus" AS ENUM (
  'STARTED',
  'CONTACT_CAPTURED',
  'CONSENT_PENDING',
  'IDENTITY_PENDING',
  'READY_FOR_REVIEW',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED'
);

CREATE TABLE "client_intake_sessions" (
  "id"                      TEXT NOT NULL,
  "client_id"               TEXT,
  "org_id"                  TEXT NOT NULL,
  "status"                  "ClientIntakeStatus" NOT NULL DEFAULT 'STARTED',
  "safe_contact_ref"        TEXT,
  "requested_action_types"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "requested_source_types"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL,
  "completed_at"            TIMESTAMP(3),
  "expires_at"              TIMESTAMP(3),

  CONSTRAINT "client_intake_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_intake_sessions_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "client_intake_sessions_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "client_intake_sessions_client_id_idx" ON "client_intake_sessions"("client_id");
CREATE INDEX "client_intake_sessions_org_id_idx" ON "client_intake_sessions"("org_id");
CREATE INDEX "client_intake_sessions_status_idx" ON "client_intake_sessions"("status");
