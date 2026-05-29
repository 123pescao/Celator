#!/usr/bin/env bash
# =============================================================================
# Celator Phase 1A/1C/1D/1E/1F/2A — API Workflow Smoke Test
#
# Exercises the full operator workflow against a running local API:
#   health → security/status → org → user → actor-validation → client
#   → identity verification → consent → authorization → case → task
#   → review packet → approval → timeline → audit logs
#   → vault record store → target registry → removal draft
#   → manual submission → submitted → outcome → PII boundary checks
#
# Phase 1C: all write requests carry X-Dev-Actor-Id set to the real USER_ID
# created in step 4. Actor validation steps assert 401/403 for missing/invalid.
#
# Phase 1D: vault intake steps store fake PII (smoke test values only),
# verify the response contains only redacted display, and verify the audit log
# does not leak the intake value.
#
# Phase 1F: manual removal submissions created, marked submitted, outcome
# recorded; all responses verified to be free of plaintext PII and ciphertext.
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
VAULT_RECORD_ID="" DATA_SOURCE_TARGET_ID="" SUBMISSION_ID=""

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

# ── Step 23: Vault — store a fake email (Phase 1D) ───────────────────────────
header "POST /api/v1/clients/:clientId/vault-records (store fake email)"
# Use a clearly fake value — not real PII
api_call POST "/api/v1/clients/${CLIENT_ID}/vault-records" \
  "{\"fieldType\":\"EMAIL\",\"value\":\"smoketest@vault.invalid\",\"purposeCode\":\"PURPOSE_OPERATOR_REVIEW_PACKET\"}"
if require_ok "POST /api/v1/clients/:id/vault-records" "201"; then
  VAULT_RECORD_ID=$(extract_field "$LAST_BODY" ".record.id" "id")
  VAULT_REDACTED=$(extract_field "$LAST_BODY" ".record.redactedDisplay" "redactedDisplay")
  if [[ -n "$VAULT_RECORD_ID" && "$VAULT_RECORD_ID" != "null" ]]; then
    pass "vault record created: ${VAULT_RECORD_ID}"
  else
    fail "vault: could not extract record.id"
    echo "$LAST_BODY"
  fi
  # Response must contain redacted display, not plaintext
  if echo "$LAST_BODY" | grep -q '"smoketest@vault.invalid"'; then
    fail "vault store: response contains plaintext email (should be redacted)"
  else
    pass "vault store: no plaintext in response"
  fi
  if [[ -n "$VAULT_REDACTED" && "$VAULT_REDACTED" != "null" ]]; then
    pass "vault store: redactedDisplay = ${VAULT_REDACTED}"
  else
    fail "vault store: missing redactedDisplay in response"
  fi
fi

# ── Step 24: Vault — list metadata (no plaintext, no ciphertext) ─────────────
header "GET /api/v1/clients/:clientId/vault-records"
api_call GET "/api/v1/clients/${CLIENT_ID}/vault-records"
if require_ok "GET /api/v1/clients/:id/vault-records" "200"; then
  VAULT_COUNT=$(count_array "$LAST_BODY" "records")
  if [[ "${VAULT_COUNT:-0}" -gt 0 ]]; then
    pass "vault list: ${VAULT_COUNT} record(s)"
  else
    fail "vault list: expected at least 1 record, got ${VAULT_COUNT:-0}"
  fi
  # Must not expose plaintext or ciphertext
  if echo "$LAST_BODY" | grep -q '"smoketest@vault.invalid"'; then
    fail "vault list: plaintext email found in response"
  else
    pass "vault list: no plaintext email in response"
  fi
  if echo "$LAST_BODY" | grep -q '"ciphertext"'; then
    fail "vault list: ciphertext field leaked in response"
  else
    pass "vault list: no ciphertext field in response"
  fi
fi

# ── Step 25: Vault — log an access event ─────────────────────────────────────
header "POST /api/v1/vault-records/:recordId/access"
api_call POST "/api/v1/vault-records/${VAULT_RECORD_ID}/access" \
  "{\"purposeCode\":\"PURPOSE_FORM_FILL\",\"reason\":\"Smoke test access log\"}"
if require_ok "POST /api/v1/vault-records/:id/access" "200"; then
  ACCESS_REDACTED=$(extract_field "$LAST_BODY" ".access.redactedDisplay" "redactedDisplay")
  ACCESS_PURPOSE=$(extract_field "$LAST_BODY" ".access.purposeCode" "purposeCode")
  if [[ "$ACCESS_PURPOSE" == "PURPOSE_FORM_FILL" ]]; then
    pass "vault access: purposeCode=PURPOSE_FORM_FILL"
  else
    fail "vault access: unexpected purposeCode: ${ACCESS_PURPOSE}"
  fi
  if echo "$LAST_BODY" | grep -q '"smoketest@vault.invalid"'; then
    fail "vault access: plaintext email found in response"
  else
    pass "vault access: no plaintext in response"
  fi
  pass "vault access: redactedDisplay = ${ACCESS_REDACTED}"
fi

# ── Step 26: Create data source target (Phase 1E) ─────────────────────────────
header "POST /api/v1/data-source-targets"
DST_NAME="smoke_broker_${SUFFIX}"
api_call POST "/api/v1/data-source-targets" \
  "{\"sourceName\":\"${DST_NAME}\",\"sourceType\":\"DATA_BROKER\",\"baseDomain\":\"smoke-broker.invalid\",\"piiRequiredFields\":[\"EMAIL\",\"FULL_NAME\"],\"supportedActionTypes\":[\"OPT_OUT\"]}"
if require_ok "POST /api/v1/data-source-targets" "201"; then
  DATA_SOURCE_TARGET_ID=$(extract_field "$LAST_BODY" ".target.id" "id")
  if [[ -n "$DATA_SOURCE_TARGET_ID" && "$DATA_SOURCE_TARGET_ID" != "null" ]]; then
    pass "data source target created: ${DATA_SOURCE_TARGET_ID}"
  else
    fail "data source target: could not extract id from response"
  fi
fi

# ── Step 27: Get target by ID ──────────────────────────────────────────────────
header "GET /api/v1/data-source-targets/:targetId"
api_call GET "/api/v1/data-source-targets/${DATA_SOURCE_TARGET_ID}"
if require_ok "GET /api/v1/data-source-targets/:id" "200"; then
  GOT_NAME=$(extract_field "$LAST_BODY" ".target.sourceName" "sourceName")
  if [[ "$GOT_NAME" == "$DST_NAME" ]]; then
    pass "target getById: sourceName matches"
  else
    fail "target getById: unexpected sourceName: ${GOT_NAME}"
  fi
fi

# ── Step 28: List active targets (Phase 1E) ────────────────────────────────────
header "GET /api/v1/data-source-targets"
api_call GET "/api/v1/data-source-targets"
if require_ok "GET /api/v1/data-source-targets" "200"; then
  TARGET_COUNT=$(count_array "$LAST_BODY" "targets")
  if [[ "$TARGET_COUNT" -ge 1 ]]; then
    pass "target list: ${TARGET_COUNT} active target(s)"
  else
    fail "target list: expected at least 1 active target, got ${TARGET_COUNT}"
  fi
fi

# ── Step 29: PATCH — deactivate then re-activate target ───────────────────────
header "PATCH /api/v1/data-source-targets/:targetId"
api_call PATCH "/api/v1/data-source-targets/${DATA_SOURCE_TARGET_ID}" \
  "{\"isActive\":false}"
if require_ok "PATCH /api/v1/data-source-targets/:id (deactivate)" "200"; then
  if echo "$LAST_BODY" | grep -q '"isActive":false'; then
    pass "target patch: isActive=false"
  else
    fail "target patch: expected isActive=false in response body"
  fi
fi
# Re-activate for subsequent steps
api_call PATCH "/api/v1/data-source-targets/${DATA_SOURCE_TARGET_ID}" \
  "{\"isActive\":true}"

# ── Step 30: Create task linked to data source target (Phase 1E) ───────────────
header "POST /api/v1/tasks (with dataSourceTargetId)"
api_call POST "/api/v1/tasks" \
  "{\"caseId\":\"${CASE_ID}\",\"clientId\":\"${CLIENT_ID}\",\"dataSourceTargetId\":\"${DATA_SOURCE_TARGET_ID}\",\"sourceRef\":\"smoke-broker\",\"riskTier\":\"STANDARD\"}"
LINKED_TASK_ID=""
if require_ok "POST /api/v1/tasks (linked to target)" "201"; then
  LINKED_TASK_ID=$(extract_field "$LAST_BODY" ".task.id" "id")
  if [[ -n "$LINKED_TASK_ID" && "$LINKED_TASK_ID" != "null" ]]; then
    pass "linked task created: ${LINKED_TASK_ID}"
  else
    fail "linked task: could not extract id"
  fi
fi

# ── Step 31: Generate removal request draft (Phase 1E) ─────────────────────────
header "POST /api/v1/clients/:clientId/removal-drafts"
api_call POST "/api/v1/clients/${CLIENT_ID}/removal-drafts" \
  "{\"dataSourceTargetId\":\"${DATA_SOURCE_TARGET_ID}\"}"
if require_ok "POST /api/v1/clients/:clientId/removal-drafts" "200"; then
  DRAFT_TARGET_ID=$(extract_field "$LAST_BODY" ".draft.targetId" "targetId")
  if [[ "$DRAFT_TARGET_ID" == "$DATA_SOURCE_TARGET_ID" ]]; then
    pass "removal draft: targetId matches"
  else
    fail "removal draft: unexpected targetId: ${DRAFT_TARGET_ID}"
  fi
  # Draft should NOT contain plaintext email used in vault step
  if echo "$LAST_BODY" | grep -q '"smoketest@vault.invalid"'; then
    fail "removal draft: plaintext email found in draft response"
  else
    pass "removal draft: no plaintext PII in response"
  fi
  # Draft should NOT contain ciphertext fields
  if echo "$LAST_BODY" | grep -qE '"ciphertext"|"authTag"|"encryptedKeyRef"'; then
    fail "removal draft: ciphertext field found in response"
  else
    pass "removal draft: no ciphertext fields in response"
  fi
  if echo "$LAST_BODY" | grep -qE '"isReadyForReview":true|"isReadyForReview":false'; then
    pass "removal draft: isReadyForReview field present"
  else
    fail "removal draft: isReadyForReview field missing from response"
  fi
fi

# ── Step 32: Get target by name (Phase 1E) ─────────────────────────────────────
header "GET /api/v1/data-source-targets/by-name/:sourceName"
ENCODED_NAME=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${DST_NAME}'))" 2>/dev/null || echo "${DST_NAME}")
api_call GET "/api/v1/data-source-targets/by-name/${ENCODED_NAME}"
if require_ok "GET /api/v1/data-source-targets/by-name/:sourceName" "200"; then
  BY_NAME_ID=$(extract_field "$LAST_BODY" ".target.id" "id")
  if [[ "$BY_NAME_ID" == "$DATA_SOURCE_TARGET_ID" ]]; then
    pass "target by-name: id matches"
  else
    fail "target by-name: unexpected id: ${BY_NAME_ID}"
  fi
fi

# ── Step 33: Create manual submission for linked task (Phase 1F) ───────────────
header "POST /api/v1/tasks/:taskId/manual-submissions"
REDACTED_SUMMARY="OPT_OUT to smoke_broker — EMAIL: s***@vault.invalid"
api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/manual-submissions" \
  "{\"clientId\":\"${CLIENT_ID}\",\"submissionMethod\":\"WEB_FORM\",\"redactedSummary\":\"${REDACTED_SUMMARY}\"}"
SUBMISSION_ID=""
if require_ok "POST /tasks/:taskId/manual-submissions" "201"; then
  SUBMISSION_ID=$(extract_field "$LAST_BODY" ".submission.id" "id")
  if [[ -n "$SUBMISSION_ID" && "$SUBMISSION_ID" != "null" ]]; then
    pass "manual submission created: ${SUBMISSION_ID}"
  else
    fail "manual submission: could not extract id"
  fi
fi

# ── Step 34: GET submissions for task ──────────────────────────────────────────
header "GET /api/v1/tasks/:taskId/manual-submissions"
api_call GET "/api/v1/tasks/${LINKED_TASK_ID}/manual-submissions"
if require_ok "GET /tasks/:taskId/manual-submissions" "200"; then
  SUB_COUNT=$(count_array "$LAST_BODY" "submissions")
  if [[ "$SUB_COUNT" -ge 1 ]]; then
    pass "task submissions list: ${SUB_COUNT} submission(s)"
  else
    fail "task submissions list: expected at least 1, got ${SUB_COUNT}"
  fi
fi

# ── Step 35: GET submissions for client ────────────────────────────────────────
header "GET /api/v1/clients/:clientId/manual-submissions"
api_call GET "/api/v1/clients/${CLIENT_ID}/manual-submissions"
if require_ok "GET /clients/:clientId/manual-submissions" "200"; then
  CLIENT_SUB_COUNT=$(count_array "$LAST_BODY" "submissions")
  if [[ "$CLIENT_SUB_COUNT" -ge 1 ]]; then
    pass "client submissions list: ${CLIENT_SUB_COUNT} submission(s)"
  else
    fail "client submissions list: expected at least 1, got ${CLIENT_SUB_COUNT}"
  fi
fi

# ── Step 36: Mark submission as submitted ──────────────────────────────────────
header "POST /api/v1/manual-submissions/:submissionId/submitted"
api_call POST "/api/v1/manual-submissions/${SUBMISSION_ID}/submitted" \
  "{\"clientId\":\"${CLIENT_ID}\",\"confirmationCode\":\"REF-SMOKE-001\"}"
if require_ok "POST /manual-submissions/:id/submitted" "200"; then
  if echo "$LAST_BODY" | grep -q '"submissionStatus":"SUBMITTED"'; then
    pass "submission status: SUBMITTED"
  else
    fail "submission: expected submissionStatus SUBMITTED in response"
  fi
  # Confirm no plaintext PII in the response
  if echo "$LAST_BODY" | grep -q '"smoketest@vault.invalid"'; then
    fail "submission: plaintext vault email found in response"
  else
    pass "submission submitted: no plaintext PII in response"
  fi
  if echo "$LAST_BODY" | grep -qE '"ciphertext"|"authTag"|"encryptedKeyRef"'; then
    fail "submission submitted: ciphertext field in response"
  else
    pass "submission submitted: no ciphertext in response"
  fi
fi

# ── Step 37: Record outcome — ACKNOWLEDGED ─────────────────────────────────────
header "POST /api/v1/manual-submissions/:submissionId/outcome (ACKNOWLEDGED)"
api_call POST "/api/v1/manual-submissions/${SUBMISSION_ID}/outcome" \
  "{\"clientId\":\"${CLIENT_ID}\",\"status\":\"ACKNOWLEDGED\",\"operatorNotes\":\"Broker acknowledged receipt\"}"
if require_ok "POST /manual-submissions/:id/outcome (ACKNOWLEDGED)" "200"; then
  if echo "$LAST_BODY" | grep -q '"submissionStatus":"ACKNOWLEDGED"'; then
    pass "outcome: submissionStatus ACKNOWLEDGED"
  else
    fail "outcome: expected submissionStatus ACKNOWLEDGED"
  fi
fi

# ── Step 38: Create a second submission and record COMPLETED outcome ────────────
header "POST /api/v1/manual-submissions/:id/outcome (COMPLETED)"
api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/manual-submissions" \
  "{\"clientId\":\"${CLIENT_ID}\",\"submissionMethod\":\"EMAIL\",\"redactedSummary\":\"OPT_OUT to smoke_broker — EMAIL: s***@vault.invalid\"}"
SUBMISSION_ID2=""
if require_ok "POST /tasks/:taskId/manual-submissions (second)" "201"; then
  SUBMISSION_ID2=$(extract_field "$LAST_BODY" ".submission.id" "id")
  if [[ -n "$SUBMISSION_ID2" && "$SUBMISSION_ID2" != "null" ]]; then
    pass "second submission created: ${SUBMISSION_ID2}"
  else
    fail "second submission: could not extract id"
  fi
fi
# Mark as submitted first
api_call POST "/api/v1/manual-submissions/${SUBMISSION_ID2}/submitted" \
  "{\"clientId\":\"${CLIENT_ID}\"}"
# Then record COMPLETED
api_call POST "/api/v1/manual-submissions/${SUBMISSION_ID2}/outcome" \
  "{\"clientId\":\"${CLIENT_ID}\",\"status\":\"COMPLETED\"}"
if require_ok "POST /manual-submissions/:id/outcome (COMPLETED)" "200"; then
  if echo "$LAST_BODY" | grep -q '"submissionStatus":"COMPLETED"'; then
    pass "outcome: submissionStatus COMPLETED"
  else
    fail "outcome: expected submissionStatus COMPLETED"
  fi
fi

# ── Step 39: Verify terminal status rejects further outcome ────────────────────
header "POST /api/v1/manual-submissions/:id/outcome (terminal rejection)"
api_call POST "/api/v1/manual-submissions/${SUBMISSION_ID2}/outcome" \
  "{\"clientId\":\"${CLIENT_ID}\",\"status\":\"ACKNOWLEDGED\"}"
if echo "$LAST_BODY" | grep -q '"MANUAL_SUBMISSION_INVALID_STATUS"'; then
  pass "terminal rejection: correct error MANUAL_SUBMISSION_INVALID_STATUS"
elif [[ "$LAST_CODE" == "400" ]]; then
  pass "terminal rejection: HTTP 400 as expected"
else
  fail "terminal rejection: expected 400 for outcome on terminal submission, got ${LAST_CODE}"
fi

# ── Step 40: Assert timeline and audit logs include new submission events ───────
header "Timeline + audit logs include manual submission events"
api_call GET "/api/v1/cases/${CASE_ID}/timeline"
if require_ok "GET /cases/:caseId/timeline" "200"; then
  if echo "$LAST_BODY" | grep -q 'MANUAL_SUBMISSION'; then
    pass "timeline: contains MANUAL_SUBMISSION event(s)"
  else
    fail "timeline: no MANUAL_SUBMISSION events found"
  fi
fi
api_call GET "/api/v1/clients/${CLIENT_ID}/audit-logs"
if require_ok "GET /clients/:clientId/audit-logs" "200"; then
  if echo "$LAST_BODY" | grep -q 'MANUAL_SUBMISSION'; then
    pass "audit logs: contains MANUAL_SUBMISSION event(s)"
  else
    fail "audit logs: no MANUAL_SUBMISSION events found"
  fi
fi

# =============================================================================
# Phase 2A: Workflow Engine + Playbooks (Steps 41–52)
# =============================================================================

PLAYBOOK_ID=""
WORKFLOW_RUN_ID=""
FIRST_STEP_RUN_ID=""
MANUAL_SUB_STEP_RUN_ID=""

# ── Step 41: Create a generic playbook ─────────────────────────────────────────
header "POST /api/v1/removal-playbooks (create generic playbook)"
api_call POST "/api/v1/removal-playbooks" \
  "{\"name\":\"Smoke Broker Opt-Out ${SUFFIX}\",\"version\":\"1.0.0\",\"sourceType\":\"DATA_BROKER\",\"description\":\"Smoke test playbook\",\"steps\":[{\"stepOrder\":1,\"stepKind\":\"VERIFY_TARGET_REQUIREMENTS\",\"title\":\"Verify Requirements\",\"instructions\":\"Check that the broker target is active and requirements are met.\"},{\"stepOrder\":2,\"stepKind\":\"MANUAL_SUBMISSION\",\"title\":\"Submit Opt-Out\",\"instructions\":\"Submit the opt-out request via the broker portal.\",\"requiresManualSubmission\":true},{\"stepOrder\":3,\"stepKind\":\"RECORD_OUTCOME\",\"title\":\"Record Outcome\",\"instructions\":\"Record the broker response after processing.\"},{\"stepOrder\":4,\"stepKind\":\"CLOSE_TASK\",\"title\":\"Close Task\",\"instructions\":\"Mark the task complete.\"}]}"
if require_ok "POST /removal-playbooks" "201"; then
  PLAYBOOK_ID=$(extract_field "$LAST_BODY" ".playbook.id" "id")
  if [[ -n "$PLAYBOOK_ID" && "$PLAYBOOK_ID" != "null" ]]; then
    pass "playbook created: ${PLAYBOOK_ID}"
    # Verify step count
    if echo "$LAST_BODY" | grep -q '"stepOrder":4'; then
      pass "playbook: 4 steps present"
    else
      fail "playbook: expected 4 steps in response"
    fi
  else
    fail "playbook: could not extract id"
  fi
  # No ciphertext in response
  if echo "$LAST_BODY" | grep -qE '"ciphertext"|"authTag"'; then
    fail "playbook: ciphertext field leaked in response"
  else
    pass "playbook: no ciphertext in response"
  fi
fi

# ── Step 42: GET list of active playbooks ──────────────────────────────────────
header "GET /api/v1/removal-playbooks"
api_call GET "/api/v1/removal-playbooks"
if require_ok "GET /removal-playbooks" "200"; then
  PB_COUNT=$(count_array "$LAST_BODY" "playbooks")
  if [[ "$PB_COUNT" -ge 1 ]]; then
    pass "playbooks list: ${PB_COUNT} playbook(s)"
  else
    fail "playbooks list: expected at least 1, got ${PB_COUNT}"
  fi
fi

# ── Step 43: GET single playbook with steps ────────────────────────────────────
header "GET /api/v1/removal-playbooks/:playbookId"
api_call GET "/api/v1/removal-playbooks/${PLAYBOOK_ID}"
if require_ok "GET /removal-playbooks/:id" "200"; then
  if echo "$LAST_BODY" | grep -q '"stepOrder":1'; then
    pass "playbook detail: steps present"
  else
    fail "playbook detail: steps not found in response"
  fi
fi

# ── Step 44: Start workflow for task ───────────────────────────────────────────
header "POST /api/v1/tasks/:taskId/workflow-runs (start workflow)"
api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/workflow-runs" \
  "{\"clientId\":\"${CLIENT_ID}\",\"playbookId\":\"${PLAYBOOK_ID}\"}"
if require_ok "POST /tasks/:taskId/workflow-runs" "201"; then
  WORKFLOW_RUN_ID=$(extract_field "$LAST_BODY" ".workflowState.run.id" "id")
  if [[ -n "$WORKFLOW_RUN_ID" && "$WORKFLOW_RUN_ID" != "null" ]]; then
    pass "workflow run started: ${WORKFLOW_RUN_ID}"
  else
    fail "workflow run: could not extract run id"
  fi
  if echo "$LAST_BODY" | grep -q '"status":"IN_PROGRESS"'; then
    pass "workflow run: status is IN_PROGRESS"
  else
    fail "workflow run: expected IN_PROGRESS status"
  fi
  # First step should be READY
  if echo "$LAST_BODY" | grep -q '"status":"READY"'; then
    pass "workflow run: first step is READY"
    # Extract first READY step run id (2nd "id" in response — first is the run id)
    if $JQ_AVAILABLE; then
      FIRST_STEP_RUN_ID=$(echo "$LAST_BODY" | jq -r '.workflowState.steps[0].id' 2>/dev/null || echo "")
    else
      FIRST_STEP_RUN_ID=$(echo "$LAST_BODY" | grep -o '"id":"[^"]*"' | head -2 | tail -1 | sed 's/.*":"\([^"]*\)".*/\1/' || echo "")
    fi
  else
    fail "workflow run: no READY step found"
  fi
  # No PII in response
  if echo "$LAST_BODY" | grep -qE '"ciphertext"|"authTag"'; then
    fail "workflow run: ciphertext leaked"
  else
    pass "workflow run: no ciphertext in response"
  fi
fi

# ── Step 45: GET workflow state for task ───────────────────────────────────────
header "GET /api/v1/tasks/:taskId/workflow-run"
api_call GET "/api/v1/tasks/${LINKED_TASK_ID}/workflow-run"
if require_ok "GET /tasks/:taskId/workflow-run" "200"; then
  if echo "$LAST_BODY" | grep -q '"IN_PROGRESS"'; then
    pass "workflow state: run is IN_PROGRESS"
  else
    fail "workflow state: expected IN_PROGRESS"
  fi
fi

# ── Step 46: Advance first step ────────────────────────────────────────────────
header "POST /api/v1/workflow-runs/:runId/steps/:stepId/advance (step 1)"
api_call POST "/api/v1/workflow-runs/${WORKFLOW_RUN_ID}/steps/${FIRST_STEP_RUN_ID}/advance" \
  "{\"clientId\":\"${CLIENT_ID}\",\"safeResultSummary\":\"Target broker is active and requirements confirmed\"}"
if require_ok "POST /workflow-runs/:runId/steps/:stepId/advance" "200"; then
  if echo "$LAST_BODY" | grep -q '"COMPLETED"'; then
    pass "step advance: first step is COMPLETED"
  else
    fail "step advance: expected COMPLETED status in response"
  fi
  # Extract MANUAL_SUBMISSION step run id (second step should now be READY)
  if $JQ_AVAILABLE; then
    MANUAL_SUB_STEP_RUN_ID=$(echo "$LAST_BODY" | jq -r '.workflowState.steps[] | select(.stepKind=="MANUAL_SUBMISSION") | .id' 2>/dev/null || echo "")
  else
    # Fallback: grab second step id
    MANUAL_SUB_STEP_RUN_ID=$(echo "$LAST_BODY" | grep -o '"id":"[^"]*"' | head -3 | tail -1 | sed 's/.*":"\([^"]*\)".*/\1/' || echo "")
  fi
  if echo "$LAST_BODY" | grep -q '"READY"'; then
    pass "step advance: next step is READY"
  else
    fail "step advance: next step not READY"
  fi
fi

# ── Step 47: Link existing manual submission to MANUAL_SUBMISSION step ─────────
header "POST /api/v1/workflow-runs/:runId/steps/:stepId/manual-submission"
# Re-use the SUBMISSION_ID from Phase 1F if available, else skip gracefully
if [[ -n "$MANUAL_SUB_STEP_RUN_ID" && -n "$SUBMISSION_ID" ]]; then
  api_call POST "/api/v1/workflow-runs/${WORKFLOW_RUN_ID}/steps/${MANUAL_SUB_STEP_RUN_ID}/manual-submission" \
    "{\"clientId\":\"${CLIENT_ID}\",\"manualSubmissionId\":\"${SUBMISSION_ID}\"}"
  if require_ok "POST /workflow-runs/:runId/steps/:stepId/manual-submission" "200"; then
    if echo "$LAST_BODY" | grep -q "\"${SUBMISSION_ID}\""; then
      pass "manual submission linked: ${SUBMISSION_ID}"
    else
      fail "manual submission link: submission id not in response"
    fi
  fi
else
  pass "manual submission link: skipped (MANUAL_SUB_STEP_RUN_ID or SUBMISSION_ID not available)"
fi

# ── Step 48: Reject linking submission to wrong step kind ──────────────────────
header "POST /workflow-runs/:runId/steps/:stepId/manual-submission (wrong step kind)"
# Attempt to link to the first (already completed VERIFY_TARGET_REQUIREMENTS) step
# Use FIRST_STEP_RUN_ID which is VERIFY_TARGET_REQUIREMENTS kind
if [[ -n "$FIRST_STEP_RUN_ID" && -n "$SUBMISSION_ID" ]]; then
  api_call POST "/api/v1/workflow-runs/${WORKFLOW_RUN_ID}/steps/${FIRST_STEP_RUN_ID}/manual-submission" \
    "{\"clientId\":\"${CLIENT_ID}\",\"manualSubmissionId\":\"${SUBMISSION_ID}\"}"
  if echo "$LAST_BODY" | grep -q '"WORKFLOW_INVALID_TRANSITION"'; then
    pass "wrong step kind: correctly rejected with WORKFLOW_INVALID_TRANSITION"
  elif [[ "$LAST_CODE" == "400" ]]; then
    pass "wrong step kind: HTTP 400 as expected"
  else
    fail "wrong step kind: expected 400, got ${LAST_CODE}"
  fi
else
  pass "wrong step kind: skipped (ids not available)"
fi

# ── Step 49: Block a step ──────────────────────────────────────────────────────
# Start a second workflow run to block
header "POST /workflow-runs/:runId/steps/:stepId/block"
api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/workflow-runs" \
  "{\"clientId\":\"${CLIENT_ID}\",\"playbookId\":\"${PLAYBOOK_ID}\"}"
WORKFLOW_RUN_ID2=""
FIRST_STEP_RUN_ID2=""
if require_ok "POST /tasks/:taskId/workflow-runs (second run)" "201"; then
  WORKFLOW_RUN_ID2=$(extract_field "$LAST_BODY" ".workflowState.run.id" "id")
  if $JQ_AVAILABLE; then
    FIRST_STEP_RUN_ID2=$(echo "$LAST_BODY" | jq -r '.workflowState.steps[0].id' 2>/dev/null || echo "")
  else
    FIRST_STEP_RUN_ID2=$(echo "$LAST_BODY" | grep -o '"id":"[^"]*"' | head -2 | tail -1 | sed 's/.*":"\([^"]*\)".*/\1/' || echo "")
  fi
  pass "second workflow run created: ${WORKFLOW_RUN_ID2:-UNKNOWN}"
fi

if [[ -n "$WORKFLOW_RUN_ID2" && -n "$FIRST_STEP_RUN_ID2" ]]; then
  api_call POST "/api/v1/workflow-runs/${WORKFLOW_RUN_ID2}/steps/${FIRST_STEP_RUN_ID2}/block" \
    "{\"clientId\":\"${CLIENT_ID}\",\"reason\":\"Broker portal is currently unavailable\"}"
  if require_ok "POST /workflow-runs/:runId/steps/:stepId/block" "200"; then
    if echo "$LAST_BODY" | grep -q '"BLOCKED"'; then
      pass "block step: run and step are BLOCKED"
    else
      fail "block step: expected BLOCKED status in response"
    fi
  fi
else
  pass "block step: skipped (second run ids not available)"
fi

# ── Step 50: Reject PII in playbook creation ────────────────────────────────────
header "POST /api/v1/removal-playbooks (PII in instructions — should reject)"
api_call POST "/api/v1/removal-playbooks" \
  "{\"name\":\"Bad Playbook\",\"version\":\"9.0.0\",\"steps\":[{\"stepOrder\":1,\"stepKind\":\"MANUAL_SUBMISSION\",\"title\":\"Submit\",\"instructions\":\"Email admin@badbroker.com for opt-out.\"}]}"
if echo "$LAST_BODY" | grep -q '"WORKFLOW_UNSAFE_TEXT"'; then
  pass "PII in instructions: correctly rejected WORKFLOW_UNSAFE_TEXT"
elif [[ "$LAST_CODE" == "400" ]]; then
  pass "PII in instructions: HTTP 400 as expected"
else
  fail "PII in instructions: expected 400, got ${LAST_CODE}"
fi

# ── Step 51: Assert timeline contains WORKFLOW events ──────────────────────────
header "Timeline includes WORKFLOW events"
api_call GET "/api/v1/cases/${CASE_ID}/timeline"
if require_ok "GET /cases/:caseId/timeline" "200"; then
  if echo "$LAST_BODY" | grep -q 'WORKFLOW'; then
    pass "timeline: contains WORKFLOW event(s)"
  else
    fail "timeline: no WORKFLOW events found"
  fi
fi

# ── Step 52: Assert audit logs contain WORKFLOW events + no PII ────────────────
header "Audit logs include WORKFLOW events and no plaintext PII"
api_call GET "/api/v1/clients/${CLIENT_ID}/audit-logs"
if require_ok "GET /clients/:clientId/audit-logs" "200"; then
  if echo "$LAST_BODY" | grep -q 'WORKFLOW'; then
    pass "audit logs: contains WORKFLOW event(s)"
  else
    fail "audit logs: no WORKFLOW events found"
  fi
  # No ciphertext or vault fields in audit logs
  if echo "$LAST_BODY" | grep -qE '"ciphertext"|"authTag"|"encryptedKeyRef"'; then
    fail "audit logs: ciphertext field in response"
  else
    pass "audit logs: no ciphertext in response"
  fi
fi

# ── Step 53: Unblock a blocked workflow step ───────────────────────────────────
header "POST /workflow-runs/:runId/steps/:stepId/unblock"
if [[ -n "$WORKFLOW_RUN_ID2" && -n "$FIRST_STEP_RUN_ID2" ]]; then
  api_call POST "/api/v1/workflow-runs/${WORKFLOW_RUN_ID2}/steps/${FIRST_STEP_RUN_ID2}/unblock" \
    "{\"clientId\":\"${CLIENT_ID}\"}"
  if require_ok "POST /workflow-runs/:runId/steps/:stepId/unblock" "200"; then
    if echo "$LAST_BODY" | grep -q '"IN_PROGRESS"'; then
      pass "unblock: run status is IN_PROGRESS"
    else
      fail "unblock: expected IN_PROGRESS in response"
    fi
    if echo "$LAST_BODY" | grep -q '"READY"'; then
      pass "unblock: step status is READY"
    else
      fail "unblock: expected READY step in response"
    fi
  fi
else
  pass "unblock: skipped (WORKFLOW_RUN_ID2 or FIRST_STEP_RUN_ID2 not available)"
fi

# ── Step 54: Cancel a workflow run ────────────────────────────────────────────
header "POST /workflow-runs/:runId/cancel"
WORKFLOW_RUN_ID3=""
if [[ -n "$LINKED_TASK_ID" && -n "$PLAYBOOK_ID" ]]; then
  api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/workflow-runs" \
    "{\"clientId\":\"${CLIENT_ID}\",\"playbookId\":\"${PLAYBOOK_ID}\"}"
  if require_ok "POST /tasks/:taskId/workflow-runs (for cancel test)" "201"; then
    WORKFLOW_RUN_ID3=$(extract_field "$LAST_BODY" ".workflowState.run.id" "id")
    pass "cancel-test run created: ${WORKFLOW_RUN_ID3:-UNKNOWN}"
  fi
fi

if [[ -n "$WORKFLOW_RUN_ID3" ]]; then
  api_call POST "/api/v1/workflow-runs/${WORKFLOW_RUN_ID3}/cancel" \
    "{\"clientId\":\"${CLIENT_ID}\",\"reason\":\"Smoke test cancel — scope exhausted\"}"
  if require_ok "POST /workflow-runs/:runId/cancel" "200"; then
    if echo "$LAST_BODY" | grep -q '"CANCELLED"'; then
      pass "cancel: run status is CANCELLED"
    else
      fail "cancel: expected CANCELLED in response"
    fi
    if echo "$LAST_BODY" | grep -q '"SKIPPED"'; then
      pass "cancel: at least one step is SKIPPED"
    else
      fail "cancel: expected SKIPPED step(s) in response"
    fi
  fi
else
  pass "cancel: skipped (run id not available)"
fi

# ── Step 55: PII rejection in cancel reason ────────────────────────────────────
header "POST /workflow-runs/:runId/cancel (PII in reason — should reject)"
CANCEL_PII_RUN_ID=""
if [[ -n "$LINKED_TASK_ID" && -n "$PLAYBOOK_ID" ]]; then
  api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/workflow-runs" \
    "{\"clientId\":\"${CLIENT_ID}\",\"playbookId\":\"${PLAYBOOK_ID}\"}"
  if [[ "$LAST_CODE" == "201" ]]; then
    CANCEL_PII_RUN_ID=$(extract_field "$LAST_BODY" ".workflowState.run.id" "id")
  fi
fi

if [[ -n "$CANCEL_PII_RUN_ID" ]]; then
  api_call POST "/api/v1/workflow-runs/${CANCEL_PII_RUN_ID}/cancel" \
    "{\"clientId\":\"${CLIENT_ID}\",\"reason\":\"Contact admin@badbroker.com for confirmation\"}"
  if echo "$LAST_BODY" | grep -q '"WORKFLOW_UNSAFE_TEXT"'; then
    pass "cancel PII: correctly rejected WORKFLOW_UNSAFE_TEXT"
  elif [[ "$LAST_CODE" == "400" ]]; then
    pass "cancel PII: HTTP 400 as expected"
  else
    fail "cancel PII: expected 400, got ${LAST_CODE}"
  fi
else
  pass "cancel PII: skipped (run id not available)"
fi

# ── Step 56: Change playbook status ───────────────────────────────────────────
header "PATCH /api/v1/removal-playbooks/:playbookId/status"
if [[ -n "$PLAYBOOK_ID" ]]; then
  api_call PATCH "/api/v1/removal-playbooks/${PLAYBOOK_ID}/status" \
    "{\"status\":\"INACTIVE\"}"
  if require_ok "PATCH /removal-playbooks/:playbookId/status" "200"; then
    if echo "$LAST_BODY" | grep -q '"INACTIVE"'; then
      pass "playbook status: set to INACTIVE"
    else
      fail "playbook status: expected INACTIVE in response"
    fi
  fi
  api_call PATCH "/api/v1/removal-playbooks/${PLAYBOOK_ID}/status" \
    "{\"status\":\"ACTIVE\"}"
  if [[ "$LAST_CODE" == "200" ]]; then
    pass "playbook status: restored to ACTIVE"
  else
    fail "playbook status: could not restore to ACTIVE (${LAST_CODE})"
  fi
else
  pass "playbook status: skipped (PLAYBOOK_ID not available)"
fi

# ── Step 57: List client workflow runs ────────────────────────────────────────
header "GET /api/v1/clients/:clientId/workflow-runs"
if [[ -n "$CLIENT_ID" ]]; then
  api_call GET "/api/v1/clients/${CLIENT_ID}/workflow-runs"
  if require_ok "GET /clients/:clientId/workflow-runs" "200"; then
    if echo "$LAST_BODY" | grep -q '"runs"'; then
      pass "client runs: runs array present"
    else
      fail "client runs: runs field missing"
    fi
    if echo "$LAST_BODY" | grep -q '"taskId"'; then
      fail "client runs: taskId leaked in list response (security violation)"
    else
      pass "client runs: no taskId in list response"
    fi
    if echo "$LAST_BODY" | grep -qE '"ciphertext"|"authTag"|"encryptedKeyRef"'; then
      fail "client runs: vault field leaked in response"
    else
      pass "client runs: no vault fields in response"
    fi
  fi
else
  pass "client runs: skipped (CLIENT_ID not available)"
fi

# ── Step 58: Generate a removal request packet ────────────────────────────────
header "POST /api/v1/tasks/:taskId/removal-request-packets"
PACKET_ID=""
PACKET_ITEM_ID=""
if [[ -n "$LINKED_TASK_ID" && -n "$CLIENT_ID" ]]; then
  api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/removal-request-packets" \
    "{\"clientId\":\"${CLIENT_ID}\"}"
  if require_ok "POST /tasks/:taskId/removal-request-packets" "201"; then
    PACKET_ID=$(extract_field "$LAST_BODY" ".packet.id" "id")
    if [[ -n "$PACKET_ID" && "$PACKET_ID" != "null" ]]; then
      pass "packet created: ${PACKET_ID}"
    else
      fail "packet: could not extract id"
    fi
    if echo "$LAST_BODY" | grep -q '"status":"DRAFT"'; then
      pass "packet: status is DRAFT"
    else
      fail "packet: expected DRAFT status"
    fi
    if echo "$LAST_BODY" | grep -q '"items"'; then
      pass "packet: items array present"
    else
      fail "packet: items array missing"
    fi
    if echo "$LAST_BODY" | grep -qE '"ciphertext"|"authTag"|"encryptedKeyRef"'; then
      fail "packet: vault field leaked"
    else
      pass "packet: no vault fields in response"
    fi
    # Extract first item ID for next step
    if $JQ_AVAILABLE; then
      PACKET_ITEM_ID=$(echo "$LAST_BODY" | jq -r '.packet.items[0].id' 2>/dev/null || echo "")
    fi
  fi
else
  pass "packet generation: skipped (LINKED_TASK_ID or CLIENT_ID not available)"
fi

# ── Step 59: List packets for task ────────────────────────────────────────────
header "GET /api/v1/tasks/:taskId/removal-request-packets"
if [[ -n "$LINKED_TASK_ID" ]]; then
  api_call GET "/api/v1/tasks/${LINKED_TASK_ID}/removal-request-packets"
  if require_ok "GET /tasks/:taskId/removal-request-packets" "200"; then
    if echo "$LAST_BODY" | grep -q '"packets"'; then
      pass "packet list: packets array present"
    else
      fail "packet list: packets field missing"
    fi
  fi
else
  pass "packet list: skipped"
fi

# ── Step 60: Complete a packet checklist item ─────────────────────────────────
header "POST /removal-request-packets/:packetId/items/:itemId/complete"
if [[ -n "$PACKET_ID" && -n "$PACKET_ITEM_ID" && -n "$CLIENT_ID" ]]; then
  api_call POST "/api/v1/removal-request-packets/${PACKET_ID}/items/${PACKET_ITEM_ID}/complete" \
    "{\"clientId\":\"${CLIENT_ID}\"}"
  if require_ok "POST /removal-request-packets/.../items/.../complete" "200"; then
    if echo "$LAST_BODY" | grep -q '"COMPLETED"'; then
      pass "packet item: at least one item is COMPLETED"
    else
      fail "packet item: expected COMPLETED status in response"
    fi
  fi
else
  pass "packet item complete: skipped"
fi

# ── Step 61: Block a packet checklist item (PII rejection) ────────────────────
header "POST /removal-request-packets/:packetId/items/:itemId/block (PII in reason — should reject)"
if [[ -n "$PACKET_ID" && -n "$PACKET_ITEM_ID" && -n "$CLIENT_ID" ]]; then
  api_call POST "/api/v1/removal-request-packets/${PACKET_ID}/items/${PACKET_ITEM_ID}/block" \
    "{\"clientId\":\"${CLIENT_ID}\",\"reason\":\"Contact admin@badbroker.com to unblock\"}"
  if echo "$LAST_BODY" | grep -q '"WORKFLOW_UNSAFE_TEXT"'; then
    pass "packet block PII: correctly rejected WORKFLOW_UNSAFE_TEXT"
  elif [[ "$LAST_CODE" == "400" ]]; then
    pass "packet block PII: HTTP 400 as expected"
  else
    fail "packet block PII: expected 400, got ${LAST_CODE}"
  fi
else
  pass "packet block PII: skipped"
fi

# ── Step 62: Schedule a follow-up reminder ────────────────────────────────────
header "POST /api/v1/tasks/:taskId/follow-ups"
FOLLOW_UP_ID=""
FUTURE_DUE=$(date -u -d "+7 days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "2030-01-01T00:00:00Z")
if [[ -n "$LINKED_TASK_ID" && -n "$CLIENT_ID" ]]; then
  api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/follow-ups" \
    "{\"clientId\":\"${CLIENT_ID}\",\"dueAt\":\"${FUTURE_DUE}\"}"
  if require_ok "POST /tasks/:taskId/follow-ups" "201"; then
    FOLLOW_UP_ID=$(extract_field "$LAST_BODY" ".followUp.id" "id")
    if [[ -n "$FOLLOW_UP_ID" && "$FOLLOW_UP_ID" != "null" ]]; then
      pass "follow-up scheduled: ${FOLLOW_UP_ID}"
    else
      fail "follow-up: could not extract id"
    fi
    if echo "$LAST_BODY" | grep -q '"status":"PENDING"'; then
      pass "follow-up: status is PENDING"
    else
      fail "follow-up: expected PENDING status"
    fi
  fi
else
  pass "follow-up schedule: skipped"
fi

# ── Step 63: List follow-ups for client ───────────────────────────────────────
header "GET /api/v1/clients/:clientId/follow-ups"
if [[ -n "$CLIENT_ID" ]]; then
  api_call GET "/api/v1/clients/${CLIENT_ID}/follow-ups"
  if require_ok "GET /clients/:clientId/follow-ups" "200"; then
    if echo "$LAST_BODY" | grep -q '"followUps"'; then
      pass "follow-up list: followUps array present"
    else
      fail "follow-up list: followUps field missing"
    fi
  fi
else
  pass "follow-up list: skipped"
fi

# ── Step 64: List due follow-ups ──────────────────────────────────────────────
header "GET /api/v1/follow-ups/due"
if [[ -n "$CLIENT_ID" ]]; then
  api_call GET "/api/v1/follow-ups/due?clientId=${CLIENT_ID}"
  if require_ok "GET /follow-ups/due" "200"; then
    if echo "$LAST_BODY" | grep -q '"followUps"'; then
      pass "due follow-ups: followUps array present"
    else
      fail "due follow-ups: followUps field missing"
    fi
  fi
else
  pass "due follow-ups: skipped"
fi

# ── Step 65: PII rejection in follow-up safeNote ─────────────────────────────
header "POST /api/v1/tasks/:taskId/follow-ups (PII in safeNote — should reject)"
if [[ -n "$LINKED_TASK_ID" && -n "$CLIENT_ID" ]]; then
  api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/follow-ups" \
    "{\"clientId\":\"${CLIENT_ID}\",\"dueAt\":\"${FUTURE_DUE}\",\"safeNote\":\"Follow up with admin@badbroker.com\"}"
  if echo "$LAST_BODY" | grep -q '"WORKFLOW_UNSAFE_TEXT"'; then
    pass "follow-up PII: correctly rejected WORKFLOW_UNSAFE_TEXT"
  elif [[ "$LAST_CODE" == "400" ]]; then
    pass "follow-up PII: HTTP 400 as expected"
  else
    fail "follow-up PII: expected 400, got ${LAST_CODE}"
  fi
else
  pass "follow-up PII: skipped"
fi

# ── Step 66: Complete a follow-up ─────────────────────────────────────────────
header "POST /api/v1/follow-ups/:followUpId/complete"
if [[ -n "$FOLLOW_UP_ID" && -n "$CLIENT_ID" ]]; then
  api_call POST "/api/v1/follow-ups/${FOLLOW_UP_ID}/complete" \
    "{\"clientId\":\"${CLIENT_ID}\"}"
  if require_ok "POST /follow-ups/:followUpId/complete" "200"; then
    if echo "$LAST_BODY" | grep -q '"COMPLETED"'; then
      pass "follow-up complete: status is COMPLETED"
    else
      fail "follow-up complete: expected COMPLETED status"
    fi
  fi
else
  pass "follow-up complete: skipped"
fi

# ── Step 67: Register evidence metadata ───────────────────────────────────────
header "POST /api/v1/tasks/:taskId/evidence"
EVIDENCE_ID=""
if [[ -n "$LINKED_TASK_ID" && -n "$CLIENT_ID" ]]; then
  api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/evidence" \
    "{\"clientId\":\"${CLIENT_ID}\",\"storageKey\":\"evidence/${LINKED_TASK_ID}/screen.png\",\"contentHash\":\"abc123def456abc123\",\"evidenceType\":\"SCREENSHOT\",\"mimeType\":\"image/png\"}"
  if require_ok "POST /tasks/:taskId/evidence" "201"; then
    EVIDENCE_ID=$(extract_field "$LAST_BODY" ".evidence.id" "id")
    if [[ -n "$EVIDENCE_ID" && "$EVIDENCE_ID" != "null" ]]; then
      pass "evidence registered: ${EVIDENCE_ID}"
    else
      fail "evidence: could not extract id"
    fi
    if echo "$LAST_BODY" | grep -qE '"ciphertext"|"authTag"'; then
      fail "evidence: vault field leaked in response"
    else
      pass "evidence: no vault fields in response"
    fi
  fi
else
  pass "evidence register: skipped"
fi

# ── Step 68: Reject evidence with unsafe storageKey ───────────────────────────
header "POST /api/v1/tasks/:taskId/evidence (unsafe storageKey — should reject)"
if [[ -n "$LINKED_TASK_ID" && -n "$CLIENT_ID" ]]; then
  api_call POST "/api/v1/tasks/${LINKED_TASK_ID}/evidence" \
    "{\"clientId\":\"${CLIENT_ID}\",\"storageKey\":\"s3://bucket/user@example.com/screen.png\",\"contentHash\":\"abc123\",\"evidenceType\":\"SCREENSHOT\"}"
  if echo "$LAST_BODY" | grep -q '"VALIDATION_ERROR"'; then
    pass "evidence unsafe key: correctly rejected VALIDATION_ERROR"
  elif [[ "$LAST_CODE" == "400" ]]; then
    pass "evidence unsafe key: HTTP 400 as expected"
  else
    fail "evidence unsafe key: expected 400, got ${LAST_CODE}"
  fi
else
  pass "evidence unsafe key: skipped"
fi

# ── Step 69: List evidence for task ───────────────────────────────────────────
header "GET /api/v1/tasks/:taskId/evidence"
if [[ -n "$LINKED_TASK_ID" && -n "$CLIENT_ID" ]]; then
  api_call GET "/api/v1/tasks/${LINKED_TASK_ID}/evidence?clientId=${CLIENT_ID}"
  if require_ok "GET /tasks/:taskId/evidence" "200"; then
    if echo "$LAST_BODY" | grep -q '"evidence"'; then
      pass "evidence list: evidence array present"
    else
      fail "evidence list: evidence field missing"
    fi
    # storageKey must NOT be in list response
    if echo "$LAST_BODY" | grep -q '"storageKey"'; then
      fail "evidence list: storageKey leaked in list response"
    else
      pass "evidence list: no storageKey in list response"
    fi
  fi
else
  pass "evidence list: skipped"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════"
echo "  Smoke test suffix:       ${SUFFIX}"
echo "  Test data org:           ${ORG_ID:-UNKNOWN}"
echo "  Test data user:          ${USER_ID:-UNKNOWN}"
echo "  Test data client:        ${CLIENT_ID:-UNKNOWN}"
echo "  Vault record:            ${VAULT_RECORD_ID:-UNKNOWN}"
echo "  Data source target:      ${DATA_SOURCE_TARGET_ID:-UNKNOWN}"
echo "  Manual submission:       ${SUBMISSION_ID:-UNKNOWN}"
echo "  Playbook:                ${PLAYBOOK_ID:-UNKNOWN}"
echo "  Workflow run:            ${WORKFLOW_RUN_ID:-UNKNOWN}"
echo "  Packet:                  ${PACKET_ID:-UNKNOWN}"
echo "  Follow-up:               ${FOLLOW_UP_ID:-UNKNOWN}"
echo "  Evidence:                ${EVIDENCE_ID:-UNKNOWN}"
echo "════════════════════════════════════════════════════════"
if [[ $FAILURES -eq 0 ]]; then
  echo "  ALL SMOKE STEPS PASSED (69/69)"
  echo "════════════════════════════════════════════════════════"
  exit 0
else
  echo "  ${FAILURES} STEP(S) FAILED — see output above"
  echo "════════════════════════════════════════════════════════"
  exit 1
fi
