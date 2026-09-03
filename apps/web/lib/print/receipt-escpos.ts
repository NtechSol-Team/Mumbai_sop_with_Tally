'use client';

import { format } from 'date-fns';
import type { PosTxn } from '@/hooks/usePos';
import {
  DEFAULT_STORE, gstBreakup, PAYMENT_MODE_LABEL, PAYMENT_STATUS_TEXT,
  type BatchLabelData, type OrderPaymentInfo, type OrderPickListLine,
  type SessionPaymentModeRow, type StoreProfile,
} from '@/lib/receipt-print';
import { EscPosEncoder, wrapText, type MonoRaster } from './escpos-encoder';
import { loadImageAsRaster, textToRaster } from './escpos-image';
import { colsFor, dotsFor, type PrinterSettings } from './printer-settings';
import { ist } from '@/lib/utils';

/** True when every character is printable ASCII the thermal font can render. */
const isAscii = (s: string) => !/[^\x00-\x7f]/.test(s);

/**
 * Print a standalone text line that might contain non-Latin script (Gujarati
 * product/shop names). ASCII stays native printer text — crisp and fast; anything
 * else is rendered to a bitmap and printed as an image, because the printer's
 * built-in fonts have no glyph for it and would otherwise emit "????".
 */
function smartLine(
  e: EscPosEncoder,
  s: PrinterSettings,
  text: string,
  o: { bold?: boolean; center?: boolean; big?: boolean; tall?: boolean } = {},
): void {
  if (isAscii(text)) {
    e.align(o.center ? 'center' : 'left');
    if (o.bold) e.bold(true);
    // "big" doubles both dimensions (halving the usable columns — for totals).
    // "tall" only doubles the height, so item names print larger without
    // shrinking how many characters fit on a line.
    if (o.big) e.size(2, 2);
    else if (o.tall) e.size(1, 2);
    for (const ln of wrapText(text, o.big ? Math.floor(e.cols / 2) : e.cols)) e.line(ln);
    if (o.big || o.tall) e.size(1, 1);
    if (o.bold) e.bold(false);
    e.align('left');
    return;
  }
  e.align(o.center ? 'center' : 'left');
  e.imageRaster(textToRaster(text, {
    widthDots: dotsFor(s),
    fontPx: o.big ? 48 : o.tall ? 36 : 28,
    bold: o.bold ?? o.big,
    align: o.center ? 'center' : 'left',
  }));
  e.align('left');
}

/** A "Label   value" row where the value might be non-Latin (e.g. customer name). */
function labelLine(e: EscPosEncoder, s: PrinterSettings, label: string, value: string): void {
  if (isAscii(value)) { e.leftRight(label, value); return; }
  e.align('left').line(`${label}:`);
  e.imageRaster(textToRaster(value, { widthDots: dotsFor(s), fontPx: 28, align: 'left' }));
}

/**
 * ESC/POS renderings of the same documents `lib/receipt-print.ts` renders as
 * HTML. The HTML versions remain the Windows/system-dialog path; these byte
 * versions go straight to Bluetooth thermal printers on Android.
 */

// The company's own name — used for head-office documents (pick lists), while a
// counter receipt prints the selling outlet's identity via its StoreProfile.
const STORE_NAME = DEFAULT_STORE.name;

const inr = (v: string | number) => `Rs ${Number(v).toFixed(2)}`;

/**
 * The parcel "P", drawn one row per line of text that the receipt already
 * prints, so it occupies nothing but the blank left margin and adds no height.
 *
 * A magnified character can't do this: a printer sizes each line to its tallest
 * glyph, so a 4x "P" forces its whole line 4x tall and opens a band of white
 * space. Spreading the letter across four existing 1x lines keeps it just as
 * large while costing zero extra paper. '#' cells print as CP437 solid blocks.
 */
// Fixed-width QTY/RATE/AMT segments shared by the header and every item's
// detail line, so the numbers actually sit under their column label instead
// of floating as one loose "qty x rate ... amount" blob. `left` is padded out
// to the same total line length on every call (header or data), so the
// segment always starts at the exact same column.
const QTY_W = 5;
const RATE_W = 9;
const AMT_W = 12;
const COLS_W = QTY_W + RATE_W + AMT_W;
function tableRow(cols: number, left: string, qty: string, rate: string, amt: string): string {
  const segment = qty.padStart(QTY_W) + rate.padStart(RATE_W) + amt.padStart(AMT_W);
  return left.padEnd(Math.max(left.length, cols - COLS_W)) + segment;
}
function tableRowPrefix(cols: number, left: string): string {
  return left.padEnd(Math.max(left.length, cols - COLS_W));
}

const PARCEL_GLYPHS = [
  ['#####', '#   #', '#####', '#    '], // 80mm: plenty of margin
  ['###', '# #', '###', '#  '],         // 58mm: narrower letter still reads
];
const BLOCK_BYTE = 0xdb;

/** Centred line that may carry one row of the parcel glyph in its left margin. */
function glyphLine(e: EscPosEncoder, text: string, row?: string): void {
  if (!row) { e.align('center').line(text); return; }
  const pad = Math.max(1, Math.floor((e.cols - text.length) / 2) - row.length);
  e.align('left');
  e.raw([...row].map((c) => (c === '#' ? BLOCK_BYTE : 0x20)));
  e.text(' '.repeat(pad) + text).raw([0x0a]);
}

// The logo raster is expensive to build (fetch + dither), so cache per dot-width.
const logoCache = new Map<number, Promise<MonoRaster | null>>();
function getLogo(maxWidthDots: number): Promise<MonoRaster | null> {
  let cached = logoCache.get(maxWidthDots);
  if (!cached) {
    cached = loadImageAsRaster('/logo.png', { maxWidthDots }).catch(() => null);
    logoCache.set(maxWidthDots, cached);
  }
  return cached;
}

/**
 * Receipt masthead: the selling shop's own identity. For an outlet's counter
 * receipt that means the outlet's name, address, GSTIN and food licence — the
 * company name only stands in when no outlet is in context.
 */
async function header(
  e: EscPosEncoder,
  s: PrinterSettings,
  store: StoreProfile,
  subtitle?: string,
  /** One entry per plain contact line (phone, GSTIN, FSSAI) — a parcel-glyph row or undefined. */
  glyphRows?: Array<string | undefined>,
): Promise<void> {
  e.init().align('center');
  if (s.printLogo) {
    const logo = await getLogo(Math.min(dotsFor(s), 320));
    if (logo) { e.imageRaster(logo); e.feed(1); }
  }
  // Shop name and address may be Gujarati, so route them through smartLine.
  // The name should be ONE imposing line, not a broken two-line wrap: "big"
  // doubles width and halves the columns, so a longer name (e.g. "SHREE
  // LIVE KITCHEN COUNTER", 26 chars vs 24 at 80mm) drops to double-HEIGHT
  // only — same height, full column count, fits on a single line.
  const nameFitsBig = !isAscii(store.name) || store.name.length <= Math.floor(colsFor(s) / 2);
  smartLine(e, s, store.name, { bold: true, center: true, big: nameFitsBig, tall: !nameFitsBig });
  if (subtitle) smartLine(e, s, subtitle, { center: true });
  else if (store.tagline) smartLine(e, s, store.tagline, { center: true });

  const g = glyphRows ?? [];
  let gi = 0;
  // The address hosts a glyph row too when it's plain ASCII on one line —
  // otherwise smartLine handles it (wrapping, or rasterising Gujarati).
  const addressHosts = !!store.address && isAscii(store.address) && store.address.length <= e.cols;
  if (store.address && !addressHosts) smartLine(e, s, store.address, { center: true });
  // Pull the lines flush together so the glyph's rows join into one letter
  // instead of printing as separate bands. Only while the glyph is running —
  // and it also tightens the contact block a touch, which is no loss.
  if (g.some(Boolean)) e.raw([0x1b, 0x33, 24]);
  e.align('center');
  if (store.address && addressHosts) glyphLine(e, store.address, g[gi++]);
  if (store.phone) glyphLine(e, `Ph: ${store.phone}`, g[gi++]);
  if (store.gstin) glyphLine(e, `GSTIN: ${store.gstin}`, g[gi++]);
  if (store.fssaiNumber) glyphLine(e, `FSSAI: ${store.fssaiNumber}`, g[gi++]);
  e.align('left');
}

/** 80/58mm POS receipt — mirrors `printReceipt`'s HTML layout. */
export async function receiptBytes(
  txn: PosTxn,
  opts: { cashierName?: string; store?: StoreProfile },
  s: PrinterSettings,
): Promise<Uint8Array> {
  const store = opts.store ?? DEFAULT_STORE;
  const e = new EscPosEncoder({ cols: colsFor(s) });
  const isParcel = txn.orderType === 'PARCEL';
  const hasToken = txn.tokenNumber != null;

  // Lay the parcel glyph over the last few contact lines that already print
  // centred and short, so every row lands in blank margin. Only used when
  // every one of those rows genuinely has room to its left, else we fall
  // back to a plain marker. The token line is now one combined "TOKEN : N"
  // line at its own (larger) size, so it can't host glyph rows itself —
  // the glyph must fully resolve within the plain contact lines.
  const contactLines: string[] = [];
  // Must mirror header()'s own ordering and its address-hosting rule exactly.
  if (store.address && isAscii(store.address) && store.address.length <= e.cols) contactLines.push(store.address);
  if (store.phone) contactLines.push(`Ph: ${store.phone}`);
  if (store.gstin) contactLines.push(`GSTIN: ${store.gstin}`);
  if (store.fssaiNumber) contactLines.push(`FSSAI: ${store.fssaiNumber}`);
  const glyph = !isParcel || !hasToken
    ? undefined
    : PARCEL_GLYPHS.find((rows) => {
        const first = contactLines.length - rows.length;
        return first >= 0 && rows.every((row, i) => Math.floor((e.cols - contactLines[first + i].length) / 2) - row.length >= 1);
      });
  const firstHost = glyph ? contactLines.length - glyph.length : -1;

  // Kick the cash drawer on any sale that takes cash. The drawer is wired to
  // the printer's RJ11 port, so this rides the receipt's own byte stream; on a
  // till with no drawer (or no printer) the command is simply ignored.
  // FIRST in the stream, before any text: the mech pauses for the pulse
  // duration wherever this sits, and mid-receipt that pause looked like the
  // printer jamming between the header and the token. Up front, the drawer is
  // already opening as the paper starts — better for the cashier anyway.
  // Card/UPI-only sales deliberately leave it shut; there's no cash to handle.
  e.init();
  if (txn.status !== 'VOID' && (txn.paymentMode === 'CASH' || Number(txn.cashAmount ?? 0) > 0)) {
    e.drawer();
  }

  const headerGlyph = contactLines.map((_, i) => (glyph && i >= firstHost ? glyph[i - firstHost] : undefined));
  await header(e, s, store, undefined, headerGlyph);

  if (txn.status === 'VOID') {
    e.feed(1).invert(true).size(2, 2).line('  VOID  ').size(1, 1).invert(false);
  }
  const TOKEN_MAG = 2;
  if (hasToken) {
    if (glyph) e.raw([0x1b, 0x32]); // restore default line spacing after the glyph block
    if (isParcel && !glyph) {
      // Narrow paper or a sparse store profile left no margin — mark it inline
      // at the token's own size, which still costs no extra height.
      e.align('left').bold(true).size(TOKEN_MAG, TOKEN_MAG);
      const tokenStr = `TOKEN : ${txn.tokenNumber}`;
      const start = Math.floor((e.cols - tokenStr.length * TOKEN_MAG) / 2);
      e.line('P' + ' '.repeat(Math.max(1, Math.floor((start - TOKEN_MAG) / TOKEN_MAG))) + tokenStr);
      e.size(1, 1).bold(false);
    } else {
      e.align('center').bold(true).size(TOKEN_MAG, TOKEN_MAG).line(`TOKEN : ${txn.tokenNumber}`).size(1, 1).bold(false);
    }
  } else if (isParcel) {
    // No token to hang it off (shouldn't happen for a counter sale) — stand alone.
    e.align('center').bold(true).size(4, 4).line('P').size(1, 1).bold(false);
  }
  e.align('left').divider();
  e.leftRight('Receipt', txn.receiptNumber);
  e.leftRight('Date', format(ist(txn.soldAt), 'dd MMM yyyy, hh:mm a'));
  if (opts.cashierName) labelLine(e, s, 'Cashier', opts.cashierName);
  if (txn.customerName) labelLine(e, s, 'Customer', txn.customerName);
  e.divider();
  e.bold(true).line(tableRow(e.cols, 'ITEM', 'QTY', 'RATE', 'AMT')).bold(false);
  e.divider();

  const nameWidth = e.cols - COLS_W;
  txn.items.forEach((it) => {
    const qty = Number(it.quantity);
    const disc = Number(it.discount);
    const name = it.productNameSnapshot;
    const unit = Number(it.unitPrice).toFixed(2);
    // A short Latin name shares the line with its figures; a long one (or a
    // Gujarati one, which prints as a bitmap and so can't share a text line)
    // takes the full width and the figures drop underneath.
    const oneLine = isAscii(name) && name.length <= nameWidth;

    // Product name may be Gujarati → printed as an image when it is. Printed
    // taller than body text so item names stand out on the paper.
    if (!oneLine) smartLine(e, s, name, { bold: true, tall: true });

    // Qty/Rate/Amt as three fixed columns lined up under the header above —
    // not free-flowing text, so they actually read as a table. Name and qty
    // print at double height — size() with width fixed at 1 only affects
    // vertical size, so the column math (plain character counts) still lines up.
    e.bold(true);
    if (oneLine) e.size(1, 2).text(name.padEnd(nameWidth)).size(1, 1);
    else e.text(tableRowPrefix(e.cols, ''));
    e.size(1, 2).text(String(qty).padStart(QTY_W)).size(1, 1);
    e.text(unit.padStart(RATE_W) + inr(it.lineTotal).padStart(AMT_W));
    e.raw([0x0a]);
    e.bold(false);
    // Own line — appending it to the qty line risks the printer word-wrapping
    // "(-Rs" onto a different line than "5.00)", splitting the note in half.
    if (disc > 0) e.line(`Discount -${inr(disc)}`);
  });

  e.divider();
  e.leftRight('Sub-total', inr(txn.subTotal));
  const discountTotal = Number(txn.itemDiscount) + Number(txn.billDiscount);
  if (discountTotal > 0) e.leftRight('Discount', `-${inr(discountTotal)}`);

  e.bold(true).size(2, 2);
  // At double width only cols/2 characters fit per line.
  const totalCols = Math.floor(e.cols / 2);
  const totalStr = inr(txn.grandTotal);
  const totalPad = Math.max(1, totalCols - 'TOTAL'.length - totalStr.length);
  e.line('TOTAL' + ' '.repeat(totalPad) + totalStr);
  e.size(1, 1).bold(false);

  // GST bifurcation — a breakdown of the tax already inside the total above, not
  // an addition to it (POS counter sales are intra-state: CGST+SGST, no IGST).
  // Only shown when this branch actually has a GSTIN set in Settings — no GST
  // registration means a plain total, no CGST/SGST lines.
  const gst = store.gstin ? gstBreakup(Number(txn.grandTotal), Number(txn.taxTotal)) : null;
  if (gst) {
    e.leftRight('Taxable Value', inr(gst.base));
    e.leftRight(`CGST @${gst.halfRate.toFixed(2)}%`, inr(gst.cgst));
    e.leftRight(`SGST @${gst.halfRate.toFixed(2)}%`, inr(gst.sgst));
  }

  // Card/UPI amount only — cash/cash-received/change is a till-drawer detail,
  // not something the customer's copy needs to show.
  const onlinePart = Number(txn.cardAmount ?? 0) + Number(txn.upiAmount ?? 0);
  if (onlinePart > 0) e.leftRight('Online (Card/UPI)', inr(onlinePart));

  e.feed(1);
  smartLine(e, s, store.footer || 'Thank you! Visit again', { center: true });
  smartLine(e, s, `- ${store.name} -`, { center: true });

  if (s.printBarcode) {
    e.feed(1).barcode(txn.receiptNumber, { height: 56, hri: true });
  }

  // Just enough feed to clear the cutter/tear bar (the head sits a few mm below
  // it). This trailing gap is also what shows as blank space at the TOP of the
  // next receipt, so keep it small — was 4, which left too much on both ends.
  e.feed(2).cut();
  return e.encode();
}

/** Godown/admin order slip — mirrors `printOrderPickList` (new-order receipt or, once dispatched, a pick list). */
export function pickListBytes(
  order: {
    orderNumber: string; outletName: string;
    fulfillmentSource?: 'MAIN_BRANCH' | 'GODOWN' | null;
    isGstBill: boolean; orderDate?: string;
    payment?: OrderPaymentInfo;
  },
  lines: OrderPickListLine[],
  s: PrinterSettings,
): Uint8Array {
  const e = new EscPosEncoder({ cols: colsFor(s) });
  e.init().align('center');
  e.bold(true).size(2, 2).line(STORE_NAME).size(1, 1).bold(false);
  e.line(order.fulfillmentSource ? 'Order Pick List' : 'New Order Receipt');

  e.align('left').divider();
  e.leftRight('Order', order.orderNumber);
  e.leftRight('Outlet', order.outletName);
  if (order.fulfillmentSource) e.leftRight('Fulfil from', order.fulfillmentSource === 'GODOWN' ? 'Warehouse' : 'Main Branch');
  e.leftRight(order.fulfillmentSource ? 'Confirmed' : 'Received', format(ist(order.orderDate), 'dd MMM yyyy, hh:mm a'));
  e.leftRight('Bill type', order.isGstBill ? 'With GST' : 'No GST');
  e.divider();

  let total = 0;
  for (const l of lines) {
    total += l.approvedQty * l.price;
    // Double-height (not double-width) keeps the name readable across the counter
    // without halving how many characters fit on the line.
    smartLine(e, s, l.name, { bold: true, tall: true });
    // Quantity and line amount are what gets checked while packing, so both are bold.
    e.bold(true).leftRight(`  ${l.approvedQty} ${l.unit} x ${inr(l.price)}`, inr(l.approvedQty * l.price)).bold(false);
  }

  e.divider();
  e.bold(true).leftRight('ESTIMATED TOTAL', inr(total)).bold(false);

  if (order.payment) {
    const p = order.payment;
    e.divider();
    smartLine(e, s, PAYMENT_STATUS_TEXT[p.status], { bold: true, center: true });
    smartLine(
      e, s,
      p.status === 'PAID'
        ? `Paid${p.method ? ` by ${p.method}` : ''}`
        : `${inr(p.amountDue)} to collect${p.method ? ` (part paid by ${p.method})` : ''}`,
      { center: true },
    );
  }

  e.feed(1).align('center').line(order.fulfillmentSource ? 'Pack & dispatch the quantities above.' : 'New order - start processing.');
  e.feed(4).cut();
  return e.encode();
}

/** Production-batch label — mirrors `printBatchLabel`. */
export function batchLabelBytes(b: BatchLabelData, s: PrinterSettings): Uint8Array {
  const qtyStr = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));
  const e = new EscPosEncoder({ cols: colsFor(s) });
  e.init().align('center');
  smartLine(e, s, STORE_NAME, { bold: true, center: true, big: true });
  e.line('Production Batch');
  e.feed(1);
  // What was made — the headline of the slip.
  smartLine(e, s, b.productName, { bold: true, center: true, tall: true });
  smartLine(e, s, `Qty: ${qtyStr(b.quantity)} ${b.unit}`, { bold: true, center: true });

  e.align('left').divider();
  e.leftRight('Batch', b.batchNumber);
  e.leftRight('Date & time', format(ist(b.productionDate), 'dd MMM yyyy, hh:mm a'));
  e.divider();

  if (b.ingredients.length) {
    e.bold(true).line('INGREDIENTS').bold(false);
    for (const it of b.ingredients) {
      smartLine(e, s, it.name, { bold: true });
      e.leftRight('', `${qtyStr(it.quantity)} ${it.unit}`);
    }
  } else {
    e.align('center').line('No ingredients recorded.').align('left');
  }

  e.divider();
  e.align('center').line(STORE_NAME);
  e.feed(4).cut();
  return e.encode();
}

/** POS session payment-mode sales report — mirrors `printSessionPaymentModeReport`. */
export function sessionPaymentModeReportBytes(
  rows: SessionPaymentModeRow[],
  meta: { sessionNumber: string; cashierName?: string; openedAt: string; store?: StoreProfile },
  s: PrinterSettings,
): Uint8Array {
  const store = meta.store ?? DEFAULT_STORE;
  const e = new EscPosEncoder({ cols: colsFor(s) });
  e.init();
  smartLine(e, s, store.name, { bold: true, center: true, big: true });
  e.align('center').line('Payment Mode Report');

  e.align('left').divider();
  e.leftRight('Session', meta.sessionNumber);
  e.leftRight('Opened', format(ist(meta.openedAt), 'dd MMM yyyy, hh:mm a'));
  if (meta.cashierName) e.leftRight('Cashier', meta.cashierName);
  e.leftRight('Printed', format(ist(), 'hh:mm a'));
  e.divider();

  if (!rows.length) {
    e.align('center').line('No sales yet.').align('left');
  } else {
    for (const r of rows) {
      e.bold(true).leftRight(PAYMENT_MODE_LABEL[r.mode] ?? r.mode, inr(r.revenue)).bold(false);
      e.leftRight(`  ${r.transactions} order${r.transactions === 1 ? '' : 's'}`, '');
    }
  }

  e.divider();
  e.leftRight('Orders', String(rows.reduce((t, r) => t + r.transactions, 0)));
  e.bold(true).leftRight('TOTAL', inr(rows.reduce((t, r) => t + r.revenue, 0))).bold(false);
  e.feed(4).cut();
  return e.encode();
}

/**
 * Diagnostic slip for the settings dialog's "Test print" button — exercises
 * every capability (alignment, sizes, bold/invert, QR, barcode, logo image)
 * so a new printer can be validated in one shot.
 */
export async function testSlipBytes(s: PrinterSettings): Promise<Uint8Array> {
  const e = new EscPosEncoder({ cols: colsFor(s) });
  await header(e, { ...s, printLogo: true }, DEFAULT_STORE, 'Printer test page');
  e.align('left').divider();
  e.leftRight('Paper width', `${s.paperWidthMm}mm (${colsFor(s)} cols)`);
  e.leftRight('Time', format(ist(), 'dd MMM yyyy, hh:mm:ss a'));
  e.divider();
  e.line('Normal text 0123456789');
  e.bold(true).line('Bold text').bold(false);
  e.size(2, 1).line('Double width').size(1, 2).line('Double height').size(2, 2).line('Big').size(1, 1);
  e.invert(true).line(' Inverted ').invert(false);
  e.divider();
  e.align('center').line('QR code:');
  e.qr('https://mumbai-erp.example/receipt-test', { size: 6 });
  e.feed(1).line('Barcode:');
  e.barcode('MUMBAI-ERP-TEST-123', { height: 56, hri: true });
  e.feed(1).line('If all sections printed, the');
  e.line('printer is configured correctly.');
  e.feed(4).cut();
  return e.encode();
}

/** Standalone cash-drawer kick for a manual "no-sale" open — no receipt involved. */
export function openDrawerBytes(): Uint8Array {
  return new EscPosEncoder().drawer().encode();
}
