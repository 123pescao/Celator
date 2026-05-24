-- Phase 1D: PII boundary and vault intake foundation

-- Add encryptedKeyRef and redactedDisplay to IdentityVaultRecord
ALTER TABLE "identity_vault_records"
  ADD COLUMN "encrypted_key_ref" TEXT,
  ADD COLUMN "redacted_display" TEXT;

-- Add SourceType enum
CREATE TYPE "SourceType" AS ENUM (
  'DATA_BROKER',
  'SEARCH_ENGINE',
  'SOCIAL_PLATFORM',
  'PUBLIC_RECORD_SITE',
  'PEOPLE_SEARCH',
  'BREACH_INDEX',
  'OTHER'
);

-- Add DataSourceTarget table
CREATE TABLE "data_source_targets" (
  "id"                     TEXT NOT NULL,
  "source_name"            TEXT NOT NULL,
  "source_type"            "SourceType" NOT NULL,
  "base_domain"            TEXT,
  "jurisdiction"           TEXT,
  "supported_action_types" "ActionType"[],
  "requires_login"         BOOLEAN NOT NULL DEFAULT false,
  "requires_captcha"       BOOLEAN NOT NULL DEFAULT false,
  "manual_only"            BOOLEAN NOT NULL DEFAULT false,
  "pii_required_fields"    TEXT[],
  "notes"                  TEXT,
  "is_active"              BOOLEAN NOT NULL DEFAULT true,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "data_source_targets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "data_source_targets_source_name_key"
  ON "data_source_targets"("source_name");

CREATE INDEX "data_source_targets_source_type_is_active_idx"
  ON "data_source_targets"("source_type", "is_active");
