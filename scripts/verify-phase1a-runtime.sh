#!/usr/bin/env bash
# =============================================================================
# Celator Phase 1A — Runtime Verification Script
#
# Checks that the local dev environment is properly set up and the API is
# responding correctly.  No secrets are printed or required.
#
# Usage:
#   bash scripts/verify-phase1a-runtime.sh [--api-url http://127.0.0.1:3000]
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
# =============================================================================

set -euo pipefail

# ── Configurable ──────────────────────────────────────────────────────────────
API_URL="http://127.0.0.1:3000"
CONTAINER_NAME="celator-postgres"
PASS_SYMBOL="✓"
FAIL_SYMBOL="✗"
SKIP_SYMBOL="–"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
FAILURES=0

pass()  { echo "  ${PASS_SYMBOL}  $*"; }
fail()  { echo "  ${FAIL_SYMBOL}  $*" >&2; FAILURES=$((FAILURES + 1)); }
skip()  { echo "  ${SKIP_SYMBOL}  $* (skipped)"; }
header(){ echo; echo "── $* ──────────────────────────────────────────────"; }

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" &>/dev/null; then
    fail "Command not found: $cmd"
    return 1
  fi
  pass "Command available: $cmd"
}

# ── Section 1: Prerequisites ──────────────────────────────────────────────────
header "Prerequisites"

if require_cmd node; then
  NODE_VERSION=$(node --version)
  MAJOR=${NODE_VERSION#v}; MAJOR=${MAJOR%%.*}
  if (( MAJOR >= 20 )); then
    pass "Node.js ${NODE_VERSION} (>= 20 required)"
  else
    fail "Node.js ${NODE_VERSION} is below the required v20"
  fi
fi

# Locate pnpm (may live in a non-standard path on this machine)
PNPM_BIN=$(command -v pnpm 2>/dev/null || echo "$HOME/.local/npm-global/bin/pnpm")
if [[ -x "$PNPM_BIN" ]]; then
  PNPM_VERSION=$("$PNPM_BIN" --version)
  pass "pnpm ${PNPM_VERSION} found at ${PNPM_BIN}"
else
  fail "pnpm not found (tried PATH and $HOME/.local/npm-global/bin/pnpm)"
fi

# curl is needed for health checks
require_cmd curl

# ── Section 2: Container ──────────────────────────────────────────────────────
header "Postgres container"

CONTAINER_RUNTIME=""
for rt in podman docker; do
  if command -v "$rt" &>/dev/null; then
    CONTAINER_RUNTIME="$rt"
    break
  fi
done

if [[ -z "$CONTAINER_RUNTIME" ]]; then
  fail "Neither podman nor docker found — cannot check container status"
else
  CONTAINER_STATUS=$("$CONTAINER_RUNTIME" inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "not_found")
  if [[ "$CONTAINER_STATUS" == "running" ]]; then
    pass "Container '$CONTAINER_NAME' is running (via $CONTAINER_RUNTIME)"
  elif [[ "$CONTAINER_STATUS" == "not_found" ]]; then
    fail "Container '$CONTAINER_NAME' not found — run: $CONTAINER_RUNTIME run (or compose up)"
  else
    fail "Container '$CONTAINER_NAME' status = '$CONTAINER_STATUS' (expected: running)"
  fi
fi

# ── Section 3: Prisma migration status ───────────────────────────────────────
header "Prisma migration status"

CELATOR_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -x "$PNPM_BIN" ]]; then
  # Run migrate status — exits nonzero if schema is not in sync
  MIGRATE_OUT=$("$PNPM_BIN" --filter @celator/db exec prisma migrate status 2>&1 || true)
  if echo "$MIGRATE_OUT" | grep -q "Database schema is up to date"; then
    pass "Prisma: database schema is up to date"
  elif echo "$MIGRATE_OUT" | grep -q "following migration.*not yet been applied"; then
    fail "Prisma: there are unapplied migrations — run: pnpm --filter @celator/db prisma:migrate:deploy"
  elif echo "$MIGRATE_OUT" | grep -q "connect\|ECONNREFUSED\|ENOTFOUND"; then
    fail "Prisma: cannot connect to database — is $CONTAINER_NAME running?"
  else
    # Print the output so the user can see what happened
    echo "$MIGRATE_OUT" | head -20
    fail "Prisma: unexpected migrate status output (see above)"
  fi
else
  skip "pnpm not available — skipping migrate status check"
fi

# ── Section 4: API health checks ─────────────────────────────────────────────
header "API health checks (${API_URL})"

call_endpoint() {
  local label="$1" path="$2" expected_key="$3" expected_val="$4"
  local url="${API_URL}${path}"
  local http_code body

  http_code=$(curl -s -o /tmp/celator_verify_body.json -w "%{http_code}" \
    --max-time 5 --connect-timeout 3 "$url" 2>/dev/null || echo "000")
  body=$(cat /tmp/celator_verify_body.json 2>/dev/null || echo "{}")

  if [[ "$http_code" == "000" ]]; then
    fail "${label}: API not reachable at ${url} — is the server running? (pnpm dev)"
    return
  fi

  if [[ "$http_code" != "200" ]]; then
    fail "${label}: HTTP ${http_code} (expected 200) from ${url}"
    return
  fi

  # Simple key=value check using grep on the JSON string
  if echo "$body" | grep -q "\"${expected_key}\":${expected_val}"; then
    pass "${label}: HTTP 200, ${expected_key}=${expected_val}"
  else
    fail "${label}: HTTP 200 but response body unexpected — ${expected_key} != ${expected_val}"
    echo "    Body: $(echo "$body" | head -c 300)"
  fi
}

call_endpoint "GET /health"           "/health"          "ok" "true"
call_endpoint "GET /security/status"  "/security/status" "ok" "true"

# Extra: check that /security/status now reports database.reachable=true
SECURITY_BODY=$(cat /tmp/celator_verify_body.json 2>/dev/null || echo "{}")
if echo "$SECURITY_BODY" | grep -q '"reachable":true'; then
  pass "/security/status: database.reachable = true"
elif echo "$SECURITY_BODY" | grep -q '"reachable":false'; then
  fail "/security/status: database.reachable = false — DB unreachable from the running API process"
else
  skip "/security/status: could not parse database.reachable (API may not have responded)"
fi

# Check phase field reflects Phase 1A
if echo "$SECURITY_BODY" | grep -q '"phase":"PHASE_1A_DB_CASE_MANAGEMENT"'; then
  pass "/security/status: phase = PHASE_1A_DB_CASE_MANAGEMENT"
else
  fail "/security/status: unexpected phase value (expected PHASE_1A_DB_CASE_MANAGEMENT)"
fi

# ── Section 5: Optional DB-backed endpoint smoke test ────────────────────────
header "DB-backed endpoint smoke test (optional)"

ORGS_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 5 --connect-timeout 3 \
  "${API_URL}/api/v1/organizations/nonexistent_org/clients" 2>/dev/null || echo "000")

if [[ "$ORGS_RESPONSE" == "200" ]]; then
  pass "GET /api/v1/organizations/:orgId/clients: HTTP 200 (DB reachable via service layer)"
elif [[ "$ORGS_RESPONSE" == "000" ]]; then
  skip "GET /api/v1/organizations/:orgId/clients: API not reachable"
else
  # 404 or 500 are acceptable — the point is we get a response from the DB layer
  pass "GET /api/v1/organizations/:orgId/clients: HTTP ${ORGS_RESPONSE} (API is routing)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════"
if [[ $FAILURES -eq 0 ]]; then
  echo "  ALL CHECKS PASSED"
  echo "════════════════════════════════════════════════════════"
  exit 0
else
  echo "  ${FAILURES} CHECK(S) FAILED — see output above"
  echo "════════════════════════════════════════════════════════"
  exit 1
fi
