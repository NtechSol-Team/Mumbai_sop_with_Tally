'use client';

import { format } from 'date-fns';
import type { PosTxn } from '@/hooks/usePos';
import { androidPrinter, hasAndroidBridge } from '@/lib/print/android-bridge';
import { ist } from '@/lib/utils';

const STORE_NAME = 'Mumbai ERP';
const STORE_TAGLINE = '';

/**
 * Whose shop the receipt is printed by. Each outlet is its own registered
 * business, so its counter receipts must carry ITS name, address, GSTIN and food
 * licence — not the parent company's. Falls back to the company details when no
 * outlet is in context (e.g. an admin using the till).
 */
export interface StoreProfile {
  name: string;
  tagline?: string | null;
  address?: string | null;
  phone?: string | null;
  gstin?: string | null;
  fssaiNumber?: string | null;
  /** Optional closing line, replacing the default thank-you. */
  footer?: string | null;
}

export const DEFAULT_STORE: StoreProfile = { name: STORE_NAME, tagline: STORE_TAGLINE };

const AUTOPRINT_KEY = 'mumbai-erp-pos-autoprint';

export function getAutoPrint(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(AUTOPRINT_KEY) !== 'off';
}

export function setAutoPrint(on: boolean): void {
  localStorage.setItem(AUTOPRINT_KEY, on ? 'on' : 'off');
}

const inr = (v: string | number) => `Rs ${Number(v).toFixed(2)}`;

/**
 * Can this item name share a line with the Qty/Rate/Amt figures, or does it
 * need the full width to itself (figures dropping to the line below)?
 *
 * 72mm of printable paper is 257px at 96dpi; the fixed-width figure columns
 * below (.q/.r/.a) eat 160px of it, leaving ~97px for the name. Courier New
 * is monospace at 0.6em per character, so at the 20px name size that is eight
 * characters. Non-Latin names (Gujarati) fall back to a proportional font
 * whose width we cannot predict, so they always keep the safe two-line form.
 */
const NAME_CHARS_BESIDE_NUMBERS = 8;
function fitsBesideNumbers(name: string): boolean {
  return /^[\x20-\x7E]+$/.test(name) && name.length <= NAME_CHARS_BESIDE_NUMBERS;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render `html` into a hidden iframe and trigger the browser print dialog (or silent print, if the browser/kiosk flag is configured for it). */
function printHtml(html: string): void {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const cleanup = () => setTimeout(() => iframe.remove(), 60_000);
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      cleanup();
    }
  };
  iframe.srcdoc = html;
}

/**
 * Load a PDF blob (e.g. a bill fetched from the API) into a hidden iframe and trigger
 * the browser print dialog for it — one click, no separate "open then print" step.
 * Chrome's built-in PDF viewer needs a beat to finish rendering after the iframe's own
 * load event before print() reliably grabs the right content, hence the short delay.
 *
 * Inside the Mumbai ERP Print Bridge Android app there is no PDF viewer or print dialog in
 * the WebView, so the blob is handed to the app instead, which opens it in the system
 * PDF viewer (from where it can be shared/printed via any installed service).
 */
export function printPdfBlob(blob: Blob): void {
  if (hasAndroidBridge()) {
    void androidPrinter.openPdf(blob, `bill-${Date.now()}.pdf`);
    return;
  }
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const cleanup = () => setTimeout(() => { iframe.remove(); URL.revokeObjectURL(url); }, 60_000);
  iframe.onload = () => {
    setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } finally {
        cleanup();
      }
    }, 300);
  };
  iframe.src = url;
}

/**
 * Split the GST already embedded in a GST-inclusive total into its CGST/SGST
 * halves, purely for display. A POS counter sale is always intra-state (a
 * walk-in customer physically at the shop), so there's no IGST case to handle.
 * `cgst + sgst` is constructed to equal `taxTotal` to the paisa (no rounding
 * drift), and `base + taxTotal` always equals `grandTotal`.
 */
export function gstBreakup(grandTotal: number, taxTotal: number): { base: number; cgst: number; sgst: number; halfRate: number } | null {
  if (taxTotal <= 0) return null;
  const base = grandTotal - taxTotal;
  const cgst = Math.round(taxTotal * 50) / 100;
  const sgst = Math.round((taxTotal - cgst) * 100) / 100;
  const effectiveRate = base > 0 ? (taxTotal / base) * 100 : 0;
  return { base, cgst, sgst, halfRate: effectiveRate / 2 };
}

/**
 * 80mm thermal-style receipt (B2C — no GST invoice, taxes shown as included).
 * Renders into a hidden iframe and opens the browser print dialog, which works
 * with any installed thermal/receipt printer as well as normal printers.
 */
export function printReceipt(txn: PosTxn, opts: { cashierName?: string; store?: StoreProfile } = {}): void {
  const store = opts.store ?? DEFAULT_STORE;
  const itemsRows = txn.items
    .map((it) => {
      const name = it.productNameSnapshot;
      const qty = String(Number(it.quantity));
      const rate = Number(it.unitPrice).toFixed(2);
      const amt = inr(it.lineTotal);
      const disc = Number(it.discount);
      const nums =
        `<span class="nums"><span class="q">${qty}</span><span class="r">${rate}</span><span class="a">${amt}</span></span>`;
      // Short name → everything on one line; long name → name gets the full
      // width and the figures drop underneath it (see fitsBesideNumbers).
      const body = fitsBesideNumbers(name)
        ? `<div class="line"><span class="nm">${esc(name)}</span>${nums}</div>`
        : `<div class="line"><span class="nm">${esc(name)}</span></div><div class="line">${nums}</div>`;
      return body + (disc > 0 ? `<div class="disc-note">Discount −${inr(disc)}</div>` : '');
    })
    .join('');

  const discountTotal = Number(txn.itemDiscount) + Number(txn.billDiscount);
  // No GST bifurcation on the receipt unless this branch actually has a GSTIN
  // set in Settings — an outlet with no GST registration prints a plain total.
  const gst = store.gstin ? gstBreakup(Number(txn.grandTotal), Number(txn.taxTotal)) : null;

  // Card/UPI amount only — the cash/cash-received/change breakdown is a
  // till-drawer detail, not something the customer's copy needs to show.
  const onlinePart = Number(txn.cardAmount ?? 0) + Number(txn.upiAmount ?? 0);
  const payLine = onlinePart > 0 ? `<div class="row"><span>Online (Card/UPI)</span><span>${inr(onlinePart)}</span></div>` : '';

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: 80mm auto; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* Tight top/bottom padding — the header sits near the tear and the thank-you
     line has minimal trailing blank. */
  body { width: 72mm; margin: 0 auto; padding: 1mm 2mm 2mm; font-family: 'Courier New', ui-monospace, monospace; font-size: 12px; color: #000; }
  .center { text-align: center; }
  .store { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
  .tagline { font-size: 10px; margin-top: 1px; }
  .token-num { margin: 2px 0; font-size: 20px; font-weight: 800; line-height: 1; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .meta { font-size: 11px; }
  /* Items — each line decides for itself whether the name sits beside the
     figures or above them (see fitsBesideNumbers). The figure columns keep
     fixed widths in BOTH layouts, so Qty/Rate/Amt still line up vertically
     down the whole receipt no matter which form each item took. */
  .items-head { display: flex; align-items: baseline; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px dashed #000; padding-bottom: 3px; margin-bottom: 2px; }
  .line { display: flex; align-items: baseline; padding: 1px 0; }
  .nm { flex: 1 1 auto; min-width: 0; font-size: 20px; font-weight: 700; line-height: 1.25; word-break: break-word; }
  .nums { flex: 0 0 auto; margin-left: auto; display: flex; align-items: baseline; }
  .nums > span { text-align: right; white-space: nowrap; font-weight: 700; }
  .q { width: 30px; font-size: 24px; }
  .r { width: 52px; font-size: 13px; }
  .a { width: 78px; font-size: 13px; }
  .items-head .nums > span { font-size: 11px; }
  .disc-note { font-size: 10px; color: #444; }
  .row { display: flex; justify-content: space-between; padding: 1px 0; }
  .total { font-size: 15px; font-weight: 800; border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 3px 0; margin: 4px 0; }
  .foot { margin-top: 4px; font-size: 11px; }
  .void { font-size: 18px; font-weight: 800; border: 2px solid #000; padding: 2px 8px; display: inline-block; margin: 6px 0; transform: rotate(-4deg); }
  /* A single big "P" — a quick visual flag for the counter, not a label to read.
     Absolutely placed in the token block's empty left margin so it costs no
     extra vertical space on the slip. */
  .tokenwrap { position: relative; }
  .parcel { position: absolute; left: 1mm; bottom: -2px; font-size: 46px; font-weight: 800; line-height: 1; }
  .parcel-solo { font-size: 46px; font-weight: 800; line-height: 1; margin: 2px 0; }
</style>
</head>
<body>
  <div class="center">
    <div class="store">${esc(store.name)}</div>
    ${store.tagline ? `<div class="tagline">${esc(store.tagline)}</div>` : ''}
    ${store.address ? `<div class="tagline">${esc(store.address)}</div>` : ''}
    ${store.phone ? `<div class="tagline">Ph: ${esc(store.phone)}</div>` : ''}
    ${store.gstin ? `<div class="tagline">GSTIN: ${esc(store.gstin)}</div>` : ''}
    ${store.fssaiNumber ? `<div class="tagline">FSSAI: ${esc(store.fssaiNumber)}</div>` : ''}
    ${txn.status === 'VOID' ? '<div class="void">VOID</div>' : ''}
    ${txn.tokenNumber != null
      ? `<div class="tokenwrap">
           ${txn.orderType === 'PARCEL' ? '<span class="parcel">P</span>' : ''}
           <div class="token-num">TOKEN : ${txn.tokenNumber}</div>
         </div>`
      : (txn.orderType === 'PARCEL' ? '<div class="parcel-solo">P</div>' : '')}
  </div>
  <hr />
  <div class="meta">
    <div class="row"><span>Receipt</span><span>${esc(txn.receiptNumber)}</span></div>
    <div class="row"><span>Date</span><span>${format(ist(txn.soldAt), 'dd MMM yyyy, hh:mm a')}</span></div>
    ${opts.cashierName ? `<div class="row"><span>Cashier</span><span>${esc(opts.cashierName)}</span></div>` : ''}
    ${txn.customerName ? `<div class="row"><span>Customer</span><span>${esc(txn.customerName)}</span></div>` : ''}
  </div>
  <hr />
  <div class="items-head">
    <span style="flex:1 1 auto">Item</span>
    <span class="nums"><span class="q">Qty</span><span class="r">Rate</span><span class="a">Amt</span></span>
  </div>
  ${itemsRows}
  <hr />
  <div class="row"><span>Sub-total</span><span>${inr(txn.subTotal)}</span></div>
  ${discountTotal > 0 ? `<div class="row"><span>Discount</span><span>−${inr(discountTotal)}</span></div>` : ''}
  <div class="row total"><span>TOTAL</span><span>${inr(txn.grandTotal)}</span></div>
  ${gst ? `
  <div class="row"><span>Taxable Value</span><span>${inr(gst.base)}</span></div>
  <div class="row"><span>CGST @${gst.halfRate.toFixed(2)}%</span><span>${inr(gst.cgst)}</span></div>
  <div class="row"><span>SGST @${gst.halfRate.toFixed(2)}%</span><span>${inr(gst.sgst)}</span></div>` : ''}
  ${payLine}
  <div class="center foot">
    ${store.footer ? esc(store.footer) : 'Thank you! Visit again 🙏'}<br />
    — ${esc(store.name)} —
  </div>
</body>
</html>`;

  printHtml(html);
}

export interface OrderPickListLine { name: string; unit: string; approvedQty: number; price: number }

/**
 * What the outlet still owes on this order, printed at the foot of the slip so
 * whoever packs or delivers knows whether to collect. `method` is only known once
 * something has actually been paid.
 */
export interface OrderPaymentInfo {
  status: 'PENDING' | 'PARTIAL' | 'PAID';
  amountDue: number;
  method?: string | null;
}

export const PAYMENT_STATUS_TEXT: Record<OrderPaymentInfo['status'], string> = {
  PENDING: 'PAYMENT PENDING',
  PARTIAL: 'PARTIALLY PAID',
  PAID: 'PAYMENT RECEIVED',
};

/**
 * 80mm thermal order slip. Two moments print this, same layout:
 *  - the instant an order is placed (no fulfillmentSource yet) — an automatic
 *    "New Order Receipt" so godown/admin start processing immediately, without
 *    waiting on the payment/credit-approval workflow;
 *  - when the admin dispatches it (fulfillmentSource chosen) — an "Order Pick
 *    List" naming where the goods came from.
 */
export function printOrderPickList(
  order: {
    orderNumber: string; outletName: string;
    fulfillmentSource?: 'MAIN_BRANCH' | 'GODOWN' | null;
    isGstBill: boolean; orderDate?: string;
    payment?: OrderPaymentInfo;
  },
  lines: OrderPickListLine[],
): void {
  const total = lines.reduce((s, l) => s + l.approvedQty * l.price, 0);
  const itemRows = lines
    .map(
      (l) => `
      <tr><td class="name" colspan="3">${esc(l.name)}</td></tr>
      <tr class="sub"><td><b class="qty">${l.approvedQty} ${esc(l.unit)}</b> × ${inr(l.price)}</td><td></td><td class="num amt">${inr(l.approvedQty * l.price)}</td></tr>`,
    )
    .join('');
  const dateLabel = order.fulfillmentSource ? 'Confirmed' : 'Received';
  const dateValue = format(ist(order.orderDate), 'dd MMM yyyy, hh:mm a');
  const footer = order.fulfillmentSource ? 'Pack &amp; dispatch the quantities above.' : 'New order — start processing.';

  const pay = order.payment;
  const paymentBlock = pay
    ? `<div class="pay">
        <div class="status">${PAYMENT_STATUS_TEXT[pay.status]}</div>
        <div class="detail">${
          pay.status === 'PAID'
            ? `Paid${pay.method ? ` by ${esc(pay.method)}` : ''}`
            : `${inr(pay.amountDue)} to collect${pay.method ? ` · part paid by ${esc(pay.method)}` : ''}`
        }</div>
      </div>`
    : '';

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: 80mm auto; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 72mm; margin: 0 auto; padding: 4mm 2mm 8mm; font-family: 'Courier New', ui-monospace, monospace; font-size: 12px; color: #000; }
  .center { text-align: center; }
  .store { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
  .tagline { font-size: 10px; margin-top: 1px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .meta { font-size: 11px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  td.name { font-size: 21px; font-weight: 800; padding-top: 5px; line-height: 1.2; }
  tr.sub td { font-size: 13px; }
  .qty { font-size: 15px; font-weight: 800; }
  .amt { font-size: 15px; font-weight: 800; }
  .pay { border: 2px solid #000; padding: 5px 6px; margin-top: 6px; text-align: center; }
  .pay .status { font-size: 16px; font-weight: 800; letter-spacing: 0.5px; }
  .pay .detail { font-size: 12px; margin-top: 2px; }
  .num { text-align: right; white-space: nowrap; }
  .row { display: flex; justify-content: space-between; padding: 1px 0; }
  .total { font-size: 15px; font-weight: 800; border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 3px 0; margin: 4px 0; }
</style>
</head>
<body>
  <div class="center">
    <div class="store">${esc(STORE_NAME)}</div>
    <div class="tagline">${order.fulfillmentSource ? 'Order Pick List' : 'New Order Receipt'}</div>
  </div>
  <hr />
  <div class="meta">
    <div class="row"><span>Order</span><span>${esc(order.orderNumber)}</span></div>
    <div class="row"><span>Outlet</span><span>${esc(order.outletName)}</span></div>
    ${order.fulfillmentSource ? `<div class="row"><span>Fulfil from</span><span>${order.fulfillmentSource === 'GODOWN' ? 'Warehouse' : 'Main Branch'}</span></div>` : ''}
    <div class="row"><span>${dateLabel}</span><span>${dateValue}</span></div>
    <div class="row"><span>Bill type</span><span>${order.isGstBill ? 'With GST' : 'No GST'}</span></div>
  </div>
  <hr />
  <table>${itemRows}</table>
  <hr />
  <div class="row total"><span>ESTIMATED TOTAL</span><span>${inr(total)}</span></div>
  ${paymentBlock}
  <p class="center" style="margin-top:8px;font-size:11px;">${footer}</p>
</body>
</html>`;

  printHtml(html);
}


export interface BatchLabelData {
  batchNumber: string;
  productName: string;
  quantity: number;
  unit: string;
  productionDate: string; // ISO
  ingredients: Array<{ name: string; quantity: number; unit: string }>;
}

const qtyStr = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

/**
 * 80mm thermal production-batch label — printed from the Production Orders list.
 * Shows what was made (product + quantity + when) and the ingredients that went
 * into it (name + weight), so a physical slip can travel with the batch.
 */
export function printBatchLabel(b: BatchLabelData): void {
  const ingredientRows = b.ingredients
    .map(
      (it) => `
      <tr><td class="name" colspan="2">${esc(it.name)}</td></tr>
      <tr class="sub"><td></td><td class="num">${qtyStr(it.quantity)} ${esc(it.unit)}</td></tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: 80mm auto; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 72mm; margin: 0 auto; padding: 4mm 2mm 8mm; font-family: 'Courier New', ui-monospace, monospace; font-size: 12px; color: #000; }
  .center { text-align: center; }
  .store { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
  .tagline { font-size: 10px; margin-top: 1px; }
  .product { font-size: 22px; font-weight: 800; line-height: 1.15; margin: 4px 0 2px; }
  .qty { font-size: 16px; font-weight: 700; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .meta { font-size: 11px; }
  .row { display: flex; justify-content: space-between; padding: 1px 0; }
  .sec { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  td.name { font-size: 16px; font-weight: 700; padding-top: 4px; line-height: 1.25; }
  tr.sub td { font-size: 13px; font-weight: 700; }
  .num { text-align: right; white-space: nowrap; }
</style>
</head>
<body>
  <div class="center">
    <div class="store">${esc(STORE_NAME)}</div>
    <div class="tagline">Production Batch</div>
    <div class="product">${esc(b.productName)}</div>
    <div class="qty">Qty: ${qtyStr(b.quantity)} ${esc(b.unit)}</div>
  </div>
  <hr />
  <div class="meta">
    <div class="row"><span>Batch</span><span>${esc(b.batchNumber)}</span></div>
    <div class="row"><span>Date &amp; time</span><span>${format(ist(b.productionDate), 'dd MMM yyyy, hh:mm a')}</span></div>
  </div>
  <hr />
  ${b.ingredients.length
    ? `<div class="sec">Ingredients</div><table>${ingredientRows}</table>`
    : '<p class="center" style="font-size:11px;">No ingredients recorded.</p>'}
  <hr />
  <p class="center" style="margin-top:6px;font-size:11px;">Mumbai ERP</p>
</body>
</html>`;

  printHtml(html);
}


export interface SessionPaymentModeRow { mode: string; transactions: number; revenue: number }

/**
 * 80mm thermal payment-mode sales report for the current POS session — how
 * much came in by Cash / Card / UPI (and Split), with the order count behind
 * each, printed straight from the till instead of a full item list.
 */
export function printSessionPaymentModeReport(
  rows: SessionPaymentModeRow[],
  meta: { sessionNumber: string; cashierName?: string; openedAt: string; store?: StoreProfile },
): void {
  const store = meta.store ?? DEFAULT_STORE;
  const totalTxns = rows.reduce((s, r) => s + r.transactions, 0);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const modeRows = rows
    .map(
      (r) => `
      <tr><td class="name" colspan="2">${esc(PAYMENT_MODE_LABEL[r.mode] ?? r.mode)}</td><td class="num">${inr(r.revenue)}</td></tr>
      <tr class="sub"><td colspan="2">${r.transactions} order${r.transactions === 1 ? '' : 's'}</td><td></td></tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: 80mm auto; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 72mm; margin: 0 auto; padding: 4mm 2mm 8mm; font-family: 'Courier New', ui-monospace, monospace; font-size: 12px; color: #000; }
  .center { text-align: center; }
  .store { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
  .tagline { font-size: 10px; margin-top: 1px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .meta { font-size: 11px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  td.name { font-weight: 700; padding-top: 3px; }
  tr.sub td { font-size: 11px; color: #444; }
  .num { text-align: right; white-space: nowrap; }
  .row { display: flex; justify-content: space-between; padding: 1px 0; }
  .total { font-size: 15px; font-weight: 800; border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 3px 0; margin: 4px 0; }
</style>
</head>
<body>
  <div class="center">
    <div class="store">${esc(store.name)}</div>
    <div class="tagline">Payment Mode Report</div>
  </div>
  <hr />
  <div class="meta">
    <div class="row"><span>Session</span><span>${esc(meta.sessionNumber)}</span></div>
    <div class="row"><span>Opened</span><span>${format(ist(meta.openedAt), 'dd MMM yyyy, hh:mm a')}</span></div>
    ${meta.cashierName ? `<div class="row"><span>Cashier</span><span>${esc(meta.cashierName)}</span></div>` : ''}
    <div class="row"><span>Printed</span><span>${format(ist(), 'hh:mm a')}</span></div>
  </div>
  <hr />
  ${rows.length ? `<table>${modeRows}</table>` : '<p class="center">No sales yet.</p>'}
  <hr />
  <div class="row"><span>Orders</span><span>${totalTxns}</span></div>
  <div class="row total"><span>TOTAL</span><span>${inr(totalRevenue)}</span></div>
</body>
</html>`;

  printHtml(html);
}

export interface PaymentModeReportRow { mode: string; transactions: number; revenue: number }

export const PAYMENT_MODE_LABEL: Record<string, string> = {
  CASH: 'Cash', CARD: 'Card', UPI: 'UPI', SPLIT: 'Split (Cash + Online)',
};

/**
 * A4-style payment-mode breakdown for the back-office analytics screen — how
 * much came in by Cash / Card / UPI, with the order count behind each, so the
 * report reconciles against the till without listing every item sold.
 */
export function printAnalyticsPaymentModeReport(rows: PaymentModeReportRow[], meta: { periodLabel: string; generatedBy?: string }): void {
  const totalTxns = rows.reduce((s, r) => s + r.transactions, 0);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const bodyRows = rows
    .map(
      (r) => `
      <tr>
        <td>${esc(PAYMENT_MODE_LABEL[r.mode] ?? r.mode)}</td>
        <td class="num">${r.transactions}</td>
        <td class="num">${inr(r.revenue)}</td>
      </tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: A4; margin: 14mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; color: #111827; font-size: 12px; }
  h1 { font-size: 20px; margin-bottom: 2px; }
  .sub { color: #6B7280; font-size: 12px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #E5E7EB; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: #6B7280; border-bottom: 2px solid #111827; }
  td.num, th.num { text-align: right; }
  tfoot td { font-weight: 700; border-top: 2px solid #111827; border-bottom: none; }
  tr:nth-child(even) { background: #FAFAFA; }
</style>
</head>
<body>
  <h1>${esc(STORE_NAME)} — Payment Mode Report</h1>
  <p class="sub">${esc(meta.periodLabel)}${meta.generatedBy ? ` · Generated by ${esc(meta.generatedBy)}` : ''} · Printed ${format(ist(), 'dd MMM yyyy, hh:mm a')}</p>
  <table>
    <thead><tr><th>Payment Method</th><th class="num">Orders</th><th class="num">Total Amount</th></tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${totalTxns}</td><td class="num">${inr(totalRevenue)}</td></tr></tfoot>
  </table>
</body>
</html>`;

  printHtml(html);
}
