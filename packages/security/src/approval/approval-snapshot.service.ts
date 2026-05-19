/**
 * ApprovalSnapshotService — Celator Phase 0
 *
 * Creates and manages immutable signed review packet snapshots.
 *
 * Rules:
 * - JSON canonicalization is deterministic (sorted keys, stable serialization).
 * - Any value change changes the hash.
 * - Snapshots expire based on risk tier and action type.
 * - Signatures use HMAC-SHA256 with the signing key from KMS.
 * - Expired, used, or invalidated snapshots cannot be approved or executed.
 * - Evidence holds are created for all referenced evidence IDs.
 */

import { createHash } from 'node:crypto';
import type { KmsProvider } from '../kms/local-kms.js';

// =============================================================
// Types
// =============================================================

export type SnapshotStatus = 'ACTIVE' | 'EXPIRED' | 'USED' | 'INVALIDATED';
export type RiskTier = 'STANDARD' | 'MEDIUM' | 'HIGH';
export type ActionType =
  | 'OPT_OUT'
  | 'DELETE_PERSONAL_DATA'
  | 'DO_NOT_SELL'
  | 'DO_NOT_SHARE'
  | 'LIMIT_SENSITIVE_DATA'
  | 'CORRECT_DATA'
  | 'REMOVE_FROM_SEARCH'
  | 'REFRESH_OUTDATED_CONTENT'
  | 'DELETE_ACCOUNT'
  | 'DEACTIVATE_ACCOUNT'
  | 'REMOVE_IMAGE'
  | 'SUPPRESS_PROFILE'
  | 'REPORT_DANGEROUS_EXPOSURE'
  | 'ESCALATE_NON_RESPONSE'
  | 'LEGAL_ESCALATION';

export interface SnapshotPayload {
  taskId: string;
  clientId: string;
  caseId: string;
  actionType: ActionType;
  sourceRef?: string;
  findingUrl?: string;
  /** Exact fields that will be submitted — redacted in preview but hashed here */
  submissionFields: Record<string, unknown>;
  playbookVersion?: string;
  requestTemplateHash?: string;
  evidenceIds: string[];
}

export interface ApprovalSnapshot {
  id: string;
  taskId: string;
  payloadHash: string;
  snapshotSignature: string;
  signingKeyVersion: string;
  snapshotStatus: SnapshotStatus;
  snapshotExpiresAt: Date;
  riskTier: RiskTier;
  actionType: ActionType;
  redactedPreview: string;
  invalidationReason?: string;
  evidenceIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EvidenceHold {
  id: string;
  snapshotId: string;
  evidenceId: string;
  heldUntil: Date;
  releasedAt?: Date;
}

export interface CreateSnapshotResult {
  snapshot: ApprovalSnapshot;
  evidenceHolds: EvidenceHold[];
}

// =============================================================
// Expiry windows by action type and risk tier
// =============================================================

const EXPIRY_DAYS: Record<ActionType, Record<RiskTier, number>> = {
  OPT_OUT: { STANDARD: 14, MEDIUM: 14, HIGH: 7 },
  DELETE_PERSONAL_DATA: { STANDARD: 30, MEDIUM: 14, HIGH: 7 },
  DO_NOT_SELL: { STANDARD: 14, MEDIUM: 14, HIGH: 7 },
  DO_NOT_SHARE: { STANDARD: 14, MEDIUM: 14, HIGH: 7 },
  LIMIT_SENSITIVE_DATA: { STANDARD: 14, MEDIUM: 14, HIGH: 7 },
  CORRECT_DATA: { STANDARD: 30, MEDIUM: 14, HIGH: 7 },
  REMOVE_FROM_SEARCH: { STANDARD: 30, MEDIUM: 14, HIGH: 7 },
  REFRESH_OUTDATED_CONTENT: { STANDARD: 30, MEDIUM: 14, HIGH: 7 },
  DELETE_ACCOUNT: { STANDARD: 30, MEDIUM: 14, HIGH: 7 },
  DEACTIVATE_ACCOUNT: { STANDARD: 30, MEDIUM: 14, HIGH: 7 },
  REMOVE_IMAGE: { STANDARD: 30, MEDIUM: 14, HIGH: 7 },
  SUPPRESS_PROFILE: { STANDARD: 14, MEDIUM: 14, HIGH: 7 },
  REPORT_DANGEROUS_EXPOSURE: { STANDARD: 7, MEDIUM: 7, HIGH: 7 },
  ESCALATE_NON_RESPONSE: { STANDARD: 14, MEDIUM: 7, HIGH: 7 },
  LEGAL_ESCALATION: { STANDARD: 7, MEDIUM: 7, HIGH: 7 },
};

// =============================================================
// ApprovalSnapshotService
// =============================================================

let _snapshotCounter = 0;
let _holdCounter = 0;

export class ApprovalSnapshotService {
  private snapshots = new Map<string, ApprovalSnapshot>();
  private evidenceHolds = new Map<string, EvidenceHold>();

  constructor(private readonly kms: KmsProvider) {}

  // =============================================================
  // canonicalizePayload
  // =============================================================

  canonicalizePayload(payload: SnapshotPayload): string {
    return JSON.stringify(this.sortObjectDeep(payload as unknown as Record<string, unknown>));
  }

  // =============================================================
  // hashPayload
  // =============================================================

  hashPayload(canonicalPayload: string): string {
    return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
  }

  // =============================================================
  // signSnapshot
  // =============================================================

  async signSnapshot(payloadHash: string, signingKeyVersion: string): Promise<string> {
    return this.kms.signSnapshot(payloadHash, signingKeyVersion);
  }

  // =============================================================
  // verifySnapshot
  // =============================================================

  async verifySnapshot(snapshot: ApprovalSnapshot): Promise<boolean> {
    if (!this.kms.isSigningKeyVersionValid(snapshot.signingKeyVersion)) {
      return false;
    }
    return this.kms.verifySnapshot(
      snapshot.payloadHash,
      snapshot.snapshotSignature,
      snapshot.signingKeyVersion,
    );
  }

  // =============================================================
  // createSnapshot
  // =============================================================

  async createSnapshot(
    taskId: string,
    payload: SnapshotPayload,
    riskTier: RiskTier,
    actionType: ActionType,
    evidenceIds: string[],
    redactedPreview: string,
  ): Promise<CreateSnapshotResult> {
    const canonical = this.canonicalizePayload(payload);
    const payloadHash = this.hashPayload(canonical);
    const signingKeyVersion = this.kms.getCurrentSigningKeyVersion();
    const snapshotSignature = await this.signSnapshot(payloadHash, signingKeyVersion);

    const expiryDays =
      EXPIRY_DAYS[actionType]?.[riskTier] ??
      EXPIRY_DAYS['LEGAL_ESCALATION']?.['HIGH'] ??
      7; // Fail safe: shortest expiry for unknown types

    const snapshotExpiresAt = new Date();
    snapshotExpiresAt.setDate(snapshotExpiresAt.getDate() + expiryDays);

    const snapshotId = `snap_${++_snapshotCounter}_${Date.now()}`;

    const snapshot: ApprovalSnapshot = {
      id: snapshotId,
      taskId,
      payloadHash,
      snapshotSignature,
      signingKeyVersion,
      snapshotStatus: 'ACTIVE',
      snapshotExpiresAt,
      riskTier,
      actionType,
      redactedPreview,
      evidenceIds,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.snapshots.set(snapshotId, snapshot);

    // Create evidence holds for all referenced evidence
    const holds: EvidenceHold[] = [];
    for (const evidenceId of evidenceIds) {
      const hold: EvidenceHold = {
        id: `eh_${++_holdCounter}_${Date.now()}`,
        snapshotId,
        evidenceId,
        heldUntil: snapshotExpiresAt,
      };
      this.evidenceHolds.set(hold.id, hold);
      holds.push(hold);
    }

    return { snapshot, evidenceHolds: holds };
  }

  // =============================================================
  // Lifecycle methods
  // =============================================================

  expireSnapshot(snapshotId: string): void {
    const snapshot = this.assertSnapshot(snapshotId);
    if (snapshot.snapshotStatus !== 'ACTIVE') return;
    snapshot.snapshotStatus = 'EXPIRED';
    snapshot.updatedAt = new Date();
    this.releaseHoldsFor(snapshotId);
  }

  invalidateSnapshot(snapshotId: string, reason: string): void {
    const snapshot = this.assertSnapshot(snapshotId);
    snapshot.snapshotStatus = 'INVALIDATED';
    snapshot.invalidationReason = reason;
    snapshot.updatedAt = new Date();
    this.releaseHoldsFor(snapshotId);
  }

  markSnapshotUsed(snapshotId: string): void {
    const snapshot = this.assertSnapshot(snapshotId);
    if (snapshot.snapshotStatus !== 'ACTIVE') {
      throw new Error(
        `[ApprovalSnapshot] Cannot mark snapshot ${snapshotId} as used — current status: ${snapshot.snapshotStatus}`,
      );
    }
    snapshot.snapshotStatus = 'USED';
    snapshot.updatedAt = new Date();
    this.releaseHoldsFor(snapshotId);
  }

  // =============================================================
  // Getters
  // =============================================================

  getSnapshot(snapshotId: string): ApprovalSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  isSnapshotExpired(snapshot: ApprovalSnapshot): boolean {
    return snapshot.snapshotExpiresAt < new Date();
  }

  getEvidenceHoldsForSnapshot(snapshotId: string): EvidenceHold[] {
    return Array.from(this.evidenceHolds.values()).filter((h) => h.snapshotId === snapshotId);
  }

  isEvidenceUnderHold(evidenceId: string): boolean {
    const now = new Date();
    return Array.from(this.evidenceHolds.values()).some(
      (h) => h.evidenceId === evidenceId && !h.releasedAt && h.heldUntil > now,
    );
  }

  // =============================================================
  // Private helpers
  // =============================================================

  private assertSnapshot(snapshotId: string): ApprovalSnapshot {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      throw new Error(`[ApprovalSnapshot] Snapshot ${snapshotId} not found.`);
    }
    return snapshot;
  }

  private releaseHoldsFor(snapshotId: string): void {
    const now = new Date();
    for (const hold of this.evidenceHolds.values()) {
      if (hold.snapshotId === snapshotId && !hold.releasedAt) {
        hold.releasedAt = now;
      }
    }
  }

  /** Deep-sort object keys for deterministic JSON canonicalization. */
  private sortObjectDeep(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.sortObjectDeep(item));
    }
    if (obj !== null && typeof obj === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
        sorted[key] = this.sortObjectDeep((obj as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return obj;
  }
}
