import { startOfMonth } from 'date-fns';
import { Prisma, PaidBy } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { cache, CacheTag } from '../../config/cache';
import { AppError } from '../../shared/utils/AppError';
import type { AuthUser } from '../../shared/types/api';
import { settingsService } from '../settings/settings.service';

const num = (rows: Array<{ v: number | null }>): number => Number(rows[0]?.v ?? 0);

/**
 * Financial position — management-accounting snapshot built from the live
 * financial events (payments, POS, expenses, purchases, bills, stock).
 * Flow figures are month-to-date; balances are point-in-time.
 */
export async function getPosition() {
  return cache.getOrSet('accounting:position', [CacheTag.PAYMENTS, CacheTag.BILLS, CacheTag.EXPENSES, CacheTag.DASHBOARD], async () => {
    const monthStart = startOfMonth(new Date());

    const [
      cashIn, digitalIn, posCash, posDigital, posSalesMonth, billingMonth,
      expensesMonth, paidExpensesMonth, purchasesMonth, receivables, rawStock, fgValue, cogsMonth, payables,
    ] = await Promise.all([
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(amount),0)::float v FROM payments WHERE is_deleted=false AND channel='CASH' AND payment_date >= ${monthStart}`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(amount),0)::float v FROM payments WHERE is_deleted=false AND channel='DIGITAL' AND payment_date >= ${monthStart}`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(cash_amount),0)::float v FROM pos_transactions WHERE status='COMPLETED' AND is_deleted=false AND sold_at >= ${monthStart} AND outlet_id IS NULL`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(card_amount+upi_amount),0)::float v FROM pos_transactions WHERE status='COMPLETED' AND is_deleted=false AND sold_at >= ${monthStart} AND outlet_id IS NULL`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(grand_total),0)::float v FROM pos_transactions WHERE status='COMPLETED' AND is_deleted=false AND sold_at >= ${monthStart} AND outlet_id IS NULL`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(grand_total),0)::float v FROM bills WHERE is_deleted=false AND status<>'CANCELLED' AND bill_date >= ${monthStart}`,
      // Accrual total — every expense incurred this month, paid or not. Feeds P&L:
      // an owed-but-unpaid expense is still a real cost against this month's profit.
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(amount),0)::float v FROM expenses WHERE is_deleted=false AND outlet_id IS NULL AND expense_date >= ${monthStart}`,
      // Cash-basis total — excludes NOT_PAID. Feeds Money Out / Net Cash Flow below,
      // which must reflect what actually left the business, not what's merely owed.
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(amount),0)::float v FROM expenses WHERE is_deleted=false AND outlet_id IS NULL AND payment_method<>'NOT_PAID' AND expense_date >= ${monthStart}`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(total_cost),0)::float v FROM raw_material_intake WHERE is_deleted=false AND intake_date >= ${monthStart}`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(balance_due),0)::float v FROM bills WHERE is_deleted=false AND status IN ('UNPAID','PARTIALLY_PAID')`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(current_stock*cost_per_unit),0)::float v FROM raw_materials WHERE is_deleted=false`,
      prisma.$queryRaw<Array<{ v: number }>>`
        SELECT (
          (SELECT COALESCE(SUM(g.quantity*p.base_price),0) FROM godown_stock g JOIN products p ON p.id=g.product_id WHERE g.is_deleted=false) +
          (SELECT COALESCE(SUM(m.quantity*p.base_price),0) FROM main_branch_stock m JOIN products p ON p.id=m.product_id WHERE m.is_deleted=false) +
          (SELECT COALESCE(SUM(o.quantity*p.base_price),0) FROM outlet_stock o JOIN products p ON p.id=o.product_id WHERE o.is_deleted=false)
        )::float v`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(total_material_cost),0)::float v FROM production_batches WHERE is_deleted=false AND production_date >= ${monthStart}`,
      prisma.$queryRaw<Array<{ v: number }>>`SELECT COALESCE(SUM(balance_due),0)::float v FROM supplier_bills WHERE is_deleted=false AND outlet_id IS NULL AND status IN ('UNPAID','PARTIALLY_PAID')`,
    ]);

    const moneyInCash = num(cashIn) + num(posCash);
    const moneyInDigital = num(digitalIn) + num(posDigital);
    const moneyIn = moneyInCash + moneyInDigital;
    const moneyOut = num(paidExpensesMonth) + num(purchasesMonth);
    const revenueMonth = num(posSalesMonth) + num(billingMonth);
    const grossProfit = revenueMonth - num(cogsMonth);
    const netProfit = grossProfit - num(expensesMonth);

    return {
      month: monthStart.toISOString(),
      moneyIn,
      moneyInCash,
      moneyInDigital,
      moneyOut,
      netCashFlow: moneyIn - moneyOut,
      revenueMonth,
      posSalesMonth: num(posSalesMonth),
      billingMonth: num(billingMonth),
      expensesMonth: num(expensesMonth),
      // What Money Out's own "Expenses" breakdown should show — kept separate from
      // expensesMonth (the P&L figure) so the two numbers on screen add up to what
      // they're each labelled as, instead of quietly disagreeing over unpaid ones.
      paidExpensesMonth: num(paidExpensesMonth),
      purchasesMonth: num(purchasesMonth),
      cogsMonth: num(cogsMonth),
      grossProfit,
      netProfit,
      receivables: num(receivables),
      payables: num(payables),
      rawStockValue: num(rawStock),
      finishedGoodsValue: num(fgValue),
      stockValue: num(rawStock) + num(fgValue),
    };
  });
}

export interface DayBookEntry {
  type: 'PAYMENT_IN' | 'POS_SALE' | 'EXPENSE' | 'PURCHASE';
  date: string;
  party: string | null;
  method: string | null;
  reference: string | null;
  inflow: number;
  outflow: number;
}

/** Unified chronological cash/bank ledger between two dates. */
export async function getDayBook(from: Date, to: Date) {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const rows = await prisma.$queryRawUnsafe<Array<{ type: string; txn_date: Date; party: string | null; method: string | null; reference: string | null; inflow: number; outflow: number }>>(
    `
    SELECT 'PAYMENT_IN' AS type, p.payment_date AS txn_date, o.name AS party, p.method::text AS method, p.payment_number AS reference, p.amount::float AS inflow, 0::float AS outflow
      FROM payments p JOIN outlets o ON o.id=p.outlet_id
      WHERE p.is_deleted=false AND p.payment_date BETWEEN $1::timestamptz AND $2::timestamptz
    UNION ALL
    -- POS sales are rolled up one row per day per payment mode (not one row per
    -- sale) — a single counter can ring up hundreds of walk-in bills a day, which
    -- would otherwise drown every other entry type out of the book.
    SELECT 'POS_SALE', date_trunc('day', t.sold_at), 'POS / Walk-in', t.payment_mode::text,
           count(*)::text || CASE WHEN count(*)=1 THEN ' bill' ELSE ' bills' END,
           SUM(t.grand_total)::float, 0::float
      FROM pos_transactions t
      WHERE t.status='COMPLETED' AND t.is_deleted=false AND t.sold_at BETWEEN $1::timestamptz AND $2::timestamptz AND t.outlet_id IS NULL
      GROUP BY date_trunc('day', t.sold_at), t.payment_mode
    UNION ALL
    SELECT 'EXPENSE', e.expense_date, e.paid_to, e.payment_method::text, ec.name, 0::float, e.amount::float
      FROM expenses e JOIN expense_categories ec ON ec.id=e.category_id
      WHERE e.is_deleted=false AND e.outlet_id IS NULL AND e.expense_date BETWEEN $1::timestamptz AND $2::timestamptz
    UNION ALL
    SELECT 'PURCHASE', i.intake_date, i.supplier_name, NULL, i.invoice_number, 0::float, i.total_cost::float
      FROM raw_material_intake i WHERE i.is_deleted=false AND i.intake_date BETWEEN $1::timestamptz AND $2::timestamptz
    ORDER BY txn_date DESC
    LIMIT 500`,
    fromIso,
    toIso,
  );

  const totalIn = rows.reduce((s, r) => s + Number(r.inflow), 0);
  const totalOut = rows.reduce((s, r) => s + Number(r.outflow), 0);
  return {
    entries: rows.map((r) => ({
      type: r.type as DayBookEntry['type'],
      date: r.txn_date instanceof Date ? r.txn_date.toISOString() : String(r.txn_date),
      party: r.party,
      method: r.method,
      reference: r.reference,
      inflow: Number(r.inflow),
      outflow: Number(r.outflow),
    })),
    totalIn,
    totalOut,
    net: totalIn - totalOut,
  };
}

// ─────────────────────────────── CASH BOOK ───────────────────────────────────
//
// Physical cash-in-hand only — the subset of the Day Book that actually moved as
// cash rather than UPI/card/bank, plus manual adjustments (opening balance, a
// correction after a physical count). Built the same way the Ledger is: a
// per-source query of raw movements, a running balance carried from an opening
// figure computed from everything before the window.
//
// Unlike the Day Book's PURCHASE row (which counts the whole purchase value the
// moment goods arrive, credit or not), cash actually paid to a supplier is read
// from SupplierPayment — a bill bought on credit doesn't touch the cash box until
// it's actually paid. Likewise an expense only counts here when the company paid
// it (paidBy: COMPANY) — one a partner covered out of pocket is a debt to them,
// not company cash leaving hand; see the sign-convention note above the Ledger.

export type CashBookEntryType = 'RECEIPT' | 'POS_SALE' | 'EXPENSE' | 'SUPPLIER_PAYMENT' | 'ADJUSTMENT';

export interface CashBookEntry {
  type: CashBookEntryType;
  date: string;
  description: string;
  reference: string | null;
  in: number;
  out: number;
  /** Running balance after this entry, opening balance included. */
  balance: number;
  sourceId: string | null;
}

type CashRow = { date: Date; type: CashBookEntryType; description: string; reference: string | null; in: number; out: number; sourceId: string | null };

/** The raw cash movements across every source, unordered and without balances. */
async function cashRowsFor(before?: Date): Promise<CashRow[]> {
  const b = before ? { lt: before } : undefined;

  const [payments, posDays, expenses, supplierPayments, adjustments] = await Promise.all([
    prisma.payment.findMany({
      where: { isDeleted: false, status: 'SUCCESS', method: 'CASH', ...(b ? { paymentDate: b } : {}) },
      select: { id: true, paymentNumber: true, paymentDate: true, amount: true, outlet: { select: { name: true } } },
    }),
    // Rolled up one row per day, like the Day Book's POS row — a single counter
    // can ring up hundreds of walk-in bills a day. cash_amount (not grand_total)
    // is what's actually correct for a split-tender sale, where only part of the
    // bill was cash.
    prisma.$queryRaw<Array<{ day: Date; total: number; cnt: number }>>(
      Prisma.sql`
        SELECT date_trunc('day', sold_at) AS day, SUM(cash_amount)::float AS total, count(*)::int AS cnt
        FROM pos_transactions
        WHERE status='COMPLETED' AND is_deleted=false AND outlet_id IS NULL AND cash_amount > 0
        ${before ? Prisma.sql`AND sold_at < ${before}` : Prisma.empty}
        GROUP BY date_trunc('day', sold_at)
      `,
    ),
    prisma.expense.findMany({
      where: { isDeleted: false, outletId: null, paymentMethod: 'CASH', paidBy: 'COMPANY', ...(b ? { expenseDate: b } : {}) },
      select: { id: true, amount: true, expenseDate: true, paidTo: true, category: { select: { name: true } } },
    }),
    prisma.supplierPayment.findMany({
      where: { isDeleted: false, method: 'CASH', bill: { isDeleted: false, outletId: null }, ...(b ? { paymentDate: b } : {}) },
      select: { id: true, paymentNumber: true, paymentDate: true, amount: true, bill: { select: { supplierName: true, billNumber: true } } },
    }),
    prisma.cashAdjustment.findMany({
      where: { isDeleted: false, ...(b ? { adjustmentDate: b } : {}) },
      select: { id: true, amount: true, adjustmentDate: true, reason: true },
    }),
  ]);

  return [
    ...payments.map((p) => ({
      date: p.paymentDate, type: 'RECEIPT' as const, description: p.outlet.name, reference: p.paymentNumber,
      in: Number(p.amount), out: 0, sourceId: p.id,
    })),
    ...posDays.map((r) => ({
      date: r.day, type: 'POS_SALE' as const, description: 'POS / Walk-in',
      reference: `${r.cnt} bill${r.cnt === 1 ? '' : 's'}`, in: Number(r.total), out: 0, sourceId: null,
    })),
    ...expenses.map((e) => ({
      date: e.expenseDate, type: 'EXPENSE' as const, description: e.paidTo || e.category.name,
      reference: e.category.name, in: 0, out: Number(e.amount), sourceId: e.id,
    })),
    ...supplierPayments.map((p) => ({
      date: p.paymentDate, type: 'SUPPLIER_PAYMENT' as const, description: p.bill.supplierName ?? 'Supplier',
      reference: p.bill.billNumber, in: 0, out: Number(p.amount), sourceId: p.id,
    })),
    ...adjustments.map((a) => {
      const amt = Number(a.amount);
      return {
        date: a.adjustmentDate, type: 'ADJUSTMENT' as const, description: a.reason, reference: null,
        in: amt > 0 ? amt : 0, out: amt < 0 ? -amt : 0, sourceId: a.id,
      };
    }),
  ];
}

/**
 * Cash-in-hand: opening balance carried in from everything before `from`, then
 * each cash movement in date order with a running balance, then the closing —
 * the figure that should match an actual physical count.
 */
export async function getCashBook(from?: Date, to?: Date) {
  const [priorRows, allRows] = await Promise.all([
    from ? cashRowsFor(from) : Promise.resolve([] as CashRow[]),
    cashRowsFor(),
  ]);

  const openingBalance = priorRows.reduce((s, r) => s + r.in - r.out, 0);
  const windowed = allRows
    .filter((r) => (!from || r.date >= from) && (!to || r.date < to))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  let running = openingBalance;
  const entries: CashBookEntry[] = windowed.map((r) => {
    running += r.in - r.out;
    return {
      type: r.type, date: r.date.toISOString(), description: r.description, reference: r.reference,
      in: r.in, out: r.out, balance: running, sourceId: r.sourceId,
    };
  });

  return {
    openingBalance,
    closingBalance: running,
    totalIn: entries.reduce((s, e) => s + e.in, 0),
    totalOut: entries.reduce((s, e) => s + e.out, 0),
    entries,
  };
}

export async function addCashAdjustment(user: AuthUser, input: { amount: number; adjustmentDate: Date; reason: string }) {
  return prisma.cashAdjustment.create({
    data: { amount: input.amount, adjustmentDate: input.adjustmentDate, reason: input.reason, createdById: user.id },
  });
}

export async function deleteCashAdjustment(id: string) {
  const row = await prisma.cashAdjustment.findFirst({ where: { id, isDeleted: false } });
  if (!row) throw AppError.notFound('Adjustment not found');
  await prisma.cashAdjustment.update({ where: { id }, data: { isDeleted: true } });
  return { deleted: true };
}

// ─────────────────────────────── LEDGER ─────────────────────────────────────
//
// There is no journal table in this system — the Day Book, P&L and position are all
// derived straight from the financial events (bills, payments, expenses, purchases).
// The ledger follows the same principle: an account's entries are those same events
// filtered to that party, with debit/credit assigned by what the event means for the
// account, and a running balance accumulated in order.
//
// Sign convention, stated once because everything below depends on it:
//   • OUTLET (a receivable) — a bill we raise is a DEBIT (they owe us more), the
//     payment they make is a CREDIT. A positive balance is money owed TO us.
//   • SUPPLIER (a payable) — their bill is a CREDIT (we owe more), our payment is a
//     DEBIT. A positive balance is money we owe THEM.
//   • PERSON (company / a partner) — an expense they paid out of pocket is a CREDIT
//     (the business owes them that back). For COMPANY it is simply money the business
//     itself spent, so its balance reads as total company-funded spend.

export type LedgerAccountKind = 'PERSON' | 'OUTLET' | 'SUPPLIER';

export interface LedgerAccount {
  id: string;
  name: string;
  kind: LedgerAccountKind;
  balance: number;
}

export interface LedgerEntry {
  date: string;
  type: string;
  description: string;
  reference: string | null;
  debit: number;
  credit: number;
  /** Balance after this entry, opening balance included. */
  balance: number;
  sourceId: string | null;
}



/**
 * Every account that can be opened, with its balance to date.
 *
 * Balances are cached on the financial tags; the partner display names are
 * resolved afterwards, outside the cache, because they are configuration —
 * renaming a partner in Settings would otherwise not show until the next
 * payment or expense happened to invalidate this entry.
 */
export async function getLedgerAccounts() {
  const [cached, paidByLabels] = await Promise.all([
    cache.getOrSet('accounting:ledger:accounts', [CacheTag.PAYMENTS, CacheTag.BILLS, CacheTag.EXPENSES], async () => {
    const [personSpend, outlets, suppliers] = await Promise.all([
      prisma.expense.groupBy({
        by: ['paidBy'],
        _sum: { amount: true },
        where: { isDeleted: false, outletId: null },
      }),
      prisma.$queryRaw<Array<{ id: string; name: string; balance: number }>>`
        SELECT o.id, o.name,
               COALESCE(SUM(b.grand_total),0)::float - COALESCE((
                 SELECT SUM(p.amount) FROM payments p
                 WHERE p.outlet_id = o.id AND p.is_deleted = false AND p.status = 'SUCCESS'
               ),0)::float AS balance
        FROM outlets o
        LEFT JOIN bills b ON b.outlet_id = o.id AND b.is_deleted = false AND b.status <> 'CANCELLED'
        WHERE o.is_deleted = false
        GROUP BY o.id, o.name
        ORDER BY o.name`,
      prisma.$queryRaw<Array<{ name: string; balance: number }>>`
        SELECT sb.supplier_name AS name,
               (COALESCE(SUM(sb.total_amount),0) - COALESCE(SUM(sb.amount_paid),0))::float AS balance
        FROM supplier_bills sb
        WHERE sb.is_deleted = false AND sb.outlet_id IS NULL AND sb.supplier_name IS NOT NULL
        GROUP BY sb.supplier_name
        ORDER BY sb.supplier_name`,
    ]);

    const spendOf = new Map(personSpend.map((p) => [p.paidBy as string, Number(p._sum.amount ?? 0)]));
    const accounts: LedgerAccount[] = [
      // Named below, once the configured partner names are in hand.
      ...Object.values(PaidBy).map((id) => ({
        id: `PERSON:${id}`, name: id as string, kind: 'PERSON' as const, balance: spendOf.get(id) ?? 0,
      })),
      ...outlets.map((o) => ({ id: `OUTLET:${o.id}`, name: o.name, kind: 'OUTLET' as const, balance: Number(o.balance) })),
      ...suppliers.map((s) => ({ id: `SUPPLIER:${s.name}`, name: s.name, kind: 'SUPPLIER' as const, balance: Number(s.balance) })),
    ];
    return { accounts };
    }),
    settingsService.getPaidByLabels(),
  ]);

  const accounts = cached.accounts.map((a) =>
    a.kind === 'PERSON' ? { ...a, name: paidByLabels[a.id.slice('PERSON:'.length) as PaidBy] ?? a.name } : a,
  );
  return { accounts };
}

type RawEntry = { date: Date; type: string; description: string; reference: string | null; debit: number; credit: number; sourceId: string | null };

/** The raw movements for one account, unordered and without balances. */
async function ledgerRowsFor(kind: LedgerAccountKind, key: string, upTo?: Date): Promise<RawEntry[]> {
  const before = upTo ? { lt: upTo } : undefined;

  if (kind === 'PERSON') {
    const rows = await prisma.expense.findMany({
      where: { isDeleted: false, outletId: null, paidBy: key as never, ...(before ? { expenseDate: before } : {}) },
      select: { id: true, expenseDate: true, amount: true, paidTo: true, note: true, category: { select: { name: true } } },
      orderBy: { expenseDate: 'asc' },
    });
    return rows.map((e) => ({
      date: e.expenseDate,
      type: 'EXPENSE',
      description: [e.category.name, e.paidTo].filter(Boolean).join(' — ') || e.category.name,
      reference: e.note,
      debit: 0,
      credit: Number(e.amount),
      sourceId: e.id,
    }));
  }

  if (kind === 'OUTLET') {
    const [bills, payments] = await Promise.all([
      prisma.bill.findMany({
        where: { isDeleted: false, status: { not: 'CANCELLED' }, outletId: key, ...(before ? { billDate: before } : {}) },
        select: { id: true, billNumber: true, billDate: true, grandTotal: true },
      }),
      prisma.payment.findMany({
        where: { isDeleted: false, status: 'SUCCESS', outletId: key, ...(before ? { paymentDate: before } : {}) },
        select: { id: true, paymentNumber: true, paymentDate: true, amount: true, method: true },
      }),
    ]);
    return [
      ...bills.map((b) => ({
        date: b.billDate, type: 'SALE', description: `Sales bill ${b.billNumber}`,
        reference: b.billNumber, debit: Number(b.grandTotal), credit: 0, sourceId: b.id,
      })),
      ...payments.map((p) => ({
        date: p.paymentDate, type: 'RECEIPT', description: `Payment received (${p.method})`,
        reference: p.paymentNumber, debit: 0, credit: Number(p.amount), sourceId: p.id,
      })),
    ];
  }

  // SUPPLIER — keyed by name, since suppliers aren't a first-class table on bills.
  const [bills, payments] = await Promise.all([
    prisma.supplierBill.findMany({
      where: { isDeleted: false, outletId: null, supplierName: key, ...(before ? { billDate: before } : {}) },
      select: { id: true, billNumber: true, billDate: true, totalAmount: true },
    }),
    prisma.supplierPayment.findMany({
      where: { isDeleted: false, bill: { supplierName: key, isDeleted: false, outletId: null }, ...(before ? { paymentDate: before } : {}) },
      select: { id: true, paymentNumber: true, paymentDate: true, amount: true, method: true },
    }),
  ]);
  return [
    ...bills.map((b) => ({
      date: b.billDate, type: 'PURCHASE', description: `Purchase bill ${b.billNumber}`,
      reference: b.billNumber, debit: 0, credit: Number(b.totalAmount), sourceId: b.id,
    })),
    ...payments.map((p) => ({
      date: p.paymentDate, type: 'PAYMENT', description: `Paid to supplier (${p.method})`,
      reference: p.paymentNumber, debit: Number(p.amount), credit: 0, sourceId: p.id,
    })),
  ];
}

/** Net effect of a set of rows on the balance, in that account's own direction. */
function netOf(rows: RawEntry[], kind: LedgerAccountKind): number {
  return rows.reduce((sum, r) => sum + (kind === 'OUTLET' ? r.debit - r.credit : r.credit - r.debit), 0);
}

/**
 * One account's ledger: opening balance carried in from everything before `from`,
 * then each transaction in date order with a running balance, then the closing.
 */
export async function getLedger(accountId: string, from?: Date, to?: Date, search?: string) {
  const [kindRaw, ...rest] = accountId.split(':');
  const kind = kindRaw as LedgerAccountKind;
  const key = rest.join(':');
  if (!['PERSON', 'OUTLET', 'SUPPLIER'].includes(kind) || !key) {
    throw AppError.badRequest('Unknown ledger account');
  }

  const [priorRows, allRows] = await Promise.all([
    from ? ledgerRowsFor(kind, key, from) : Promise.resolve([] as RawEntry[]),
    ledgerRowsFor(kind, key),
  ]);

  const openingBalance = netOf(priorRows, kind);
  const windowed = allRows
    .filter((r) => (!from || r.date >= from) && (!to || r.date < to))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  let running = openingBalance;
  const entries: LedgerEntry[] = windowed.map((r) => {
    running += kind === 'OUTLET' ? r.debit - r.credit : r.credit - r.debit;
    return {
      date: r.date.toISOString(),
      type: r.type,
      description: r.description,
      reference: r.reference,
      debit: r.debit,
      credit: r.credit,
      balance: running,
      sourceId: r.sourceId,
    };
  });

  // Search filters what's shown but never the balances — a running balance that
  // skipped hidden rows would not reconcile against the closing figure.
  const term = search?.trim().toLowerCase();
  const visible = term
    ? entries.filter((e) => `${e.description} ${e.reference ?? ''} ${e.type}`.toLowerCase().includes(term))
    : entries;

  return {
    accountId,
    kind,
    openingBalance,
    closingBalance: running,
    totalDebit: entries.reduce((s, e) => s + e.debit, 0),
    totalCredit: entries.reduce((s, e) => s + e.credit, 0),
    entries: visible,
  };
}

/** Per-product profitability (last 90 days): revenue ex-tax vs BOM material cost. */
export async function getProductProfitability() {
  return prisma.$queryRawUnsafe<Array<{ name: string; qty: number; revenue: number; unit_cost: number; cogs: number; margin: number; margin_pct: number }>>(
    `
    WITH sold AS (
      SELECT product_id, SUM(qty) AS qty, SUM(rev) AS rev FROM (
        SELECT product_id, quantity AS qty, (rate*quantity) AS rev
          FROM bill_items bi JOIN bills b ON b.id=bi.bill_id
          WHERE b.is_deleted=false AND b.status<>'CANCELLED' AND b.bill_date >= now()-interval '90 days'
        UNION ALL
        SELECT product_id, quantity, (unit_price*quantity - discount)
          FROM pos_transaction_items pi JOIN pos_transactions t ON t.id=pi.transaction_id
          WHERE t.status='COMPLETED' AND t.is_deleted=false AND t.sold_at >= now()-interval '90 days' AND t.outlet_id IS NULL
      ) u GROUP BY product_id
    ),
    bomcost AS (
      SELECT bom.product_id, SUM(bom.quantity*rm.cost_per_unit) AS unit_cost
        FROM bill_of_materials bom JOIN raw_materials rm ON rm.id=bom.raw_material_id
        WHERE bom.is_deleted=false GROUP BY bom.product_id
    )
    SELECT p.name,
           s.qty::float AS qty,
           s.rev::float AS revenue,
           COALESCE(bc.unit_cost,0)::float AS unit_cost,
           (COALESCE(bc.unit_cost,0)*s.qty)::float AS cogs,
           (s.rev - COALESCE(bc.unit_cost,0)*s.qty)::float AS margin,
           CASE WHEN s.rev > 0 THEN ROUND(((s.rev - COALESCE(bc.unit_cost,0)*s.qty)/s.rev*100)::numeric, 1)::float ELSE 0 END AS margin_pct
    FROM products p JOIN sold s ON s.product_id=p.id LEFT JOIN bomcost bc ON bc.product_id=p.id
    WHERE p.is_deleted=false
    ORDER BY margin DESC`,
  );
}

export const accountingService = {
  getPosition, getDayBook, getCashBook, addCashAdjustment, deleteCashAdjustment,
  getLedgerAccounts, getLedger, getProductProfitability,
};
