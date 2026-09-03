import { Prisma, ContactType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import type { AuthUser } from '../../shared/types/api';
import { TallyBuildError } from './tally.types';

const SINGLETON = 'singleton';

export type TallyConfig = Prisma.TallyConfigGetPayload<Record<string, never>>;

/** The one settings row. Created with Phase-2 defaults on first read. */
export async function getTallyConfig(): Promise<TallyConfig> {
  const existing = await prisma.tallyConfig.findUnique({ where: { id: SINGLETON } });
  if (existing) return existing;
  return prisma.tallyConfig.create({ data: { id: SINGLETON } });
}

const CONFIG_KEYS = [
  'agentLabel', 'tallyCompanyName', 'tallyHost', 'tallyPort',
  'syncEnabled', 'syncSales', 'syncReceipts', 'syncPurchases', 'syncExpenses', 'syncStockJournal',
  'inventoryMode', 'posSupplyKind', 'posVoucherGranularity', 'razorpayReceiptMode', 'discountMode',
  'billChargesTaxable', 'syncNonGstOutletSales', 'accruedExpenseMode', 'closingStockMode', 'closingStockBasis',
  'blockOnRateMismatch', 'blockOnMissingGstin', 'syncFromDate',
] as const;

export async function updateTallyConfig(user: AuthUser, patch: Record<string, unknown>): Promise<TallyConfig> {
  await getTallyConfig(); // ensure it exists
  const data: Record<string, unknown> = { updatedById: user.id };
  for (const k of CONFIG_KEYS) if (k in patch) data[k] = patch[k];
  return prisma.tallyConfig.update({ where: { id: SINGLETON }, data });
}

// ─────────────────────────────── LEDGER MAP ───────────────────────────────────

export type LedgerMapRow = Prisma.TallyLedgerMapGetPayload<Record<string, never>>;

export async function getLedgerMap(): Promise<LedgerMapRow[]> {
  return prisma.tallyLedgerMap.findMany({ orderBy: [{ slot: 'asc' }, { slotLabel: 'asc' }] });
}

/** In-memory index for a build run: `${slot}:${slotKey}` → ledger name. */
export type LedgerIndex = Map<string, LedgerMapRow>;

export async function loadLedgerIndex(): Promise<LedgerIndex> {
  const rows = await getLedgerMap();
  return new Map(rows.map((r) => [`${r.slot}:${r.slotKey}`, r]));
}

export function resolveLedger(index: LedgerIndex, slot: LedgerMapRow['slot'], slotKey: string): string {
  const row = index.get(`${slot}:${slotKey}`);
  if (!row || !row.tallyLedgerName.trim()) {
    throw new TallyBuildError(`No Tally ledger mapped for ${slot} "${slotKey}". Set it in Settings → Tally → Ledger mapping.`);
  }
  return row.tallyLedgerName.trim();
}

// ───────────────────────────── DEFAULT MAPPING ────────────────────────────────
//
// Pre-fills the map with the Phase 2 recommendations. Idempotent and re-runnable:
// it only ADDS missing slots (never overwrites a name the accountant has set), so
// it also backfills rows for outlets / suppliers / expense categories added later.

interface SeedRow {
  slot: LedgerMapRow['slot'];
  slotKey: string;
  slotLabel: string;
  tallyLedgerName: string;
  tallyParentGroup?: string;
}

const FIXED_SEEDS: SeedRow[] = [
  // GST
  { slot: 'GST', slotKey: 'OUTPUT_CGST', slotLabel: 'Output CGST', tallyLedgerName: 'Output CGST', tallyParentGroup: 'Duties & Taxes' },
  { slot: 'GST', slotKey: 'OUTPUT_SGST', slotLabel: 'Output SGST', tallyLedgerName: 'Output SGST', tallyParentGroup: 'Duties & Taxes' },
  { slot: 'GST', slotKey: 'OUTPUT_IGST', slotLabel: 'Output IGST', tallyLedgerName: 'Output IGST', tallyParentGroup: 'Duties & Taxes' },
  { slot: 'GST', slotKey: 'INPUT_CGST', slotLabel: 'Input CGST', tallyLedgerName: 'Input CGST', tallyParentGroup: 'Duties & Taxes' },
  { slot: 'GST', slotKey: 'INPUT_SGST', slotLabel: 'Input SGST', tallyLedgerName: 'Input SGST', tallyParentGroup: 'Duties & Taxes' },
  { slot: 'GST', slotKey: 'INPUT_IGST', slotLabel: 'Input IGST', tallyLedgerName: 'Input IGST', tallyParentGroup: 'Duties & Taxes' },
  // Sales
  { slot: 'SALES', slotKey: 'FRANCHISE_GST', slotLabel: 'Franchise sales (GST)', tallyLedgerName: 'Sales - Franchise', tallyParentGroup: 'Sales Accounts' },
  { slot: 'SALES', slotKey: 'COUNTER_GST', slotLabel: 'Counter / POS sales (GST)', tallyLedgerName: 'Sales - Counter', tallyParentGroup: 'Sales Accounts' },
  { slot: 'SALES', slotKey: 'NON_GST', slotLabel: 'Non-GST / exempt sales', tallyLedgerName: 'Sales - Non-GST', tallyParentGroup: 'Sales Accounts' },
  // Purchase
  { slot: 'PURCHASE', slotKey: 'RAW_MATERIAL', slotLabel: 'Raw material purchases', tallyLedgerName: 'Purchase - Raw Material', tallyParentGroup: 'Purchase Accounts' },
  { slot: 'PURCHASE', slotKey: 'PACKING', slotLabel: 'Packing material purchases', tallyLedgerName: 'Purchase - Packing Material', tallyParentGroup: 'Purchase Accounts' },
  { slot: 'PURCHASE', slotKey: 'TRADED_GOODS', slotLabel: 'Traded / finished goods purchases', tallyLedgerName: 'Purchase - Traded Goods', tallyParentGroup: 'Purchase Accounts' },
  // Bank / cash by payment method
  { slot: 'BANK_CASH', slotKey: 'CASH', slotLabel: 'Cash', tallyLedgerName: 'Cash-in-Hand', tallyParentGroup: 'Cash-in-Hand' },
  { slot: 'BANK_CASH', slotKey: 'UPI', slotLabel: 'UPI', tallyLedgerName: 'Bank - Current A/c', tallyParentGroup: 'Bank Accounts' },
  { slot: 'BANK_CASH', slotKey: 'CARD', slotLabel: 'Card', tallyLedgerName: 'Bank - Current A/c', tallyParentGroup: 'Bank Accounts' },
  { slot: 'BANK_CASH', slotKey: 'NET_BANKING', slotLabel: 'Net banking', tallyLedgerName: 'Bank - Current A/c', tallyParentGroup: 'Bank Accounts' },
  { slot: 'BANK_CASH', slotKey: 'BANK_TRANSFER', slotLabel: 'Bank transfer', tallyLedgerName: 'Bank - Current A/c', tallyParentGroup: 'Bank Accounts' },
  { slot: 'BANK_CASH', slotKey: 'RAZORPAY', slotLabel: 'Razorpay', tallyLedgerName: 'Razorpay Clearing', tallyParentGroup: 'Bank Accounts' },
  // Special
  { slot: 'SPECIAL', slotKey: 'ROUND_OFF', slotLabel: 'Round off', tallyLedgerName: 'Round Off', tallyParentGroup: 'Indirect Expenses' },
  { slot: 'SPECIAL', slotKey: 'DISCOUNT_ALLOWED', slotLabel: 'Discount allowed', tallyLedgerName: 'Discount Allowed', tallyParentGroup: 'Indirect Expenses' },
  { slot: 'SPECIAL', slotKey: 'FREIGHT_RECOVERED', slotLabel: 'Freight / packing recovered', tallyLedgerName: 'Freight & Packing Recovered', tallyParentGroup: 'Indirect Incomes' },
  { slot: 'SPECIAL', slotKey: 'PG_CHARGES', slotLabel: 'Payment-gateway charges', tallyLedgerName: 'Bank & PG Charges', tallyParentGroup: 'Indirect Expenses' },
  { slot: 'SPECIAL', slotKey: 'CASH_SALES_PARTY', slotLabel: 'Counter-sale customer', tallyLedgerName: 'Counter Sales', tallyParentGroup: 'Sundry Debtors' },
  { slot: 'SPECIAL', slotKey: 'STOCK_TRANSFER', slotLabel: 'Internal stock transfer (journal party)', tallyLedgerName: 'Stock Transfer', tallyParentGroup: 'Primary' },
];

/** name-based guess for an expense category's Tally ledger + group. */
function guessExpenseLedger(name: string): { ledger: string; group: string } {
  const n = name.toLowerCase();
  const direct = /godown|factory|packing|packaging|production|raw|freight in|inward/.test(n);
  const group = direct ? 'Direct Expenses' : 'Indirect Expenses';
  return { ledger: name, group };
}

export async function ensureTallyDefaults(): Promise<void> {
  try {
    await getTallyConfig();

    const [outlets, suppliers, categories, existing] = await Promise.all([
      prisma.outlet.findMany({ where: { isDeleted: false }, select: { id: true, name: true, legalName: true } }),
      prisma.contact.findMany({ where: { isDeleted: false, type: ContactType.SUPPLIER }, select: { id: true, name: true } }),
      prisma.expenseCategory.findMany({ where: { isDeleted: false }, select: { id: true, name: true } }),
      prisma.tallyLedgerMap.findMany({ select: { slot: true, slotKey: true } }),
    ]);

    const have = new Set(existing.map((r) => `${r.slot}:${r.slotKey}`));
    const rows: SeedRow[] = [...FIXED_SEEDS];

    for (const o of outlets) {
      rows.push({
        slot: 'PARTY_OUTLET', slotKey: o.id, slotLabel: o.name,
        tallyLedgerName: o.legalName || o.name, tallyParentGroup: 'Sundry Debtors',
      });
    }
    for (const s of suppliers) {
      rows.push({
        slot: 'PARTY_SUPPLIER', slotKey: s.id, slotLabel: s.name,
        tallyLedgerName: s.name, tallyParentGroup: 'Sundry Creditors',
      });
    }
    for (const c of categories) {
      const g = guessExpenseLedger(c.name);
      rows.push({
        slot: 'EXPENSE', slotKey: c.id, slotLabel: c.name,
        tallyLedgerName: g.ledger, tallyParentGroup: g.group,
      });
    }

    const toCreate = rows.filter((r) => !have.has(`${r.slot}:${r.slotKey}`));
    if (toCreate.length) {
      await prisma.tallyLedgerMap.createMany({ data: toCreate, skipDuplicates: true });
      logger.info({ count: toCreate.length }, 'tally: seeded default ledger-map rows');
    }
  } catch (err) {
    logger.error({ err }, 'tally: ensureTallyDefaults failed');
  }
}
