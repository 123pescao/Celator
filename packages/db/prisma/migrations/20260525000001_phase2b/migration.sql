-- Phase 2B: Removal Request Packet Generation
-- Creates PacketStatus and PacketItemStatus enums.
-- Creates removal_request_packets and removal_request_packet_items tables.
-- No raw PII stored in any packet or item field.

-- Enums
CREATE TYPE "PacketStatus" AS ENUM ('DRAFT', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "PacketItemStatus" AS ENUM ('PENDING', 'COMPLETED', 'BLOCKED', 'SKIPPED');

-- removal_request_packets
CREATE TABLE "removal_request_packets" (
    "id"                      TEXT NOT NULL,
    "task_id"                 TEXT NOT NULL REFERENCES "cleanup_tasks"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "client_id"               TEXT NOT NULL REFERENCES "clients"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "data_source_target_id"   TEXT REFERENCES "data_source_targets"("id") ON UPDATE CASCADE ON DELETE SET NULL,
    "status"                  "PacketStatus" NOT NULL DEFAULT 'DRAFT',
    "redacted_summary"        TEXT NOT NULL,
    "prepared_by_user_id"     TEXT,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMP(3) NOT NULL,
    CONSTRAINT "removal_request_packets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "removal_request_packets_task_id_idx" ON "removal_request_packets"("task_id");
CREATE INDEX "removal_request_packets_client_created_idx" ON "removal_request_packets"("client_id", "created_at");
CREATE INDEX "removal_request_packets_status_idx" ON "removal_request_packets"("status");

-- removal_request_packet_items
CREATE TABLE "removal_request_packet_items" (
    "id"                    TEXT NOT NULL,
    "packet_id"             TEXT NOT NULL REFERENCES "removal_request_packets"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "item_order"            INTEGER NOT NULL,
    "item_kind"             TEXT NOT NULL,
    "label"                 TEXT NOT NULL,
    "status"                "PacketItemStatus" NOT NULL DEFAULT 'PENDING',
    "required_field_type"   TEXT,
    "operator_notes"        TEXT,
    "completed_at"          TIMESTAMP(3),
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "removal_request_packet_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "removal_request_packet_items_packet_id_item_order_key" ON "removal_request_packet_items"("packet_id", "item_order");
CREATE INDEX "removal_request_packet_items_packet_id_idx" ON "removal_request_packet_items"("packet_id");
