# Celator — Phase 0: Security Foundation

## What Phase 0 Is

Phase 0 establishes the security and data architecture that all future Celator phases build on. It contains no product UI, no browser automation, no data broker integration, and no live email sending. It is the foundation, not the product.

What is built:

- TypeScript monorepo (pnpm workspaces)
- Prisma schema covering all Phase 0–3 entities
- Local KMS abstraction (AES-256-GCM, HMAC-SHA256 signing)
- Identity Vault service (per-client DEK encryption, purpose-coded access, crypto-shredding)
- Signed approval snapshot system (immutable, expirable, tamper-evident)
- Approval gate policy engine (39-check fail-closed enforcer)
- Consent scope mapping service (append-only, signedAt evaluation)
- Emergency pause service (5 scopes, audit-logged)
- Cleanup task status state machine (enforced transitions, audit trail)
- RBAC primitives (7 roles, permission helpers)
- PII-safe logger (pino + redaction + PII pattern scrubbing)
- Minimal Fastify API (health + security status)
- Full Vitest test suite

## What Phase 0 Does NOT Include

- Product UI (client portal, operator dashboard)
- Browser automation (form inspection, pre-fill, canary tests)
- Data broker scraping or search API integration
- Email sending (opt-out requests, deletion requests)
- LLM integration (classification agents, drafting agents)
- Real submission workers
- Payment processing
- Playbook system
- Discovery automation

## Absolute Product Rule

**Celator must never perform automatic deletion, opt-out submission, or any final destructive action.**

No automatic:
- deletion
- opt-out or data broker submission
- account deletion
- social media deletion
- search-result removal
- legal escalation
- ID upload or CAPTCHA handling
- password changes

Every final action in every future phase requires explicit operator approval.

## Repository Structure

```
celator/
├── apps/
│   └── api/                    # Fastify API foundation
│       └── src/
│           ├── index.ts        # Server entry point
│           └── routes/
│               ├── health.ts
│               └── security-status.ts
├── packages/
│   ├── core/                   # Shared types, Result<T>, error codes
│   ├── db/                     # Prisma schema and client
│   │   └── prisma/
│   │       └── schema.prisma
│   ├── security/               # All security services
│   │   └── src/
│   │       ├── kms/            # KMS abstraction
│   │       ├── vault/          # Identity vault
│   │       ├── approval/       # Snapshot service
│   │       ├── consent/        # Consent policy
│   │       ├── gate/           # Approval gate
│   │       ├── pause/          # Emergency pause
│   │       ├── state-machine/  # Task status machine
│   │       ├── rbac/           # RBAC primitives
│   │       └── logger/         # PII-safe logger
│   └── test-utils/             # Shared test helpers
├── docs/                       # This documentation
├── .env.example
├── docker-compose.yml
└── pnpm-workspace.yaml
```

## Local Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker + Docker Compose (for Postgres)

### Initial Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment file
cp .env.example .env
# Edit .env and set LOCAL_KMS_MASTER_SECRET and LOCAL_KMS_SIGNING_SECRET
# to any string of 32+ characters for local development.
# These are NOT production keys. Never commit them.

# 3. Start Postgres
docker compose up -d

# 4. Generate Prisma client
pnpm prisma:generate

# 5. Run migrations (once Postgres is ready)
pnpm prisma:migrate
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Run tests for security package only
pnpm --filter @celator/security test

# Type-check all packages
pnpm typecheck

# Validate Prisma schema
pnpm prisma:validate
```

### Starting the API

```bash
# Development (requires .env)
pnpm dev

# The API will start at http://127.0.0.1:3000
# Health check: GET http://127.0.0.1:3000/health
# Security status: GET http://127.0.0.1:3000/security/status
```

## Architecture Overview

### Security Flow

```
Client → ConsentPolicyService → determines permitted action types
                                      ↓
Operator → IdentityVaultService → accesses PII with purpose code
         → ApprovalSnapshotService → creates immutable signed review packet
         → ApprovalGateService → 39-point fail-closed enforcement
                                      ↓
ExecutionService (Phase 1+) → only runs if gate ALLOWS
                                      ↓
AuditLog + CaseTimelineEvent → immutable evidence trail
```

### Dependency Rules

- `packages/security` has no dependency on `packages/db` (no DB calls in security services)
- Phase 0 security services are tested with in-memory state
- Phase 1 will wire security services to Prisma-backed repositories

### Key Security Properties

1. **Fail closed**: Any check that cannot be evaluated blocks execution
2. **Immutable audit trail**: Every security-relevant event writes to AuditLog
3. **Append-only consent**: ConsentScopeMapping rows are never modified or deleted
4. **Signed snapshots**: Review packets are cryptographically bound to approved payloads
5. **Purpose-coded vault**: No PII decrypted without a valid, logged purpose
6. **Crypto-shredding**: Client data deletion destroys the key, not just the rows
