# Consent Scope Mapping — Design and Reference

## Overview

The `ConsentScopeMapping` table defines which action types are permitted under which client consent scopes. It is the bridge between what a client has agreed to and what the platform is allowed to do on their behalf.

## Append-Only Design

`ConsentScopeMapping` rows are **append-only**. Existing rows are never updated or deleted.

This is both a legal requirement and a security property:
- A client's consent must be evaluable at any point in the past using the mappings that were in effect when they signed
- Retroactive permission expansion (adding new allowed actions to an old scope) must not silently affect clients who consented before the change
- An audit trail of all mapping versions is inherent in the append-only model

The `ConsentPolicyService.preventMappingUpdate()` and `preventMappingDelete()` methods throw immediately if called, documenting the constraint as an explicit code boundary.

## effectiveFrom / effectiveUntil

Each mapping row has:
- `effectiveFrom`: when this mapping became active
- `effectiveUntil`: when this mapping was superseded (null = still active)

To change a mapping (e.g., to add a new allowed action to a scope, or to restrict a previously allowed action):
1. Set `effectiveUntil` on the existing row to the date of the change
2. Append a new row with the new `effectiveFrom`

This creates an auditable version history with no gaps or overwrites.

## signedAt-Based Evaluation

Client consent is evaluated using mappings that were **effective at the time the client signed** (`signedAt`), not at the current time.

This means:
- A scope mapping expansion today does not affect clients who signed yesterday
- Clients who signed before a restriction was added are not retroactively restricted (though operators should be notified)
- The consent document signed by the client accurately reflects the mapping at that moment

Example:
```
Client signs DATA_BROKER_OPT_OUT consent at 2024-06-01T00:00:00Z

Effective mappings at 2024-06-01:
  DATA_BROKER_OPT_OUT + OPT_OUT → permitted
  DATA_BROKER_OPT_OUT + DELETE_PERSONAL_DATA → denied

On 2024-09-01, admin adds:
  DATA_BROKER_OPT_OUT + CORRECT_DATA → permitted (effectiveFrom: 2024-09-01)

Gate evaluates on 2024-10-01 for this client:
  Uses mappings effective at 2024-06-01 (signedAt)
  CORRECT_DATA is not found in 2024-06-01 mappings → DENIED
  Client must sign updated consent document to permit CORRECT_DATA
```

## Deny by Default

If no mapping is found for a given `(scope, actionType, jurisdiction)` at the evaluated time, the answer is **DENY**.

There is no implicit permission. Every permitted action must have an explicit mapping entry.

## Ambiguity = Deny

If the query returns both `permitted=true` and `permitted=false` mappings for the same `(scope, actionType, jurisdiction, time)`, the answer is **DENY**.

Ambiguity is treated as unsafe. This situation should never arise if mappings are maintained correctly using the `effectiveFrom`/`effectiveUntil` pattern.

## Seeded Mappings

The following mappings are seeded at initialization:

### DATA_BROKER_OPT_OUT scope

| Action Type | Jurisdiction | Permitted |
|-------------|--------------|-----------|
| OPT_OUT | * | ✅ Yes |
| DO_NOT_SELL | * | ✅ Yes |
| DO_NOT_SHARE | * | ✅ Yes |
| DELETE_PERSONAL_DATA | * | ❌ No — requires DELETION_REQUEST scope |
| LEGAL_ESCALATION | * | ❌ No — requires LEGAL_ESCALATION scope |
| ESCALATE_NON_RESPONSE | * | ❌ No — requires LEGAL_ESCALATION scope |

### DELETION_REQUEST scope

| Action Type | Jurisdiction | Permitted |
|-------------|--------------|-----------|
| DELETE_PERSONAL_DATA | * | ✅ Yes |

### SEARCH_RESULT_REMOVAL scope

| Action Type | Jurisdiction | Permitted |
|-------------|--------------|-----------|
| REMOVE_FROM_SEARCH | * | ✅ Yes |

### LEGAL_ESCALATION scope

| Action Type | Jurisdiction | Permitted |
|-------------|--------------|-----------|
| LEGAL_ESCALATION | * | ✅ Yes (requires explicit scope + specialist review) |
| ESCALATE_NON_RESPONSE | * | ✅ Yes |

## Jurisdiction Matching

Jurisdiction values follow the pattern `CC-SS` (country-state) or `CC` (country only).

The wildcard `*` matches all jurisdictions. Specific jurisdiction mappings take precedence over wildcard mappings when both exist.

Example: `DATA_BROKER_OPT_OUT + OPT_OUT + US-CA` would match a `*` mapping if no `US-CA` specific mapping exists.

## Adding New Mappings

To add a new permitted action to an existing scope:

```typescript
consentPolicy.appendConsentScopeMapping(
  'DATA_BROKER_OPT_OUT',
  'LIMIT_SENSITIVE_DATA',
  '*',
  true,           // permitted
  new Date(),     // effectiveFrom
  undefined,      // effectiveUntil (null = open-ended)
  adminUserId,
);
```

Clients who consent after this date will have `LIMIT_SENSITIVE_DATA` available. Clients who consented before must sign a new consent document.
