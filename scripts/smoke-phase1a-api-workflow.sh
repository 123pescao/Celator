#!/usr/bin/env bash
# =============================================================================
# Celator Phase 1A — API Workflow Smoke Test
#
# Exercises the full operator workflow against a running local API:
#   health → security/status → org → user → client → identity verification
#   → consent → authorization → case → task → review packet → approval
#   → timeline → audit logs
#
# All test data uses a timestamped prefix and is identified as synthetic.
# No real PII. No real external submissions.
#
# Usage:
#   bash scripts/smoke-phase1a-api-workflow.sh [--api-url http://127.0.0.1:3000]
#
# Requirements:
#   - API running (pnpm dev)
#   - curl
#   - jq (optional — degrades gracefully to raw output)
#
# Exit codes:
#   0  All required steps passed
#   1  One or more required steps failed
# =============================================================================

set -euo pipefail

API_URL="http://127.0.0.1:3000"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
FAILURES=0
STEP=0
JQ_AVAILABLE=false
if command -v jq &>/dev/null; then JQ_AVAILABLE=true; fi

pass()   { echo "  ✓  $*"; }
fail()   { echo "  ✗  $*" >&2; FAILURES=$((FAILURES + 1)); }
header() { STEP=$((STEP + 1)); echo; echo "── Step ${STEP}: $* ──────────────────────────────────"; }

# Generate a unique suffix for this test run — no PII
TS=$(date +%s)
RAND=$(tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c5 || echo "xxxxx")
SUFFIX="smoke_${TS}_${RAND}"

pretty_json() {
  if $JQ_AVAILABLE; then jq .; else cat; fi
}

# Call an endpoint and extract a JSON field via jq or grep fallback
# Usage: extract_field <json_string> <jq_path> <grep_fallback_key>
extract_field() {
  local json="$1" path="$2" key="$3"
  if $JQ_AVAILABLE; then
    echo "$json" | jq -r "$path" 2>/dev/null || echo ""
  else
    echo "$json" | grep -o "\"${key}\":\"[^\"]*\"" | head -1 | sed 's/.*":"\([^"]*\)".*/\1/' || echo ""
  fi
}

# POST or GET, return body; set LAST_CODE to HTTP status code
LAST_CODE=""
LAST_BODY=""
api_call() {
  local method="$1" path="$2" data="${3:-}"
  local url="${API_URL}${path}"
  local tmpfile
  tmpfile=$(mktemp)

  if [[ "$method" == "GET" ]]; then
    LAST_CODE=$(curl -s -o "$tmpfile" -w "%{http_code}" --max-time 10 --connect-timeout 5 "$url" 2>/dev/null || echo "000")
  else
    LAST_CODE=$(curl -s -o "$tmpfile" -w "%{http_code}" --max-time 10 --connect-timeout 5 \
      -X "$method" -H "Content-Type: application/json" -H "X-Dev-Actor-Id: smoke-actor" \
      -d "$data" "$url" 2>/dev/null || echo "000")
  fi
  LAST_BODY=$(cat "$tmpfile" 2>/dev/null || echo "{}")
  rm -f "$tmpfile"
}

require_ok() {
  local label="$1" expected_code="$2"
  if [[ "$LAST_CODE" == "000" ]]; then
    fail "${label}: API not reachable at ${API_URL} — is the server running? (pnpm dev)"
    return 1
  fi
  if [[ "$LAST_CODE" != "$expected_code" ]]; then
    fail "${label}: HTTP ${LAST_CODE} (expected ${expected_code})"
    if $JQ_AVAILABLE; then echo "$LAST_BODY" | jq . 2>/dev/null || echo "$LAST_BODY"; else echo "$LAST_BODY"; fi
    return 1
  fi
  pass "${label}: HTTP ${LAST_CODE}"
  return 0
}

# ── Step 1: Health ─────────────────────────────────────────────────────────────
header "GET /health"
api_call GET /health
if require_ok "GET /health" "200"; then
  if echo "$LAST_BODY" | grep -q '"ok":true'; then
    pass "health: ok=true"
  else
    fail "health: ok != true"
  fi
fi

# ── Step 2: Security status ────────────────────────────────────────────────────
header "GET /security/status"
api_call GET /security/status
if require_ok "GET /security/status" "200"; then
  if echo "$LAST_BODY" | grep -q '"reachable":true'; then
    pass "security/status: database.reachable=true"
  else
    fail "security/status: database.reachable != true"
  fi
  if echo "$LAST_BODY" | grep -q '"phase":"PHASE_1A_DB_CASE_MANAGEMENT"'; then
    pass "security/status: phase=PHASE_1A_DB_CASE_MANAGEMENT"
  else
    fail "security/status: phase field unexpected"
  fi
fi

# ── Step 3: Create organization ────────────────────────────────────────────────
header "POST /api/v1/organizations"
api_call POST /api/v1/organizations "{\"name\":\"${SUFFIX}_org\"}"
if require_ok "POST /api/v1/organizations" "201"; then
  ORG_ID=$(extract_field "$LAST_BODY" ".organization.id" "id")
  if [[ -n "$ORG_ID" && "$ORG_ID" != "null" ]]; then
    pass "organization created: ${ORG_ID}"
  else
    fail "organization: could not extract id from response"
    echo "$LAST_BODY"
    FAILURES=$((FAILURES + 1))
  fi
fi

# ── Step 4: Create operator user ───────────────────────────────────────────────
header "POST /api/v1/users"
api_call POST /api/v1/users "{\"organizationId\":\"${ORG_ID}\",\"email\":\"${SUFFIX}@smoke.invalid\",\"displayName\":\"Smoke Operator ${SUFFIX}\"}"
if require_ok "POST /api/v1/users" "201"; then
  USER_ID=$(extract_field "$LAST_BODY" ".user.id" "id")
  if [[ -n "$USER_ID" && "$USER_ID" != "null" ]]; then
    pass "user created: ${USER_ID}"
  else
    fail "user: could not extract id"
    echo "$LAST_BODY"
  fi
fi

# ── Step 5: Create client ──────────────────────────────────────────────────────
header "POST /api/v1/clients"
api_call POST /api/v1/clients "{\"organizationId\":\"${ORG_ID}\",\"displayName\":\"${SUFFIX}_client\"}"
if require_ok "POST /api/v1/clients" "201"; then
  CLIENT_ID=$(extract_field "$LAST_BODY" ".client.id" "id")
  CLIENT_STATUS=$(extract_field "$LAST_BODY" ".client.status" "status")
  if [[ -n "$CLIENT_ID" && "$CLIENT_ID" != "null" ]]; then
    pass "client created: ${CLIENT_ID}"
  else
    fail "client: could not extract id"
  fi
  if [[ "$CLIENT_STATUS" == "PENDING_IDENTITY_VERIFICATION" ]]; then
    pass "client starts in PENDING_IDENTITY_VERIFICATION"
  else
    fail "client: unexpected initial status: ${CLIENT_STATUS}"
  fi
fi

# ── Step 6: Create identity verification record ────────────────────────────────
header "POST /api/v1/clients/:clientId/identity-verification"
api_call POST "/api/v1/clients/${CLIENT_ID}/identity-verification" "{}"
if require_ok "POST /api/v1/clients/:id/identity-verification" "201"; then
  VERIFICATION_ID=$(extract_field "$LAST_BODY" ".verification.id" "id")
  if [[ -n "$VERIFICATION_ID" && "$VERIFICATION_ID" != "null" ]]; then
    pass "verification record created: ${VERIFICATION_ID}"
  else
    fail "verification: could not extract id"
    echo "$LAST_BODY"
  fi
fi

# ── Step 7: Attest the verification ───────────────────────────────────────────
header "POST /api/v1/identity-verifications/:id/attest"
api_call POST "/api/v1/identity-verifications/${VERIFICATION_ID}/attest" \
  "{\"operatorAttestation\":\"Smoke test: documents reviewed\",\"operatorId\":\"smoke-operator\"}"
if require_ok "POST /api/v1/identity-verifications/:id/attest" "200"; then
  ATTEST_STATUS=$(extract_field "$LAST_BODY" ".verification.status" "status")
  pass "attestation recorded (status=${ATTEST_STATUS})"
fi

# ── Step 8: Complete verification → activates client ──────────────────────────
header "POST /api/v1/identity-verifications/:id/complete"
api_call POST "/api/v1/identity-verifications/${VERIFICATION_ID}/complete" "{}"
if require_ok "POST /api/v1/identity-verifications/:id/complete" "200"; then
  VERIFY_STATUS=$(extract_field "$LAST_BODY" ".verification.status" "status")
  if [[ "$VERIFY_STATUS" == "VERIFIED" ]]; then
    pass "verification completed (status=VERIFIED)"
  else
    fail "verification: expected VERIFIED, got ${VERIFY_STATUS}"
  fi
fi

# ── Step 9: Confirm client is now ACTIVE ──────────────────────────────────────
header "GET /api/v1/clients/:id (confirm ACTIVE)"
api_call GET "/api/v1/clients/${CLIENT_ID}"
if require_ok "GET /api/v1/clients/:id" "200"; then
  ACTIVE_STATUS=$(extract_field "$LAST_BODY" ".client.status" "status")
  if [[ "$ACTIVE_STATUS" == "ACTIVE" ]]; then
    pass "client is now ACTIVE after verification"
  else
    fail "client: expected ACTIVE, got ${ACTIVE_STATUS}"
  fi
fi

# ── Step 10: Create consent version ───────────────────────────────────────────
header "POST /api/v1/consent-versions"
CV_VERSION="999.${TS}.0"
HASH=$(printf '%0.s0' {1..64})  # 64-char placeholder hash
api_call POST /api/v1/consent-versions \
  "{\"version\":\"${CV_VERSION}\",\"documentHash\":\"${HASH}\",\"effectiveFrom\":\"2026-01-01T00:00:00Z\"}"
if require_ok "POST /api/v1/consent-versions" "201"; then
  CONSENT_VERSION_ID=$(extract_field "$LAST_BODY" ".consentVersion.id" "id")
  if [[ -n "$CONSENT_VERSION_ID" && "$CONSENT_VERSION_ID" != "null" ]]; then
    pass "consent version created: ${CONSENT_VERSION_ID}"
  else
    fail "consent version: could not extract id"
    echo "$LAST_BODY"
  fi
fi

# ── Step 11: Create client authorization ──────────────────────────────────────
header "POST /api/v1/authorizations"
api_call POST /api/v1/authorizations \
  "{\"clientId\":\"${CLIENT_ID}\",\"consentVersionId\":\"${CONSENT_VERSION_ID}\",\"scopeNames\":[\"data_broker_opt_out\",\"people_search_removal\"],\"jurisdiction\":\"US-CA\",\"signedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
if require_ok "POST /api/v1/authorizations" "201"; then
  AUTHORIZATION_ID=$(extract_field "$LAST_BODY" ".authorization.id" "id")
  if [[ -n "$AUTHORIZATION_ID" && "$AUTHORIZATION_ID" != "null" ]]; then
    pass "authorization created: ${AUTHORIZATION_ID}"
  else
    fail "authorization: could not extract id"
    echo "$LAST_BODY"
  fi
fi

# ── Step 12: Create cleanup case ──────────────────────────────────────────────
header "POST /api/v1/cases"
api_call POST /api/v1/cases \
  "{\"clientId\":\"${CLIENT_ID}\",\"authorizationId\":\"${AUTHORIZATION_ID}\",\"title\":\"${SUFFIX}_case\"}"
if require_ok "POST /api/v1/cases" "201"; then
  CASE_ID=$(extract_field "$LAST_BODY" ".case.id" "id")
  if [[ -n "$CASE_ID" && "$CASE_ID" != "null" ]]; then
    pass "case created: ${CASE_ID}"
  else
    fail "case: could not extract id"
    echo "$LAST_BODY"
  fi
fi

# ── Step 13: Create cleanup task ──────────────────────────────────────────────
header "POST /api/v1/tasks"
api_call POST /api/v1/tasks \
  "{\"caseId\":\"${CASE_ID}\",\"clientId\":\"${CLIENT_ID}\",\"sourceRef\":\"${SUFFIX}.databroker.invalid\",\"matchStatus\":\"CONFIRMED_MATCH\",\"riskTier\":\"STANDARD\",\"actionType\":\"OPT_OUT\"}"
if require_ok "POST /api/v1/tasks" "201"; then
  TASK_ID=$(extract_field "$LAST_BODY" ".task.id" "id")
  if [[ -n "$TASK_ID" && "$TASK_ID" != "null" ]]; then
    pass "task created: ${TASK_ID}"
  else
    fail "task: could not extract id"
    echo "$LAST_BODY"
  fi
fi

# ── Step 14: Create review packet ─────────────────────────────────────────────
header "POST /api/v1/review-packets"
api_call POST /api/v1/review-packets \
  "{\"taskId\":\"${TASK_ID}\",\"authorizationId\":\"${AUTHORIZATION_ID}\",\"clientId\":\"${CLIENT_ID}\",\"redactedPreview\":\"Smoke test record — synthetic data only, no real PII\"}"
if require_ok "POST /api/v1/review-packets" "201"; then
  APPROVAL_REQUEST_ID=$(extract_field "$LAST_BODY" ".approvalRequest.id" "id")
  if [[ -n "$APPROVAL_REQUEST_ID" && "$APPROVAL_REQUEST_ID" != "null" ]]; then
    pass "review packet created, approval request: ${APPROVAL_REQUEST_ID}"
  else
    fail "review packet: could not extract approvalRequest.id"
    echo "$LAST_BODY"
  fi
fi

# ── Step 15: Approve the request ──────────────────────────────────────────────
header "POST /api/v1/approval-requests/:id/approve"
# Use the real USER_ID created in step 4 — OperatorApproval requires a valid User FK
api_call POST "/api/v1/approval-requests/${APPROVAL_REQUEST_ID}/approve" \
  "{\"operatorId\":\"${USER_ID}\",\"operatorOrganizationId\":\"${ORG_ID}\",\"clientId\":\"${CLIENT_ID}\",\"mfaFreshAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"sessionApprovalCount\":0,\"notes\":\"Smoke test approval\"}"
if require_ok "POST /api/v1/approval-requests/:id/approve" "200"; then
  APPROVAL_DECISION=$(extract_field "$LAST_BODY" ".approval.decision" "decision")
  if [[ "$APPROVAL_DECISION" == "APPROVED" ]]; then
    pass "approval recorded: decision=APPROVED"
  else
    fail "approval: expected APPROVED, got ${APPROVAL_DECISION}"
    echo "$LAST_BODY"
  fi
fi

# ── Step 16: Get case timeline ────────────────────────────────────────────────
header "GET /api/v1/cases/:caseId/timeline"
api_call GET "/api/v1/cases/${CASE_ID}/timeline"
if require_ok "GET /api/v1/cases/:caseId/timeline" "200"; then
  if echo "$LAST_BODY" | grep -q '"ok":true'; then
    EVENT_COUNT=0
    if $JQ_AVAILABLE; then
      EVENT_COUNT=$(echo "$LAST_BODY" | jq '.events | length' 2>/dev/null || echo "0")
    fi
    pass "timeline retrieved (${EVENT_COUNT} events)"
  else
    fail "timeline: ok != true"
  fi
fi

# ── Step 17: Get client audit logs ────────────────────────────────────────────
header "GET /api/v1/clients/:clientId/audit-logs"
api_call GET "/api/v1/clients/${CLIENT_ID}/audit-logs"
if require_ok "GET /api/v1/clients/:clientId/audit-logs" "200"; then
  if echo "$LAST_BODY" | grep -q '"ok":true'; then
    LOG_COUNT=0
    if $JQ_AVAILABLE; then
      LOG_COUNT=$(echo "$LAST_BODY" | jq '.auditLogs | length' 2>/dev/null || echo "0")
    fi
    pass "audit logs retrieved (${LOG_COUNT} records)"
    # Verify no secrets or PII-like strings in the audit log response
    if echo "$LAST_BODY" | grep -qiE '"[^"]*password[^"]*":|"[^"]*secret[^"]*":'; then
      fail "audit logs: response appears to contain secret/password keys"
    fi
  else
    fail "audit logs: ok != true"
  fi
fi

# ── Step 18: Validation — 400 on bad input ────────────────────────────────────
header "Validation: POST /api/v1/clients (bad body → 400)"
api_call POST /api/v1/clients "{\"displayName\":\"missing-org-id\"}"
if [[ "$LAST_CODE" == "400" ]]; then
  pass "bad input returns 400"
  if echo "$LAST_BODY" | grep -q '"VALIDATION_ERROR"'; then
    pass "error code is VALIDATION_ERROR"
  else
    fail "error code is not VALIDATION_ERROR"
  fi
else
  fail "bad input: expected 400, got ${LAST_CODE}"
fi

# ── Step 19: Not found returns 404 ────────────────────────────────────────────
header "GET /api/v1/clients/nonexistent-id → 404"
api_call GET /api/v1/clients/nonexistent-id-xxxxxxxxx
if [[ "$LAST_CODE" == "404" ]]; then
  pass "nonexistent resource returns 404"
else
  fail "nonexistent resource: expected 404, got ${LAST_CODE}"
fi

# ── Step 20: No stack traces in error responses ────────────────────────────────
header "Error responses contain no stack traces"
api_call POST /api/v1/clients "{}"
if echo "$LAST_BODY" | grep -qi '"stack":\|"stacktrace":\|at Object\.\|at async'; then
  fail "error response contains stack trace"
else
  pass "no stack traces in error responses"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════"
echo "  Smoke test suffix: ${SUFFIX}"
echo "  Test data org:     ${ORG_ID:-UNKNOWN}"
echo "  Test data client:  ${CLIENT_ID:-UNKNOWN}"
echo "════════════════════════════════════════════════════════"
if [[ $FAILURES -eq 0 ]]; then
  echo "  ALL SMOKE STEPS PASSED"
  echo "════════════════════════════════════════════════════════"
  exit 0
else
  echo "  ${FAILURES} STEP(S) FAILED — see output above"
  echo "════════════════════════════════════════════════════════"
  exit 1
fi
