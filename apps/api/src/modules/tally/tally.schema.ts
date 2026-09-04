import { z } from 'zod';
import { paginationQuerySchema } from '../../shared/utils/pagination';

const ENUMS = {
  inventoryMode: ['ACCOUNTING_ONLY', 'WITH_STOCK_JOURNALS'],
  posSupplyKind: ['GOODS', 'RESTAURANT'],
  posVoucherGranularity: ['PER_BILL', 'DAILY_SUMMARY'],
  razorpayReceiptMode: ['CLEARING', 'DIRECT_BANK'],
  discountMode: ['SEPARATE_LEDGER', 'NET_OFF_SALES'],
  accruedExpenseMode: ['ON_PAYMENT', 'JOURNAL_NOW'],
  closingStockMode: ['MANUAL', 'MONTHLY', 'ON_DEMAND'],
  closingStockBasis: ['GST_PURCHASE_STOCK', 'TOTAL_ERP_STOCK'],
} as const;

export const updateTallyConfigSchema = z
  .object({
    agentLabel: z.string().trim().max(80).nullable(),
    tallyCompanyName: z.string().trim().max(120).nullable(),
    tallyHost: z.string().trim().max(120),
    tallyPort: z.coerce.number().int().min(1).max(65535),
    syncEnabled: z.boolean(),
    syncSales: z.boolean(),
    syncReceipts: z.boolean(),
    syncPurchases: z.boolean(),
    syncExpenses: z.boolean(),
    syncStockJournal: z.boolean(),
    autoProvisionLedgers: z.boolean(),
    inventoryMode: z.enum(ENUMS.inventoryMode),
    posSupplyKind: z.enum(ENUMS.posSupplyKind),
    posVoucherGranularity: z.enum(ENUMS.posVoucherGranularity),
    razorpayReceiptMode: z.enum(ENUMS.razorpayReceiptMode),
    discountMode: z.enum(ENUMS.discountMode),
    billChargesTaxable: z.boolean(),
    syncNonGstOutletSales: z.boolean(),
    accruedExpenseMode: z.enum(ENUMS.accruedExpenseMode),
    closingStockMode: z.enum(ENUMS.closingStockMode),
    closingStockBasis: z.enum(ENUMS.closingStockBasis),
    blockOnRateMismatch: z.boolean(),
    blockOnMissingGstin: z.boolean(),
    syncFromDate: z.coerce.date().nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const updateLedgerMapSchema = z.object({
  rows: z
    .array(
      z.object({
        id: z.string().uuid(),
        tallyLedgerName: z.string().trim().min(1, 'Ledger name is required').max(200),
        tallyParentGroup: z.string().trim().max(120).optional().nullable(),
        notes: z.string().trim().max(300).optional().nullable(),
      }),
    )
    .min(1)
    .max(500),
});

export const queueQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['PENDING', 'SYNCED', 'FAILED', 'EXCLUDED']).optional(),
  entityType: z
    .enum(['SALES_BILL', 'POS_SALE', 'PAYMENT_IN', 'PURCHASE_BILL', 'SUPPLIER_PAYMENT', 'EXPENSE', 'STOCK_TRANSFER', 'RAW_INTAKE'])
    .optional(),
  search: z.string().trim().max(80).optional(),
});

// ── Agent-facing ──
export const agentPullSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });

export const agentResultSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().uuid(),
        status: z.enum(['SYNCED', 'FAILED']),
        tallyVoucherId: z.string().max(200).optional(),
        tallyResponse: z.string().max(8000).optional(),
        error: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const agentHeartbeatSchema = z.object({
  label: z.string().trim().max(80).optional(),
  tallyCompanyName: z.string().trim().max(120).optional(),
});

export const agentLedgerResultSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().uuid(),
        status: z.enum(['CREATED', 'EXISTS', 'FAILED']),
        error: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(200),
});
