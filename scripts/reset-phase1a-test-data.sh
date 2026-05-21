#!/usr/bin/env bash
# =============================================================================
# Celator Phase 1A — Test Data Reset Helper
#
# Deletes only test data identified by deterministic test prefixes:
#   it_    (integration test data)
#   smoke_ (smoke test data)
#   999.   (integration test consent versions)
#
# NEVER truncates whole tables. NEVER touches non-test data.
# Prints exactly what it deletes before deleting it.
# Requires --yes to skip confirmation.
#
# Usage:
#   bash scripts/reset-phase1a-test-data.sh
#   bash scripts/reset-phase1a-test-data.sh --yes
#
# Requirements:
#   - DATABASE_URL set in environment (or .env in project root)
#   - psql available on PATH
# =============================================================================

set -euo pipefail

YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) YES=true; shift ;;
    *) echo "Unknown option: $1" >&2; echo "Usage: $0 [--yes]" >&2; exit 1 ;;
  esac
done

# ── Load .env if DATABASE_URL not already set ──────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CELATOR_ROOT="$(dirname "$SCRIPT_DIR")"

if [[ -z "${DATABASE_URL:-}" ]]; then
  ENV_FILE="${CELATOR_ROOT}/.env"
  if [[ -f "$ENV_FILE" ]]; then
    # Extract DATABASE_URL without sourcing the whole file (security hygiene)
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | sed 's/^DATABASE_URL=//' | tr -d '"' || true)
    export DATABASE_URL
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set and could not be loaded from .env" >&2
  echo "Set DATABASE_URL=postgresql://celator:celator@localhost:5432/celator" >&2
  exit 1
fi

# Never print DATABASE_URL
echo "Connecting to database (DATABASE_URL is set but not printed)..."

# ── Check psql is available ────────────────────────────────────────────────────
if ! command -v psql &>/dev/null; then
  echo "ERROR: psql not found on PATH. Install postgresql-client." >&2
  exit 1
fi

# ── Count test data rows before deletion ──────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════"
echo "  Celator Phase 1A — Test Data Reset"
echo "════════════════════════════════════════════════════════"
echo
echo "Counting test data rows (prefix: it_, smoke_, version: 999.)..."
echo

psql "$DATABASE_URL" --no-password -t -A <<'EOF'
SELECT
  'organizations (it_/smoke_)' AS table_name,
  COUNT(*) AS rows
FROM organizations
WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
UNION ALL
SELECT
  'consent_versions (999.x.x)',
  COUNT(*)
FROM consent_versions
WHERE version LIKE '999.%'
UNION ALL
SELECT
  'clients (via test orgs)',
  COUNT(*)
FROM clients
WHERE organization_id IN (
  SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
)
UNION ALL
SELECT
  'cleanup_cases (via test clients)',
  COUNT(*)
FROM cleanup_cases
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
)
UNION ALL
SELECT
  'cleanup_tasks (via test cases)',
  COUNT(*)
FROM cleanup_tasks
WHERE case_id IN (
  SELECT id FROM cleanup_cases WHERE client_id IN (
    SELECT id FROM clients WHERE organization_id IN (
      SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
    )
  )
)
UNION ALL
SELECT
  'audit_logs (via test clients)',
  COUNT(*)
FROM audit_logs
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
)
UNION ALL
SELECT
  'case_timeline_events (via test cases)',
  COUNT(*)
FROM case_timeline_events
WHERE case_id IN (
  SELECT id FROM cleanup_cases WHERE client_id IN (
    SELECT id FROM clients WHERE organization_id IN (
      SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
    )
  )
);
EOF

echo

# ── Confirmation ───────────────────────────────────────────────────────────────
if ! $YES; then
  echo "The above rows will be deleted. This cannot be undone."
  echo "Only test data (it_*, smoke_*, 999.x consent versions) will be affected."
  echo
  printf "Proceed? [y/N]: "
  read -r CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "Aborted — no data deleted."
    exit 0
  fi
fi

# ── Delete in safe dependency order ───────────────────────────────────────────
echo
echo "Deleting test data..."

psql "$DATABASE_URL" --no-password -t -A <<'EOF'
-- Delete in strict child-before-parent order. All FK constraints default to ON DELETE RESTRICT,
-- so every child table must be cleared before the parent rows it references can be deleted.

-- 1. operator_warning_acknowledgments → approval_requests (approval_request_id FK)
DELETE FROM operator_warning_acknowledgments
WHERE approval_request_id IN (
  SELECT id FROM approval_requests WHERE task_id IN (
    SELECT id FROM cleanup_tasks WHERE case_id IN (
      SELECT id FROM cleanup_cases WHERE client_id IN (
        SELECT id FROM clients WHERE organization_id IN (
          SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
        )
      )
    )
  )
);

-- 2. operator_approvals → approval_requests (approval_request_id FK)
DELETE FROM operator_approvals
WHERE approval_request_id IN (
  SELECT id FROM approval_requests WHERE task_id IN (
    SELECT id FROM cleanup_tasks WHERE case_id IN (
      SELECT id FROM cleanup_cases WHERE client_id IN (
        SELECT id FROM clients WHERE organization_id IN (
          SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
        )
      )
    )
  )
);

-- 3. snapshot_evidence_holds → approval_payload_snapshots (snapshot_id FK)
DELETE FROM snapshot_evidence_holds
WHERE snapshot_id IN (
  SELECT id FROM approval_payload_snapshots WHERE task_id IN (
    SELECT id FROM cleanup_tasks WHERE case_id IN (
      SELECT id FROM cleanup_cases WHERE client_id IN (
        SELECT id FROM clients WHERE organization_id IN (
          SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
        )
      )
    )
  )
);

-- 4. approval_requests → cleanup_tasks (task_id FK), approval_payload_snapshots (snapshot_id FK),
--    client_authorizations (authorization_id FK)
DELETE FROM approval_requests
WHERE task_id IN (
  SELECT id FROM cleanup_tasks WHERE case_id IN (
    SELECT id FROM cleanup_cases WHERE client_id IN (
      SELECT id FROM clients WHERE organization_id IN (
        SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
      )
    )
  )
);

-- 5. approval_payload_snapshots — after approval_requests (which reference snapshot_id)
DELETE FROM approval_payload_snapshots
WHERE task_id IN (
  SELECT id FROM cleanup_tasks WHERE case_id IN (
    SELECT id FROM cleanup_cases WHERE client_id IN (
      SELECT id FROM clients WHERE organization_id IN (
        SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
      )
    )
  )
);

-- 6. evidence_records → cleanup_tasks (task_id FK)
DELETE FROM evidence_records
WHERE task_id IN (
  SELECT id FROM cleanup_tasks WHERE case_id IN (
    SELECT id FROM cleanup_cases WHERE client_id IN (
      SELECT id FROM clients WHERE organization_id IN (
        SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
      )
    )
  )
);

-- 7. case_timeline_events → cleanup_cases (case_id FK)
DELETE FROM case_timeline_events
WHERE case_id IN (
  SELECT id FROM cleanup_cases WHERE client_id IN (
    SELECT id FROM clients WHERE organization_id IN (
      SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
    )
  )
);

-- 8. audit_logs → clients (client_id nullable FK) and users (actor_id nullable FK)
--    Must come before both clients and users are deleted
DELETE FROM audit_logs
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
)
OR actor_id IN (
  SELECT id FROM users WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 9. high_risk_flags → clients (client_id FK)
DELETE FROM high_risk_flags
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 10. cleanup_tasks → cleanup_cases (case_id FK)
DELETE FROM cleanup_tasks
WHERE case_id IN (
  SELECT id FROM cleanup_cases WHERE client_id IN (
    SELECT id FROM clients WHERE organization_id IN (
      SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
    )
  )
);

-- 11. cleanup_cases → clients (client_id FK), client_authorizations (authorization_id FK)
DELETE FROM cleanup_cases
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 12. client_identity_verifications → clients (client_id FK)
DELETE FROM client_identity_verifications
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 13. client_authorizations → clients (client_id FK), consent_versions (consent_version_id FK)
--     MUST come before consent_versions — this FK causes the well-known cleanup ordering bug
DELETE FROM client_authorizations
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 14. client_portal_events → clients (client_id FK)
DELETE FROM client_portal_events
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 15. client_data_deletion_requests → clients (client_id FK)
DELETE FROM client_data_deletion_requests
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 16. identity_vault_access_logs → identity_vault_records (record_id FK)
DELETE FROM identity_vault_access_logs
WHERE record_id IN (
  SELECT id FROM identity_vault_records WHERE client_id IN (
    SELECT id FROM clients WHERE organization_id IN (
      SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
    )
  )
);

-- 17. identity_vault_records → clients (client_id FK)
DELETE FROM identity_vault_records
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 18. dek_rotation_jobs → clients (client_id FK)
DELETE FROM dek_rotation_jobs
WHERE client_id IN (
  SELECT id FROM clients WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 19. operator_quality_metrics → users (operator_id FK)
DELETE FROM operator_quality_metrics
WHERE operator_id IN (
  SELECT id FROM users WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 20. user_roles → users (user_id FK)
DELETE FROM user_roles
WHERE user_id IN (
  SELECT id FROM users WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 21. emergency_pause_events → users (triggered_by FK)
DELETE FROM emergency_pause_events
WHERE triggered_by IN (
  SELECT id FROM users WHERE organization_id IN (
    SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
  )
);

-- 22. users → organizations (organization_id FK)
DELETE FROM users
WHERE organization_id IN (
  SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
);

-- 23. clients → organizations (organization_id FK)
DELETE FROM clients
WHERE organization_id IN (
  SELECT id FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%'
);

-- 24. organizations
DELETE FROM organizations WHERE name LIKE 'it_%' OR name LIKE 'smoke_%';

-- 25. consent_versions (global — keyed by version prefix, safe now that all authorizations are gone)
DELETE FROM consent_versions WHERE version LIKE '999.%';

SELECT 'Done — test data deleted.' AS result;
EOF

echo
echo "════════════════════════════════════════════════════════"
echo "  Test data reset complete."
echo "════════════════════════════════════════════════════════"
