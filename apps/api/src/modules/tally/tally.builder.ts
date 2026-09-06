import { Prisma, ContactType, PaymentMethod, TallyEntityType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { splitGst } from '../../shared/utils/gst';
import type { TallyConfig } from './tally.config';
import { loadLedgerIndex, resolveLedger, type LedgerIndex } from './tally.config';
import { TallyBuildError, TallyDeferError, type TallyLedgerLine, type TallyVoucherPayload } from './tally.types';
import { parentVoucherWaitReason } from './tally.dependencies';

type QueueRow = Prisma.TallySyncQueueGetPayload<Record<string, never>>;

const n = (v: Prisma.Decimal | number | null | undefined) => Number(v ?? 0);
const round2 = (v: number) => Math.round(v * 100) / 100;
const yyyymmdd = (d: Date) => {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

function narration(row: QueueRow, party?: string | null): string {
  const bits = ['Mumbai ERP sync', row.voucherType, row.docNumber ?? row.entityId.slice(0, 8)];
  if (party) bits.push(party);
  bits.push(`id:${row.entityId}`);
  return bits.join(' · ');
}

/** A voucher that just cancels whatever is in Tally under this dedup key. */
function cancelPayload(row: QueueRow): TallyVoucherPayload {
  return {
    contractVersion: 1,
    action: 'CANCEL',
    voucherType: row.voucherType,
    date: yyyymmdd(row.entityDate),
    voucherNumber: row.docNumber ?? row.entityId,
    narration: `${narration(row)} — cancelled in the ERP`,
    dedupKey: row.dedupKey,
    lines: [],
    meta: { entityType: row.entityType, entityId: row.entityId, revision: row.revision },
  };
}

/**
 * A payment allocated "against" an invoice Tally has not received yet does not
 * attach — the money lands on the party but the bill-wise outstanding and ageing
 * are wrong, which is the exact figure this integration exists to make
 * trustworthy. So hold the payment until its invoice is in.
 *
 * FAILED, EXCLUDED and missing parents also block. Posting an Agst Ref payment
 * does not repair a missing invoice; the operator must resolve the parent.
 */
async function assertParentVoucherSynced(
  parentType: 'SALES_BILL' | 'PURCHASE_BILL',
  parentId: string,
  label: string,
): Promise<void> {
  const reason = await parentVoucherWaitReason(parentType, parentId, label);
  if (reason) throw new TallyDeferError(reason);
}

/**
 * Does the tax actually recorded on this document agree with its own line items?
 *
 * Deliberately an internal-consistency check, NOT a lookup against the product's
 * current tax rate: GST rates change by Council notification (pre-packaged
 * namkeen went 12% → 5% on 22 Sep 2025) and a bill raised before a change
 * legitimately keeps the old rate. Comparing against today's rate would fail
 * every historical document. What this does catch is a tax figure that does not
 * follow from its own quantity, rate and percentage — mis-entry, a partial edit,
 * or drift between the lines and the header.
 *
 * `lines` are (taxableBase, ratePercent, recordedTax) triples.
 */
function assertGstConsistent(
  lines: Array<{ label: string; base: number; ratePercent: number; tax: number }>,
  headerTax: number,
  opts: { inclusive?: boolean; block: boolean },
): string | null {
  const problems: string[] = [];
  let lineSum = 0;
  for (const l of lines) {
    lineSum += l.tax;
    const expected = opts.inclusive
      ? (l.base * l.ratePercent) / (100 + l.ratePercent)
      : (l.base * l.ratePercent) / 100;
    // A paisa of slack per line: the ERP rounds each line to 2dp on the way in.
    if (Math.abs(round2(expected) - round2(l.tax)) > 0.01) {
      problems.push(`"${l.label}" is taxed ${l.tax.toFixed(2)} but ${l.ratePercent}% of ${l.base.toFixed(2)} is ${expected.toFixed(2)}`);
    }
  }
  if (Math.abs(round2(lineSum) - round2(headerTax)) > 0.02) {
    problems.push(`the line taxes total ${lineSum.toFixed(2)} but the document says ${headerTax.toFixed(2)}`);
  }
  if (!problems.length) return null;

  const message = `GST does not add up — ${problems.join('; ')}.`;
  if (opts.block) throw new TallyBuildError(`${message} Fix the document, or turn off "block on GST rate mismatch" to post it anyway.`);
  return message;
}

function assertBalanced(lines: TallyLedgerLine[]): void {
  const dr = round2(lines.filter((l) => l.drCr === 'DR').reduce((s, l) => s + l.amount, 0));
  const cr = round2(lines.filter((l) => l.drCr === 'CR').reduce((s, l) => s + l.amount, 0));
  if (Math.abs(dr - cr) > 0.01) {
    throw new TallyBuildError(`Voucher does not balance: debit ${dr.toFixed(2)} ≠ credit ${cr.toFixed(2)}`);
  }
}

// ─────────────────────────────── SALES BILL ───────────────────────────────────

async function buildSalesBill(row: QueueRow, ix: LedgerIndex, cfg: TallyConfig): Promise<TallyVoucherPayload | null> {
  const bill = await prisma.bill.findUnique({
    where: { id: row.entityId },
    include: { outlet: true, items: { where: { isDeleted: false } } },
  });
  if (!bill) throw new TallyBuildError('Bill no longer exists');
  if (bill.isDeleted) return cancelPayload(row);
  if (!bill.isGstBill && !cfg.syncNonGstOutletSales) return null; // config says skip these

  const pos = bill.placeOfSupplyStateCode || env.HOME_STATE_CODE;
  const outletLedger = resolveLedger(ix, 'PARTY_OUTLET', bill.outletId);
  const salesLedger = resolveLedger(ix, 'SALES', bill.isGstBill ? 'FRANCHISE_GST' : 'NON_GST');

  const grand = n(bill.grandTotal);
  const taxable = n(bill.subTotal);
  const taxTotal = n(bill.taxTotal);

  const lines: TallyLedgerLine[] = [
    {
      ledger: outletLedger, drCr: 'DR', amount: round2(grand),
      billAllocations: [{ name: bill.billNumber, kind: 'NEW', amount: round2(grand) }],
    },
    { ledger: salesLedger, drCr: 'CR', amount: round2(taxable) },
  ];

  if (bill.isGstBill && taxTotal > 0) {
    assertGstConsistent(
      bill.items.map((i) => ({
        label: i.productNameSnapshot,
        base: n(i.rate) * n(i.quantity),
        ratePercent: n(i.taxPercent),
        tax: n(i.taxAmount),
      })),
      taxTotal,
      { block: cfg.blockOnRateMismatch },
    );
    // Prefer the snapshot; recompute from the total for bills raised before the split existed.
    let { cgst, sgst, igst } = { cgst: n(bill.cgst), sgst: n(bill.sgst), igst: n(bill.igst) };
    if (round2(cgst + sgst + igst) !== round2(taxTotal)) {
      ({ cgst, sgst, igst } = splitGst(taxTotal, pos, env.HOME_STATE_CODE));
    }
    if (cgst > 0) lines.push({ ledger: resolveLedger(ix, 'GST', 'OUTPUT_CGST'), drCr: 'CR', amount: round2(cgst) });
    if (sgst > 0) lines.push({ ledger: resolveLedger(ix, 'GST', 'OUTPUT_SGST'), drCr: 'CR', amount: round2(sgst) });
    if (igst > 0) lines.push({ ledger: resolveLedger(ix, 'GST', 'OUTPUT_IGST'), drCr: 'CR', amount: round2(igst) });
  }

  const otherCharges = n(bill.otherChargesTotal);
  if (otherCharges > 0) {
    lines.push({ ledger: resolveLedger(ix, 'SPECIAL', 'FREIGHT_RECOVERED'), drCr: 'CR', amount: round2(otherCharges) });
  }

  assertBalanced(lines);
  return {
    contractVersion: 1, action: 'CREATE', voucherType: 'SALES',
    date: yyyymmdd(bill.billDate), voucherNumber: bill.billNumber, reference: bill.billNumber,
    narration: narration(row, bill.outlet.name), dedupKey: row.dedupKey,
    partyLedger: outletLedger, placeOfSupplyStateCode: pos, lines,
    meta: { entityType: row.entityType, entityId: row.entityId, revision: row.revision },
  };
}

// ─────────────────────────────── POS SALE ─────────────────────────────────────

async function buildPosSale(row: QueueRow, ix: LedgerIndex): Promise<TallyVoucherPayload | null> {
  const t = await prisma.posTransaction.findUnique({ where: { id: row.entityId } });
  if (!t) throw new TallyBuildError('POS transaction no longer exists');
  if (t.isDeleted || t.status === 'VOID') return cancelPayload(row);
  if (t.outletId) return null; // franchise counter — not the company's books

  const grand = n(t.grandTotal);
  const taxTotal = n(t.taxTotal);
  const taxable = round2(grand - taxTotal);
  const lines: TallyLedgerLine[] = [];

  const cash = n(t.cashAmount), card = n(t.cardAmount), upi = n(t.upiAmount);
  if (cash > 0) lines.push({ ledger: resolveLedger(ix, 'BANK_CASH', 'CASH'), drCr: 'DR', amount: round2(cash) });
  if (card > 0) lines.push({ ledger: resolveLedger(ix, 'BANK_CASH', 'CARD'), drCr: 'DR', amount: round2(card) });
  if (upi > 0) lines.push({ ledger: resolveLedger(ix, 'BANK_CASH', 'UPI'), drCr: 'DR', amount: round2(upi) });

  lines.push({ ledger: resolveLedger(ix, 'SALES', 'COUNTER_GST'), drCr: 'CR', amount: taxable });
  if (taxTotal > 0) {
    const cgst = n(t.cgst) || round2(taxTotal / 2);
    const sgst = n(t.sgst) || round2(taxTotal - cgst);
    lines.push({ ledger: resolveLedger(ix, 'GST', 'OUTPUT_CGST'), drCr: 'CR', amount: round2(cgst) });
    lines.push({ ledger: resolveLedger(ix, 'GST', 'OUTPUT_SGST'), drCr: 'CR', amount: round2(sgst) });
  }

  assertBalanced(lines);
  return {
    contractVersion: 1, action: 'CREATE', voucherType: 'SALES',
    date: yyyymmdd(t.soldAt), voucherNumber: t.receiptNumber, reference: t.receiptNumber,
    narration: narration(row, 'Counter sale'), dedupKey: row.dedupKey,
    partyLedger: resolveLedger(ix, 'SPECIAL', 'CASH_SALES_PARTY'),
    placeOfSupplyStateCode: env.HOME_STATE_CODE, lines,
    meta: { entityType: row.entityType, entityId: row.entityId, revision: row.revision },
  };
}

// ─────────────────────────────── RECEIPT ──────────────────────────────────────

async function buildReceipt(row: QueueRow, ix: LedgerIndex): Promise<TallyVoucherPayload | null> {
  const p = await prisma.payment.findUnique({
    where: { id: row.entityId },
    include: { bill: { select: { billNumber: true } }, outlet: { select: { id: true, name: true } } },
  });
  if (!p) throw new TallyBuildError('Payment no longer exists');
  if (p.isDeleted || p.status !== 'SUCCESS') return cancelPayload(row);
  if (p.billId) await assertParentVoucherSynced('SALES_BILL', p.billId, 'the sales bill');

  const bank = resolveLedger(ix, 'BANK_CASH', p.method);
  const outletLedger = resolveLedger(ix, 'PARTY_OUTLET', p.outletId);
  const amt = round2(n(p.amount));

  const lines: TallyLedgerLine[] = [
    { ledger: bank, drCr: 'DR', amount: amt },
    {
      ledger: outletLedger, drCr: 'CR', amount: amt,
      billAllocations: [{
        name: p.bill?.billNumber ?? `${p.paymentNumber} (advance)`,
        kind: p.billId ? 'AGAINST' : 'ADVANCE',
        amount: amt,
      }],
    },
  ];
  assertBalanced(lines);
  return {
    contractVersion: 1, action: 'CREATE', voucherType: 'RECEIPT',
    date: yyyymmdd(p.paymentDate), voucherNumber: p.paymentNumber,
    reference: p.referenceNumber ?? p.paymentNumber,
    narration: narration(row, p.outlet.name), dedupKey: row.dedupKey,
    partyLedger: outletLedger, lines,
    meta: { entityType: row.entityType, entityId: row.entityId, revision: row.revision },
  };
}

// ─────────────────────────────── PURCHASE ─────────────────────────────────────

/**
 * The Sundry Creditor ledger for a purchase bill's supplier, creating whatever
 * is missing along the way.
 *
 * A brand-new supplier must never need a manual step. Two things can be absent
 * the first time one appears, and both are fixed here rather than thrown at the
 * owner as "match it in Contacts":
 *   1. the party-master link — `logPurchase` sets it post-commit on a best-effort
 *      path that swallows its own errors, so it can legitimately be missing;
 *   2. the ledger-map row — a supplier that has never been mapped has no
 *      PARTY_SUPPLIER entry yet.
 *
 * Resolution matches on GSTIN first (a business's real identity) and falls back
 * to a case-insensitive name, which is the same rule the purchase form uses, so
 * this cannot fork a supplier into two ledgers.
 */
async function resolveSupplierLedger(
  bill: { id: string; supplierContactId: string | null; supplierName: string | null; supplierGstin: string | null; createdById: string | null },
  ix: LedgerIndex,
): Promise<string> {
  let contactId = bill.supplierContactId;
  const name = bill.supplierName?.trim();

  if (!contactId) {
    if (!name) {
      throw new TallyBuildError('This purchase has no supplier name, so it cannot be posted to a creditor ledger. Add the supplier on the bill and retry.');
    }
    const gstin = bill.supplierGstin?.trim() || null;
    const existing = await prisma.contact.findFirst({
      where: {
        type: ContactType.SUPPLIER,
        isDeleted: false,
        ...(gstin ? { gstin: { equals: gstin, mode: 'insensitive' } } : { name: { equals: name, mode: 'insensitive' } }),
      },
      select: { id: true },
    });
    contactId = existing?.id
      ?? (await prisma.contact.create({
        data: {
          type: ContactType.SUPPLIER, name, gstin,
          stateCode: gstin ? gstin.slice(0, 2) : null,
          createdById: bill.createdById,
        },
        select: { id: true },
      })).id;
    // Link it back so this only ever happens once for this supplier.
    await prisma.supplierBill.update({ where: { id: bill.id }, data: { supplierContactId: contactId } });
  }

  const mapped = ix.get(`PARTY_SUPPLIER:${contactId}`);
  if (mapped?.tallyLedgerName.trim()) return mapped.tallyLedgerName.trim();

  // No mapping yet — create one now rather than failing the voucher. The owner
  // can rename it later in Ledger Mapping; the link stays keyed on the contact.
  const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { name: true } });
  const ledgerName = (contact?.name ?? name ?? '').trim();
  if (!ledgerName) throw new TallyBuildError('Could not determine a supplier ledger name for this purchase.');

  await prisma.tallyLedgerMap.upsert({
    where: { slot_slotKey: { slot: 'PARTY_SUPPLIER', slotKey: contactId } },
    create: {
      slot: 'PARTY_SUPPLIER', slotKey: contactId, slotLabel: ledgerName,
      tallyLedgerName: ledgerName, tallyParentGroup: 'Sundry Creditors',
    },
    update: {},
  });
  return ledgerName;
}

async function buildPurchase(row: QueueRow, ix: LedgerIndex, cfg: TallyConfig): Promise<TallyVoucherPayload | null> {
  const b = await prisma.supplierBill.findUnique({
    where: { id: row.entityId },
    include: { items: { where: { isDeleted: false } }, supplierContact: { select: { id: true, name: true } } },
  });
  if (!b) throw new TallyBuildError('Purchase bill no longer exists');
  if (b.isDeleted) return cancelPayload(row);
  if (!b.isGstBill) throw new TallyBuildError('Non-GST purchase reached the builder — it must stay EXCLUDED');
  if (b.outletId) throw new TallyBuildError('Branch purchase reached the builder — it must stay EXCLUDED');

  assertGstConsistent(
    b.items.map((i) => ({
      label: i.name,
      base: n(i.taxableAmount),
      ratePercent: n(i.taxRate),
      tax: n(i.taxAmount),
    })),
    n(b.taxAmount),
    { block: cfg.blockOnRateMismatch },
  );

  const supplierLedger = await resolveSupplierLedger(b, ix);
  const total = round2(n(b.totalAmount));

  const lines: TallyLedgerLine[] = [{
    ledger: supplierLedger, drCr: 'CR', amount: total,
    billAllocations: [{ name: b.invoiceNumber || b.billNumber, kind: 'NEW', amount: total }],
  }];

  // Group line taxable amounts by destination purchase ledger.
  const byLedger = new Map<string, number>();
  for (const it of b.items) {
    let ledger: string;
    if (it.isAsset) ledger = resolveLedger(ix, 'SPECIAL', 'FIXED_ASSETS');
    else if (it.kind === 'RAW_MATERIAL') ledger = resolveLedger(ix, 'PURCHASE', 'RAW_MATERIAL');
    else if (it.kind === 'FINISHED_GOOD') ledger = resolveLedger(ix, 'PURCHASE', 'TRADED_GOODS');
    else {
      if (!it.refId) throw new TallyBuildError(`Purchase line "${it.name}" has no expense category to map.`);
      ledger = resolveLedger(ix, 'EXPENSE', it.refId);
    }
    byLedger.set(ledger, round2((byLedger.get(ledger) ?? 0) + n(it.taxableAmount)));
  }
  for (const [ledger, amount] of byLedger) lines.push({ ledger, drCr: 'DR', amount });

  if (n(b.cgst) > 0) lines.push({ ledger: resolveLedger(ix, 'GST', 'INPUT_CGST'), drCr: 'DR', amount: round2(n(b.cgst)) });
  if (n(b.sgst) > 0) lines.push({ ledger: resolveLedger(ix, 'GST', 'INPUT_SGST'), drCr: 'DR', amount: round2(n(b.sgst)) });
  if (n(b.igst) > 0) lines.push({ ledger: resolveLedger(ix, 'GST', 'INPUT_IGST'), drCr: 'DR', amount: round2(n(b.igst)) });

  const roundOff = round2(n(b.roundOff));
  if (roundOff !== 0) {
    lines.push({ ledger: resolveLedger(ix, 'SPECIAL', 'ROUND_OFF'), drCr: roundOff > 0 ? 'DR' : 'CR', amount: Math.abs(roundOff) });
  }

  assertBalanced(lines);
  return {
    contractVersion: 1, action: 'CREATE', voucherType: 'PURCHASE',
    date: yyyymmdd(b.billDate), voucherNumber: b.billNumber, reference: b.invoiceNumber ?? b.billNumber,
    narration: narration(row, b.supplierContact?.name ?? b.supplierName), dedupKey: row.dedupKey,
    partyLedger: supplierLedger, lines,
    meta: { entityType: row.entityType, entityId: row.entityId, revision: row.revision },
  };
}

// ─────────────────────────────── SUPPLIER PAYMENT ─────────────────────────────

async function buildSupplierPayment(row: QueueRow, ix: LedgerIndex): Promise<TallyVoucherPayload | null> {
  const p = await prisma.supplierPayment.findUnique({
    where: { id: row.entityId },
    include: {
      bill: {
        select: {
          id: true, isGstBill: true, outletId: true, invoiceNumber: true, billNumber: true,
          supplierContactId: true, supplierName: true, supplierGstin: true, createdById: true,
        },
      },
    },
  });
  if (!p) return cancelPayload(row);
  if (p.isDeleted) return cancelPayload(row);
  if (!p.bill.isGstBill || p.bill.outletId) throw new TallyBuildError('Payment for an excluded bill reached the builder');
  await assertParentVoucherSynced('PURCHASE_BILL', p.bill.id, 'the purchase bill');

  const supplierLedger = await resolveSupplierLedger(p.bill, ix);
  const bank = resolveLedger(ix, 'BANK_CASH', p.method);
  const amt = round2(n(p.amount));

  const lines: TallyLedgerLine[] = [
    { ledger: supplierLedger, drCr: 'DR', amount: amt, billAllocations: [{ name: p.bill.invoiceNumber || p.bill.billNumber, kind: 'AGAINST', amount: amt }] },
    { ledger: bank, drCr: 'CR', amount: amt },
  ];
  assertBalanced(lines);
  return {
    contractVersion: 1, action: 'CREATE', voucherType: 'PAYMENT',
    date: yyyymmdd(p.paymentDate), voucherNumber: p.paymentNumber, reference: p.paymentNumber,
    narration: narration(row, p.bill.supplierName), dedupKey: row.dedupKey,
    partyLedger: supplierLedger, lines,
    meta: { entityType: row.entityType, entityId: row.entityId, revision: row.revision },
  };
}

// ─────────────────────────────── EXPENSE ──────────────────────────────────────

async function buildExpense(row: QueueRow, ix: LedgerIndex, cfg: TallyConfig): Promise<TallyVoucherPayload | null> {
  const e = await prisma.expense.findUnique({ where: { id: row.entityId }, include: { category: { select: { name: true } } } });
  if (!e) throw new TallyBuildError('Expense no longer exists');
  if (e.isDeleted) return cancelPayload(row);
  if (e.supplierBillId) throw new TallyBuildError('Expense line of a purchase bill reached the builder');
  if (e.outletId) throw new TallyBuildError('Branch expense reached the builder');

  const notPaid = e.paymentMethod === PaymentMethod.NOT_PAID;
  if (notPaid && cfg.accruedExpenseMode === 'ON_PAYMENT') return null; // wait until it's actually paid

  const expLedger = resolveLedger(ix, 'EXPENSE', e.categoryId);
  const gross = round2(n(e.amount) + n(e.taxAmount)); // no ITC on standalone expenses by default

  let creditLedger: string;
  if (e.paidBy !== 'COMPANY') creditLedger = resolveLedger(ix, 'SPECIAL', `PARTNER_${e.paidBy}`);
  else if (notPaid) creditLedger = resolveLedger(ix, 'SPECIAL', 'OUTSTANDING_EXPENSES');
  else creditLedger = resolveLedger(ix, 'BANK_CASH', e.paymentMethod);

  const lines: TallyLedgerLine[] = [
    { ledger: expLedger, drCr: 'DR', amount: gross },
    { ledger: creditLedger, drCr: 'CR', amount: gross },
  ];
  assertBalanced(lines);
  return {
    contractVersion: 1, action: 'CREATE',
    voucherType: notPaid ? 'JOURNAL' : 'PAYMENT',
    date: yyyymmdd(e.expenseDate), voucherNumber: e.invoiceNumber ?? row.dedupKey.slice(-12),
    reference: e.invoiceNumber ?? undefined,
    narration: narration(row, e.paidTo ?? e.category.name), dedupKey: row.dedupKey,
    lines,
    meta: { entityType: row.entityType, entityId: row.entityId, revision: row.revision },
  };
}

// ─────────────────────────────── STOCK JOURNAL ───────────────────────────────

async function buildStockJournal(row: QueueRow, cfg: TallyConfig): Promise<TallyVoucherPayload | null> {
  if (cfg.inventoryMode === 'ACCOUNTING_ONLY') return null; // no stock in Tally in this mode
  const t = await prisma.stockTransfer.findUnique({
    where: { id: row.entityId },
    include: { items: { where: { isDeleted: false }, include: { product: { select: { name: true } } } }, destinationOutlet: { select: { name: true } } },
  });
  if (!t) throw new TallyBuildError('Stock transfer no longer exists');
  if (t.isDeleted || t.status === 'CANCELLED') return cancelPayload(row);
  if (t.status !== 'RECEIVED') return null;

  const to = t.destinationType === 'OUTLET' ? t.destinationOutlet?.name ?? 'Outlet' : 'Main Branch';
  const inventory = t.items.map((it) => {
    const rate = n(it.unitCost);
    const qty = n(it.quantity);
    return { item: it.product.name, quantity: qty, rate, amount: round2(qty * rate), godownFrom: 'Godown', godownTo: to };
  });
  if (!inventory.length) throw new TallyBuildError('Stock transfer has no items to journal');

  return {
    contractVersion: 1, action: 'CREATE', voucherType: 'STOCK_JOURNAL',
    date: yyyymmdd(t.receivedAt ?? t.transferDate), voucherNumber: t.transferNumber, reference: t.transferNumber,
    narration: narration(row, to), dedupKey: row.dedupKey, lines: [], inventory,
    meta: { entityType: row.entityType, entityId: row.entityId, revision: row.revision },
  };
}

// ─────────────────────────────── DISPATCH ─────────────────────────────────────

/**
 * Build the canonical voucher for a queue row.
 * Returns `null` when the row is not eligible yet (module off, cutover date, an
 * accrued expense waiting on payment) — it stays PENDING and is retried later.
 * Throws `TallyBuildError` when the row can never be built as-is (missing ledger,
 * unbalanced) — the worker records that as FAILED.
 */
export async function buildVoucher(row: QueueRow): Promise<TallyVoucherPayload | null> {
  const cfg = await (await import('./tally.config')).getTallyConfig();

  if (!cfg.syncEnabled) return null;
  if (cfg.syncFromDate && row.entityDate < cfg.syncFromDate) return null;

  const moduleOn: Record<string, boolean> = {
    SALES_BILL: cfg.syncSales,
    POS_SALE: cfg.syncSales,
    PAYMENT_IN: cfg.syncReceipts,
    PURCHASE_BILL: cfg.syncPurchases,
    SUPPLIER_PAYMENT: cfg.syncPurchases,
    EXPENSE: cfg.syncExpenses,
    STOCK_TRANSFER: cfg.syncStockJournal,
    RAW_INTAKE: false,
  };
  if (!moduleOn[row.entityType]) return null;

  const ix = await loadLedgerIndex();

  switch (row.entityType as TallyEntityType) {
    case 'SALES_BILL': return buildSalesBill(row, ix, cfg);
    case 'POS_SALE': return buildPosSale(row, ix);
    case 'PAYMENT_IN': return buildReceipt(row, ix);
    case 'PURCHASE_BILL': return buildPurchase(row, ix, cfg);
    case 'SUPPLIER_PAYMENT': return buildSupplierPayment(row, ix);
    case 'EXPENSE': return buildExpense(row, ix, cfg);
    case 'STOCK_TRANSFER': return buildStockJournal(row, cfg);
    default: return null;
  }
}
