import type {
  RemovalRequestPacketRepository,
  PacketWithItems,
  PacketStatus,
  CleanupTaskRepository,
  DataSourceTargetRepository,
} from '@celator/db';
import type { RemovalRequestPacket, RemovalRequestPacketItem } from '@celator/db';
import { checkRedactedPreview } from '@celator/security';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ErrorCode } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { CaseTimelineService } from './case-timeline.service.js';
import type { IdentityVaultIntakeService } from './identity-vault-intake.service.js';

// ─── Packet item kinds ────────────────────────────────────────────────────────
const ITEM_KIND_VERIFY_CONSENT = 'VERIFY_CONSENT';
const ITEM_KIND_VERIFY_TARGET = 'VERIFY_TARGET';
const ITEM_KIND_ACCESS_VAULT_FIELD = 'ACCESS_VAULT_FIELD';
const ITEM_KIND_PREPARE_DRAFT = 'PREPARE_DRAFT';
const ITEM_KIND_MANUAL_SUBMISSION = 'MANUAL_SUBMISSION';
const ITEM_KIND_RECORD_SUBMISSION = 'RECORD_SUBMISSION';
const ITEM_KIND_SCHEDULE_FOLLOW_UP = 'SCHEDULE_FOLLOW_UP';

// ─── Terminal packet statuses ─────────────────────────────────────────────────
const TERMINAL_PACKET_STATUSES: PacketStatus[] = ['COMPLETED', 'CANCELLED'];
const TERMINAL_ITEM_STATUSES = ['COMPLETED', 'BLOCKED', 'SKIPPED'] as const;

// ─── Input/output types ───────────────────────────────────────────────────────

export interface GeneratePacketInput {
  taskId: string;
  clientId: string;
  preparedByUserId?: string;
}

export interface SafePacketItem {
  id: string;
  packetId: string;
  itemOrder: number;
  itemKind: string;
  label: string;
  status: string;
  requiredFieldType: string | null;
  operatorNotes: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface SafePacketHeader {
  id: string;
  taskId: string;
  clientId: string;
  dataSourceTargetId: string | null;
  status: string;
  redactedSummary: string;
  preparedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafePacketWithItems extends SafePacketHeader {
  items: SafePacketItem[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSafeItem(item: RemovalRequestPacketItem): SafePacketItem {
  return {
    id: item.id,
    packetId: item.packetId,
    itemOrder: item.itemOrder,
    itemKind: item.itemKind,
    label: item.label,
    status: item.status,
    requiredFieldType: item.requiredFieldType,
    operatorNotes: item.operatorNotes,
    completedAt: item.completedAt,
    createdAt: item.createdAt,
  };
}

function toSafeHeader(p: RemovalRequestPacket): SafePacketHeader {
  return {
    id: p.id,
    taskId: p.taskId,
    clientId: p.clientId,
    dataSourceTargetId: p.dataSourceTargetId,
    status: p.status,
    redactedSummary: p.redactedSummary,
    preparedByUserId: p.preparedByUserId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function toSafeWithItems(p: PacketWithItems): SafePacketWithItems {
  return { ...toSafeHeader(p), items: p.items.map(toSafeItem) };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class RemovalRequestPacketService {
  constructor(
    private readonly packetRepo: RemovalRequestPacketRepository,
    private readonly taskRepo: CleanupTaskRepository,
    private readonly targetRepo: DataSourceTargetRepository,
    private readonly vaultService: IdentityVaultIntakeService,
    private readonly audit: AuditService,
    private readonly timeline: CaseTimelineService,
  ) {}

  async generateForTask(
    input: GeneratePacketInput,
    actorId: string,
  ): Promise<Result<SafePacketWithItems, ErrorCode>> {
    const task = await this.taskRepo.findById(input.taskId);
    if (!task) return err('NOT_FOUND', `Task ${input.taskId} not found`);

    // Load target for field requirements and safe summary
    const target = task.dataSourceTargetId
      ? await this.targetRepo.findById(task.dataSourceTargetId)
      : null;

    // Load vault metadata (redacted only — no ciphertext)
    const vaultMetadata = await this.vaultService.listMetadata(input.clientId);
    const vaultFieldTypes = new Set(vaultMetadata.map((v) => v.fieldType));

    const requiredFields: string[] = target?.piiRequiredFields ?? [];
    const readyCount = requiredFields.filter((f) => vaultFieldTypes.has(f)).length;
    const missingCount = requiredFields.length - readyCount;

    // Build PII-safe summary — uses only system data (target name, counts, action type)
    const targetLabel = target ? target.sourceName : 'Unknown Target';
    const actionLabel = task.actionType ?? 'REMOVAL';
    const redactedSummary = `${actionLabel} packet for ${targetLabel} — ${requiredFields.length} required fields (${readyCount} ready, ${missingCount} missing)`;

    // Create packet
    const packet = await this.packetRepo.create({
      task: { connect: { id: input.taskId } },
      client: { connect: { id: input.clientId } },
      ...(task.dataSourceTargetId ? { dataSourceTarget: { connect: { id: task.dataSourceTargetId } } } : {}),
      redactedSummary,
      ...(input.preparedByUserId ? { preparedByUserId: input.preparedByUserId } : {}),
    });

    // Build checklist items (all auto-generated labels, no operator input)
    let order = 1;
    const itemDefs: Array<{ kind: string; label: string; fieldType?: string }> = [
      { kind: ITEM_KIND_VERIFY_CONSENT, label: 'Verify client consent is active and covers this action type' },
      { kind: ITEM_KIND_VERIFY_TARGET, label: `Verify target "${targetLabel}" is active and opt-out process is available` },
      { kind: ITEM_KIND_PREPARE_DRAFT, label: 'Build removal request draft from vault fields' },
      ...requiredFields.map((f) => ({
        kind: ITEM_KIND_ACCESS_VAULT_FIELD,
        label: `Access ${f} field via vault access flow for form completion`,
        fieldType: f,
      })),
      { kind: ITEM_KIND_MANUAL_SUBMISSION, label: 'Submit removal request to target manually' },
      { kind: ITEM_KIND_RECORD_SUBMISSION, label: 'Record submission confirmation code and outcome' },
      { kind: ITEM_KIND_SCHEDULE_FOLLOW_UP, label: 'Schedule follow-up reminder to verify removal completion' },
    ];

    for (const def of itemDefs) {
      await this.packetRepo.createItem({
        packet: { connect: { id: packet.id } },
        itemOrder: order++,
        itemKind: def.kind,
        label: def.label,
        ...(def.fieldType ? { requiredFieldType: def.fieldType } : {}),
      });
    }

    const auditResult = await this.audit.write({
      eventType: 'REMOVAL_PACKET_GENERATED',
      actorId,
      actorType: 'OPERATOR',
      clientId: input.clientId,
      resourceId: packet.id,
      resourceType: 'RemovalRequestPacket',
      outcome: 'ALLOWED',
      metadata: { taskId: input.taskId, itemCount: itemDefs.length, missingCount },
    });
    if (!auditResult.ok) return auditResult;

    await this.timeline.append({
      caseId: task.caseId,
      taskId: input.taskId,
      eventType: 'REMOVAL_PACKET_GENERATED',
      actorId,
      actorType: 'OPERATOR',
      note: `Removal request packet generated — ${itemDefs.length} checklist items`,
    });

    const full = await this.packetRepo.findByIdWithItems(packet.id);
    return ok(toSafeWithItems(full!));
  }

  async completeItem(
    packetId: string,
    itemId: string,
    input: { operatorNotes?: string },
    clientId: string,
    actorId: string,
  ): Promise<Result<SafePacketWithItems, ErrorCode>> {
    const packet = await this.packetRepo.findById(packetId);
    if (!packet) return err('PACKET_NOT_FOUND', `Packet ${packetId} not found`);

    if (packet.clientId !== clientId) {
      return err('FORBIDDEN', 'Access denied — packet belongs to a different client');
    }

    if (TERMINAL_PACKET_STATUSES.includes(packet.status)) {
      return err('PACKET_INVALID_STATUS', `Cannot mutate a ${packet.status} packet`);
    }

    const item = await this.packetRepo.findItemById(itemId);
    if (!item || item.packetId !== packetId) {
      return err('NOT_FOUND', `Item ${itemId} not found in packet ${packetId}`);
    }

    if (TERMINAL_ITEM_STATUSES.includes(item.status as typeof TERMINAL_ITEM_STATUSES[number])) {
      return err('PACKET_INVALID_STATUS', `Cannot complete item — already in terminal status "${item.status}"`);
    }

    if (input.operatorNotes !== undefined) {
      const v = checkRedactedPreview(input.operatorNotes);
      if (v) return err('WORKFLOW_UNSAFE_TEXT', `operatorNotes rejected: ${v}`);
    }

    await this.packetRepo.updateItemStatus(itemId, 'COMPLETED', {
      ...(input.operatorNotes !== undefined ? { operatorNotes: input.operatorNotes } : {}),
      completedAt: new Date(),
    });

    const auditResult = await this.audit.write({
      eventType: 'REMOVAL_PACKET_ITEM_COMPLETED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: packetId,
      resourceType: 'RemovalRequestPacket',
      outcome: 'ALLOWED',
      metadata: { packetId, itemId },
    });
    if (!auditResult.ok) return auditResult;

    const full = await this.packetRepo.findByIdWithItems(packetId);
    return ok(toSafeWithItems(full!));
  }

  async blockItem(
    packetId: string,
    itemId: string,
    input: { reason: string },
    clientId: string,
    actorId: string,
  ): Promise<Result<SafePacketWithItems, ErrorCode>> {
    const packet = await this.packetRepo.findById(packetId);
    if (!packet) return err('PACKET_NOT_FOUND', `Packet ${packetId} not found`);

    if (packet.clientId !== clientId) {
      return err('FORBIDDEN', 'Access denied — packet belongs to a different client');
    }

    if (TERMINAL_PACKET_STATUSES.includes(packet.status)) {
      return err('PACKET_INVALID_STATUS', `Cannot mutate a ${packet.status} packet`);
    }

    const item = await this.packetRepo.findItemById(itemId);
    if (!item || item.packetId !== packetId) {
      return err('NOT_FOUND', `Item ${itemId} not found in packet ${packetId}`);
    }

    if (TERMINAL_ITEM_STATUSES.includes(item.status as typeof TERMINAL_ITEM_STATUSES[number])) {
      return err('PACKET_INVALID_STATUS', `Cannot block item — already in terminal status "${item.status}"`);
    }

    const reasonViolation = checkRedactedPreview(input.reason);
    if (reasonViolation) return err('WORKFLOW_UNSAFE_TEXT', `reason rejected: ${reasonViolation}`);

    await this.packetRepo.updateItemStatus(itemId, 'BLOCKED', {
      operatorNotes: input.reason,
    });

    const auditResult = await this.audit.write({
      eventType: 'REMOVAL_PACKET_ITEM_BLOCKED',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: packetId,
      resourceType: 'RemovalRequestPacket',
      outcome: 'BLOCKED',
      metadata: { packetId, itemId },
    });
    if (!auditResult.ok) return auditResult;

    const full = await this.packetRepo.findByIdWithItems(packetId);
    return ok(toSafeWithItems(full!));
  }

  async markReady(
    packetId: string,
    clientId: string,
    actorId: string,
  ): Promise<Result<SafePacketWithItems, ErrorCode>> {
    const packet = await this.packetRepo.findById(packetId);
    if (!packet) return err('PACKET_NOT_FOUND', `Packet ${packetId} not found`);

    if (packet.clientId !== clientId) {
      return err('FORBIDDEN', 'Access denied — packet belongs to a different client');
    }

    if (packet.status !== 'DRAFT') {
      return err('PACKET_INVALID_STATUS', `Cannot mark READY — packet is in status "${packet.status}"`);
    }

    await this.packetRepo.updateStatus(packetId, 'READY');

    const auditResult = await this.audit.write({
      eventType: 'REMOVAL_PACKET_MARKED_READY',
      actorId,
      actorType: 'OPERATOR',
      clientId,
      resourceId: packetId,
      resourceType: 'RemovalRequestPacket',
      outcome: 'ALLOWED',
      metadata: { packetId },
    });
    if (!auditResult.ok) return auditResult;

    const full = await this.packetRepo.findByIdWithItems(packetId);
    return ok(toSafeWithItems(full!));
  }

  async getById(packetId: string, clientId: string): Promise<Result<SafePacketWithItems, ErrorCode>> {
    const packet = await this.packetRepo.findByIdWithItems(packetId);
    if (!packet) return err('PACKET_NOT_FOUND', `Packet ${packetId} not found`);
    if (packet.clientId !== clientId) {
      return err('FORBIDDEN', 'Access denied — packet belongs to a different client');
    }
    return ok(toSafeWithItems(packet));
  }

  async listForTask(taskId: string): Promise<SafePacketHeader[]> {
    const packets = await this.packetRepo.listForTask(taskId);
    return packets.map(toSafeHeader);
  }

  async listForClient(clientId: string): Promise<SafePacketHeader[]> {
    const packets = await this.packetRepo.listForClient(clientId);
    return packets.map(toSafeHeader);
  }
}
