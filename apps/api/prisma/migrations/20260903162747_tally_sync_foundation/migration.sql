-- CreateEnum
CREATE TYPE "TallyEntityType" AS ENUM ('SALES_BILL', 'POS_SALE', 'PAYMENT_IN', 'PURCHASE_BILL', 'SUPPLIER_PAYMENT', 'EXPENSE', 'STOCK_TRANSFER', 'RAW_INTAKE');

-- CreateEnum
CREATE TYPE "TallyVoucherType" AS ENUM ('SALES', 'RECEIPT', 'PURCHASE', 'PAYMENT', 'STOCK_JOURNAL', 'JOURNAL');

-- CreateEnum
CREATE TYPE "TallySyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "TallyLedgerSlot" AS ENUM ('SALES', 'PURCHASE', 'GST', 'BANK_CASH', 'EXPENSE', 'PARTY_OUTLET', 'PARTY_SUPPLIER', 'SPECIAL');

-- AlterTable
ALTER TABLE "bills" ADD COLUMN     "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "place_of_supply_state_code" TEXT,
ADD COLUMN     "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "pos_transactions" ADD COLUMN     "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "stock_transfer_items" ADD COLUMN     "unit_cost" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "supplier_bills" ADD COLUMN     "supplier_contact_id" UUID;

-- CreateTable
CREATE TABLE "tally_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "agent_token_hash" TEXT,
    "agent_label" TEXT,
    "agent_last_seen_at" TIMESTAMPTZ(6),
    "tally_company_name" TEXT,
    "tally_host" TEXT NOT NULL DEFAULT 'localhost',
    "tally_port" INTEGER NOT NULL DEFAULT 9000,
    "sync_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sync_sales" BOOLEAN NOT NULL DEFAULT true,
    "sync_receipts" BOOLEAN NOT NULL DEFAULT true,
    "sync_purchases" BOOLEAN NOT NULL DEFAULT true,
    "sync_expenses" BOOLEAN NOT NULL DEFAULT true,
    "sync_stock_journal" BOOLEAN NOT NULL DEFAULT false,
    "inventory_mode" TEXT NOT NULL DEFAULT 'ACCOUNTING_ONLY',
    "pos_supply_kind" TEXT NOT NULL DEFAULT 'GOODS',
    "pos_voucher_granularity" TEXT NOT NULL DEFAULT 'DAILY_SUMMARY',
    "razorpay_receipt_mode" TEXT NOT NULL DEFAULT 'CLEARING',
    "discount_mode" TEXT NOT NULL DEFAULT 'SEPARATE_LEDGER',
    "bill_charges_taxable" BOOLEAN NOT NULL DEFAULT true,
    "sync_non_gst_outlet_sales" BOOLEAN NOT NULL DEFAULT true,
    "accrued_expense_mode" TEXT NOT NULL DEFAULT 'ON_PAYMENT',
    "closing_stock_mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "closing_stock_basis" TEXT NOT NULL DEFAULT 'GST_PURCHASE_STOCK',
    "block_on_rate_mismatch" BOOLEAN NOT NULL DEFAULT true,
    "block_on_missing_gstin" BOOLEAN NOT NULL DEFAULT false,
    "sync_from_date" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tally_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_ledger_map" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slot" "TallyLedgerSlot" NOT NULL,
    "slot_key" TEXT NOT NULL,
    "slot_label" TEXT NOT NULL,
    "tally_ledger_name" TEXT NOT NULL,
    "tally_parent_group" TEXT,
    "validated_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tally_ledger_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_sync_queue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" "TallyEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "voucher_type" "TallyVoucherType" NOT NULL,
    "status" "TallySyncStatus" NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "dedup_key" TEXT NOT NULL,
    "doc_number" TEXT,
    "party_name" TEXT,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "entity_date" TIMESTAMPTZ(6) NOT NULL,
    "payload_json" JSONB,
    "excluded_reason" TEXT,
    "error_message" TEXT,
    "tally_voucher_id" TEXT,
    "tally_response" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(6),
    "synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tally_sync_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tally_ledger_map_slot_slot_key_key" ON "tally_ledger_map"("slot", "slot_key");

-- CreateIndex
CREATE UNIQUE INDEX "tally_sync_queue_dedup_key_key" ON "tally_sync_queue"("dedup_key");

-- CreateIndex
CREATE INDEX "tally_sync_queue_status_created_at_idx" ON "tally_sync_queue"("status", "created_at");

-- CreateIndex
CREATE INDEX "tally_sync_queue_entity_type_status_idx" ON "tally_sync_queue"("entity_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tally_sync_queue_entity_type_entity_id_key" ON "tally_sync_queue"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "supplier_bills_supplier_contact_id_idx" ON "supplier_bills"("supplier_contact_id");

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_supplier_contact_id_fkey" FOREIGN KEY ("supplier_contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
