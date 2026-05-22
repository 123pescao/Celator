#!/usr/bin/env bash
# =============================================================================
# Celator Phase 1A/1C — API Workflow Smoke Test
#
# Exercises the full operator workflow against a running local API:
#   health → security/status → org → user → actor-validation → client
#   → identity verification → consent → authorization → case → task
#   → review packet → approval → timeline (assert > 0) → audit logs (assert > 0)
#
# Phase 1C: all write requests carry X-Dev-Actor-Id set to the real USER_ID
# created in step 4. Actor validation steps assert 401/403 for missing/invalid.
#
# No real PII. No real external submissions.
#
# Usage:
#   bash scripts/smoke-phase1a-api-workflow.sh [--api-url http://127.0.0.1:3000]
#
# Requirements:
#   - API running (pnpm dev)
#   - curl
#   - jq or node (optional — degrades to grep counting)
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
NODE_AVAILABLE=false
if command -v jq &>/dev/null; then JQ_AVAILABLE=true; fi
if command -v node &>/dev/null; then NODE_AVAILABLE=true; fi

pass()   { echo "  ✓  $*"; }
fail()   { echo "  ✗  $*" >&2; FAILURES=$((FAILURES + 1)); }
header() { STEP=$((STEP + 1)); echo; echo "── Step ${STEP}: $* ──────────────────────────────────"; }

# Generate a unique suffix for this test run — no PII
TS=$(date +%s)
RAND=$(tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c5 || echo "xxxxx")
SUFFIX="smoke_${TS}_${RAND}"

# Actor ID — empty until user is created in step 4; then set to the real USER_ID.
# All api_call() invocations after step 4 inherit this automatically.
ACTOR_ID=""

# Entity IDs — pre-initialized to prevent unbound-variable exits when upstream steps fail.
ORG_ID="" USER_ID="" CLIENT_ID="" VERIFICATION_ID="" CONSENT_VERSION_ID=""
AUTHORIZATION_ID="" CASE_ID="" TASK_ID="" APPROVAL_REQUEST_ID=""

# Extract a field from a JSON string.
# Usage: extract_field <json> <jq_path> <grep_key>
extract_field() {
  local json="$1" path="$2" key="$3"
  if $JQ_AVAILABLE; then
    echo "$json" | jq -r "$path" 2>/dev/null || echo ""
  else
    echo "$json" | grep -o "\"${key}\":\"[^\"]*\"" | head -1 | sed 's/.*":"\([^"]*\)".*/\1/' || echo ""
  fi
}

# Count elements in a JSON array field.
# Uses jq → node → grep fallback.
# Usage: count_array <json> <field_name>
count_array() {
  local json="$1" key="$2"
  if $JQ_AVAILABLE; then
    echo "$json" | jq ".${key} | length" 2>/dev/null || echo "0"
  elif $NODE_AVAILABLE; then
    echo "$json" | node -e \
      "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String((d['${key}']||[]).length));"
  else
    # Rough fallback: count objects in the field by counting opening braces
    echo "$json" | grep -o '"id"' | wc -l | tr -d ' '
  fi
}

# POST/PATCH/GET; auto-includes X-Dev-Actor-Id if ACTOR_ID is set.
# Can override actor per-call with 4th arg; pass "__none__" to omit entirely.
# Usage: api_call <METHOD> <PATH> [<json_data>] [<actor_override>]
LAST_CODE=""
LAST_BODY=""
api_call() {
  local method="$1" path="$2" data="${3:-}" actor="${4:-${ACTOR_ID}}"
  local url="${API_URL}${path}"
  local tmpfile
  tmpfile=$(mktemp)

  local actor_args=()
  if [[ "$actor" != "__none__" && -n "$actor" ]]; then
    actor_args=(-H "X-Dev-Actor-Id: ${actor}")
  fi

  if [[ "$method" == "GET" ]]; then
    LAST_CODE=$(curl -s -o "$tmpfile" -w "%{http_code}" --max-time 10 --connect-timeout 5 \
      "${actor_args[@]}" "$url" 2>/dev/null || echo "000")
  else
    LAST_CODE=$(curl -s -o "$tmpfile" -w "%{http_code}" --max-time 10 --connect-timeout 5 \
      -X "$method" -H "Content-Type: application/json" "${actor_args[@]}" \
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

# ── Step 3: Create organization (DEV_BOOTSTRAP — no actor required) ────────────
header "POST /api/v1/organizations"
api_call POST /api/v1/organizations "{\"name\":\"${SUFFIX}_org\"}" "__none__"
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

# ── Step 4: Create operator user (DEV_BOOTSTRAP — no actor required) ───────────
header "POST /api/v1/users"
api_call POST /api/v1/users \
  "{\"organizationId\":\"${ORG_ID}\",\"email\":\"${SUFFIX}@smoke.invalid\",\"displayName\":\"Smoke Operator ${SUFFIX}\"}" \
  "__none__"
if require_ok "POST /api/v1/users" "201"; then
  USER_ID=$(extract_field "$LAST_BODY" ".user.id" "id")
  if [[ -n "$USER_ID" && "$USER_ID" != "null" ]]; then
    pass "user created: ${USER_ID}"
    ACTOR_ID="$USER_ID"  # All subsequent write requests use this actor
  else
    fail "user: could not extract id"
    echo "$LAST_BODY"
  fi
fi

# ── Step 5: Actor validation — missing header returns 401 ──────────────────────
header "Actor validation: missing X-Dev-Actor-Id → 401"
api_call POST /api/v1/clients \
  "{\"organizationId\":\"${ORG_ID}\",\"displayName\":\"should-fail\"}" \
  "__none__"
if [[ "$LAST_CODE" == "401" ]]; then
  pass "missing actor header: HTTP 401"
  if echo "$LAST_BODY" | grep -q '"ACTOR_REQUIRED"'; then
    pass "error code is ACTOR_REQUIRED"
  else
    fail "error code is not ACTOR_REQUIRED (got: ${LAST_BODY})"
  fi
else
  fail "missing actor header: expected 401, got ${LAST_CODE}"
fi

# ── Step 6: Actor validation — invalid (non-existent) user ID → 401 ───────────
header "Actor validation: invalid X-Dev-Actor-Id → 401"
api_call POST /api/v1/clients \
  "{\"organizationId\":\"${ORG_ID}\",\"displayName\":\"should-fail\"}" \
  "nonexistent-user-id-xxxxxxxxxxx"
if [[ "$LAST_CODE" == "401" ]]; then
  pass "invalid actor id: HTTP 401"
  if echo "$LAST_BODY" | grep -q '"ACTOR_INVALID"'; then
    pass "error code is ACTOR_INVALID"
  else
    fail "error code is not ACTOR_INVALID (got: ${LAST_BODY})"
  fi
else
  fail "invalid actor id: expected 401, got ${LAST_CODE}"
fi

# ── Step 7: Create client ──────────────────────────────────────────────────────
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

# ── Step 8: Create identity verification record ────────────────────────────────
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

# ── Step 9: Attest the verification ───────────────────────────────────────────
header "POST /api/v1/identity-verifications/:id/attest"
# Phase 1C: operatorId comes from X-Dev-Actor-Id; not in body
api_call POST "/api/v1/identity-verifications/${VERIFICATION_ID}/attest" \
  "{\"operatorAttestation\":\"Smoke test: documents reviewed\"}"
if require_ok "POST /api/v1/identity-verifications/:id/attest" "200"; then
  ATTEST_STATUS=$(extract_field "$LAST_BODY" ".verification.status" "status")
  pass "attestation recorded (status=${ATTEST_STATUS})"
fi

# ── Step 10: Complete verification → activates client ─────────────────────────
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

# ── Step 11: Confirm client is now ACTIVE ─────────────────────────────────────
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

# ── Step 12: Create consent version ───────────────────────────────────────────
header "POST /api/v1/consent-versions"
# Split timestamp across two segments to avoid a 10-digit sequence in the version string.
# The phone-number PII pattern matches 10 consecutive digits; splitting avoids it.
CV_VERSION="999.$(( TS / 100000 )).$(( TS % 100000 ))"
# 64-char hex string using only letters — avoids triggering the digit-sequence PII filter
HASH="abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
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

# ── Step 13: Create client authorization ──────────────────────────────────────
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

# ── Step 14: Create cleanup case ──────────────────────────────────────────────
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

# ── Step 15: Create cleanup task ──────────────────────────────────────────────
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

# ── Step 16: Create review packet ─────────────────────────────────────────────
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

# ── Step 17: Approve the request ──────────────────────────────────────────────
header "POST /api/v1/approval-requests/:id/approve"
# Phase 1C: operatorId and operatorOrganizationId come from X-Dev-Actor-Id; not in body
api_call POST "/api/v1/approval-requests/${APPROVAL_REQUEST_ID}/approve" \
  "{\"clientId\":\"${CLIENT_ID}\",\"mfaFreshAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"sessionApprovalCount\":0,\"notes\":\"Smoke test approval\"}"
if require_ok "POST /api/v1/approval-requests/:id/approve" "200"; then
  APPROVAL_DECISION=$(extract_field "$LAST_BODY" ".approval.decision" "decision")
  if [[ "$APPROVAL_DECISION" == "APPROVED" ]]; then
    pass "approval recorded: decision=APPROVED"
  else
    fail "approval: expected APPROVED, got ${APPROVAL_DECISION}"
    echo "$LAST_BODY"
  fi
fi

# ── Step 18: Get case timeline — assert at least 1 event ──────────────────────
header "GET /api/v1/cases/:caseId/timeline"
api_call GET "/api/v1/cases/${CASE_ID}/timeline"
if require_ok "GET /api/v1/cases/:caseId/timeline" "200"; then
  if echo "$LAST_BODY" | grep -q '"ok":true'; then
    EVENT_COUNT=$(count_array "$LAST_BODY" "events")
    if [[ "${EVENT_COUNT:-0}" -gt 0 ]]; then
      pass "timeline: ${EVENT_COUNT} events (> 0)"
    else
      fail "timeline: expected at least 1 event, got ${EVENT_COUNT:-0}"
    fi
  else
    fail "timeline: ok != true"
  fi
fi

# ── Step 19: Get client audit logs — assert at least 1 log ────────────────────
header "GET /api/v1/clients/:clientId/audit-logs"
api_call GET "/api/v1/clients/${CLIENT_ID}/audit-logs"
if require_ok "GET /api/v1/clients/:clientId/audit-logs" "200"; then
  if echo "$LAST_BODY" | grep -q '"ok":true'; then
    LOG_COUNT=$(count_array "$LAST_BODY" "auditLogs")
    if [[ "${LOG_COUNT:-0}" -gt 0 ]]; then
      pass "audit logs: ${LOG_COUNT} records (> 0)"
    else
      fail "audit logs: expected at least 1 record, got ${LOG_COUNT:-0}"
    fi
    if echo "$LAST_BODY" | grep -qiE '"[^"]*password[^"]*":|"[^"]*secret[^"]*":'; then
      fail "audit logs: response appears to contain secret/password keys"
    else
      pass "audit logs: no secret/password keys in response"
    fi
  else
    fail "audit logs: ok != true"
  fi
fi

# ── Step 20: Validation — 400 on bad input ────────────────────────────────────
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

# ── Step 21: Not found returns 404 ────────────────────────────────────────────
header "GET /api/v1/clients/nonexistent-id → 404"
api_call GET /api/v1/clients/nonexistent-id-xxxxxxxxx
if [[ "$LAST_CODE" == "404" ]]; then
  pass "nonexistent resource returns 404"
else
  fail "nonexistent resource: expected 404, got ${LAST_CODE}"
fi

# ── Step 22: No stack traces in error responses ────────────────────────────────
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
echo "  Test data user:    ${USER_ID:-UNKNOWN}"
echo "  Test data client:  ${CLIENT_ID:-UNKNOWN}"
echo "════════════════════════════════════════════════════════"
if [[ $FAILURES -eq 0 ]]; then
  echo "  ALL SMOKE STEPS PASSED (22/22)"
  echo "════════════════════════════════════════════════════════"
  exit 0
else
  echo "  ${FAILURES} STEP(S) FAILED — see output above"
  echo "════════════════════════════════════════════════════════"
  exit 1
fi
