import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import type { Prisma } from '@prisma/client';
import { istDayString } from '../../shared/utils/date';
import { getCompanyProfile } from '../settings/settings.service';

export type BillWithRelations = Prisma.BillGetPayload<{
  include: { items: true; charges: true; outlet: true };
}>;

/**
 * Resolve a file under apps/api/assets. The API's working directory differs between
 * dev (`npm run dev -w @mumbai-erp/api` → apps/api) and production (PM2 starts dist/server.js
 * from the repo root), so a single cwd-relative path silently misses in one of them —
 * which is why the letterhead logo never appeared on production invoices.
 */
function assetPath(relative: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'assets', relative),
    path.resolve(process.cwd(), 'apps/api/assets', relative),
    path.resolve(__dirname, '../../../assets', relative),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

const LOGO_PATH = assetPath('logo.png');

// Product and outlet names are written in Gujarati, and the PDF standard fonts
// (Helvetica et al.) are Latin-only — "ચટપટી (C.P.)" printed as "©ªŸªªŸ¬„0.P.)".
// Noto Sans Gujarati covers Latin as well, so it is used for the whole document
// rather than swapped in per string: one font means no field can be missed, and a
// mixed name like "લિક્વિડ રસો (khaman rasho)" renders without changing typeface
// mid-line. Falls back to Helvetica if the files are ever absent.
const FONT_REGULAR = assetPath('fonts/NotoSansGujarati-Regular.ttf');
const FONT_BOLD = assetPath('fonts/NotoSansGujarati-Bold.ttf');

const COLOR = {
  brand: '#3730A3',
  brandLight: '#EEF2FF',
  text: '#111827',
  muted: '#6B7280',
  faint: '#9CA3AF',
  line: '#E5E7EB',
  success: '#16A34A',
  danger: '#DC2626',
  headerBg: '#F3F4F6',
};

const PAGE = { left: 50, right: 545, width: 495 };

const INR = (v: Prisma.Decimal | number): string =>
  `Rs ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Render a bill to PDF, piped into `dest` (a file write stream or an HTTP response —
 * anything writable). Resolves once `dest` has finished flushing.
 */
export async function renderBillPdf(bill: BillWithRelations, dest: NodeJS.WritableStream): Promise<void> {
  // Seller identity (name, GSTIN, address, invoice terms) is maintained by the
  // main owner in Settings → Business Profile; env values are only the fallback.
  const company = await getCompanyProfile();
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const FONT = { regular: 'Helvetica', bold: 'Helvetica-Bold' };
    if (FONT_REGULAR) { doc.registerFont('Body', FONT_REGULAR); FONT.regular = 'Body'; }
    if (FONT_BOLD) { doc.registerFont('Body-Bold', FONT_BOLD); FONT.bold = 'Body-Bold'; }
    doc.font(FONT.regular);
    doc.pipe(dest);
    dest.on('finish', () => resolve());
    dest.on('error', reject);
    doc.on('error', reject);

    // ── Letterhead ──────────────────────────────────────────────────────────
    const headerTop = 50;
    if (LOGO_PATH) {
      doc.image(LOGO_PATH, PAGE.left, headerTop, { width: 70 });
    }
    const textX = LOGO_PATH ? PAGE.left + 82 : PAGE.left;
    const sellerName = company.legalName || company.displayName;
    doc.fontSize(18).fillColor(COLOR.text).text(sellerName, textX, headerTop, { width: 260 });
    if (company.tagline) doc.fontSize(9).fillColor(COLOR.muted).text(company.tagline, textX, doc.y + 1, { width: 260 });
    const addrLines = [company.address, company.phone ? `Ph: ${company.phone}` : ''].filter(Boolean);
    if (addrLines.length) doc.fontSize(8).fillColor(COLOR.faint).text(addrLines.join('  ·  '), textX, doc.y + 2, { width: 260 });
    if (bill.isGstBill && company.gstin) doc.fontSize(8).fillColor(COLOR.faint).text(`GSTIN: ${company.gstin}`, textX, doc.y + 1, { width: 260 });

    doc.fontSize(16).fillColor(COLOR.brand).text(bill.isGstBill ? 'TAX INVOICE' : 'INVOICE', PAGE.left, headerTop, { align: 'right', width: PAGE.width });
    doc.fontSize(10).fillColor(COLOR.text).text(bill.billNumber, PAGE.left, doc.y + 2, { align: 'right', width: PAGE.width });
    doc
      .fontSize(8.5)
      .fillColor(COLOR.muted)
      .text(`Date: ${istDayString(bill.billDate)}`, PAGE.left, doc.y + 3, { align: 'right', width: PAGE.width })
      .text(`Due:  ${istDayString(bill.dueDate)}`, PAGE.left, doc.y + 1, { align: 'right', width: PAGE.width });
    if (!bill.isGstBill) {
      doc.fontSize(8).fillColor(COLOR.faint).text('No GST charged on this invoice', PAGE.left, doc.y + 3, { align: 'right', width: PAGE.width });
    }

    let y = Math.max(doc.y, headerTop + 70) + 14;
    doc.moveTo(PAGE.left, y).lineTo(PAGE.right, y).lineWidth(1.5).strokeColor(COLOR.brand).stroke();
    y += 16;

    // ── Billed To ───────────────────────────────────────────────────────────
    doc.fontSize(8.5).fillColor(COLOR.muted).text('BILLED TO', PAGE.left, y);
    y = doc.y + 2;
    doc.fontSize(11).fillColor(COLOR.text).text(bill.outlet.legalName || bill.outlet.name, PAGE.left, y);
    y = doc.y;
    doc.fontSize(9).fillColor(COLOR.muted);
    if (bill.outlet.address) { doc.text(bill.outlet.address, PAGE.left, y + 2, { width: 300 }); y = doc.y; }
    if (bill.outlet.phone) { doc.text(bill.outlet.phone, PAGE.left, y + 2); y = doc.y; }
    // The buyer's GSTIN is what lets the outlet claim input credit — a GST invoice
    // without it is of little use to them.
    if (bill.isGstBill && bill.outlet.gstin) {
      doc.fillColor(COLOR.text).text(`GSTIN: ${bill.outlet.gstin}`, PAGE.left, y + 2);
      y = doc.y;
    }
    y += 18;

    // ── Item table ──────────────────────────────────────────────────────────
    const showTax = bill.isGstBill;
    const cols = showTax
      ? { item: PAGE.left, qty: 275, rate: 330, tax: 400, total: 470 }
      : { item: PAGE.left, qty: 320, rate: 395, tax: 0, total: 470 };

    const tableHeaderY = y;
    doc.rect(PAGE.left, tableHeaderY, PAGE.width, 20).fill(COLOR.headerBg);
    doc.fontSize(8.5).fillColor(COLOR.muted);
    doc.text('ITEM', cols.item + 6, tableHeaderY + 6);
    doc.text('QTY', cols.qty, tableHeaderY + 6, { width: 45, align: 'right' });
    doc.text('RATE', cols.rate, tableHeaderY + 6, { width: 60, align: 'right' });
    if (showTax) doc.text('TAX', cols.tax, tableHeaderY + 6, { width: 60, align: 'right' });
    doc.text('TOTAL', cols.total, tableHeaderY + 6, { width: 75, align: 'right' });
    y = tableHeaderY + 20;

    doc.fontSize(9.5);
    let rowIndex = 0;
    for (const item of bill.items) {
      const rowH = 22;
      if (y + rowH > 740) {
        doc.addPage();
        y = 50;
      }
      if (rowIndex % 2 === 1) doc.rect(PAGE.left, y, PAGE.width, rowH).fill('#FAFAFA');
      doc.fillColor(COLOR.text).font(FONT.regular).fontSize(9.5);
      doc.text(item.productNameSnapshot, cols.item + 6, y + 6, { width: showTax ? 215 : 260 });
      doc.fillColor(COLOR.muted);
      doc.text(String(Number(item.quantity)), cols.qty, y + 6, { width: 45, align: 'right' });
      doc.text(INR(item.rate), cols.rate, y + 6, { width: 60, align: 'right' });
      if (showTax) doc.text(`${Number(item.taxPercent)}%`, cols.tax, y + 6, { width: 60, align: 'right' });
      doc.fillColor(COLOR.text).text(INR(item.lineTotal), cols.total, y + 6, { width: 75, align: 'right' });
      y += rowH;
      rowIndex += 1;
    }
    doc.moveTo(PAGE.left, y).lineTo(PAGE.right, y).strokeColor(COLOR.line).stroke();
    y += 14;

    // ── Totals ──────────────────────────────────────────────────────────────
    const labelX = 360;
    const valX = 470;
    const valW = 75;
    doc.fontSize(9.5).fillColor(COLOR.muted);
    doc.text('Sub-total', labelX, y, { width: 100 }).text(INR(bill.subTotal), valX, y, { width: valW, align: 'right' });
    y += 15;
    if (showTax) {
      doc.text('GST', labelX, y, { width: 100 }).text(INR(bill.taxTotal), valX, y, { width: valW, align: 'right' });
      y += 15;
    }
    // Packing/transport/etc, itemised by label — added by the main owner when the
    // bill was raised. Not taxed, so these sit outside the GST line above.
    for (const charge of bill.charges) {
      doc.text(charge.label, labelX, y, { width: 100 }).text(INR(charge.amount), valX, y, { width: valW, align: 'right' });
      y += 15;
    }
    doc.moveTo(labelX, y + 2).lineTo(PAGE.right, y + 2).strokeColor(COLOR.line).stroke();
    y += 8;
    doc.fontSize(12.5).fillColor(COLOR.text).font(FONT.bold);
    doc.text('Grand Total', labelX, y, { width: 100 }).text(INR(bill.grandTotal), valX, y, { width: valW, align: 'right' });
    doc.font(FONT.regular);
    y += 22;

    const balance = Number(bill.balanceDue);
    doc.fontSize(9.5).fillColor(COLOR.success);
    doc.text('Paid', labelX, y, { width: 100 }).text(INR(bill.amountPaid), valX, y, { width: valW, align: 'right' });
    y += 15;
    if (balance > 0) {
      doc.fillColor(COLOR.danger).font(FONT.bold);
      doc.text('Balance Due', labelX, y, { width: 100 }).text(INR(bill.balanceDue), valX, y, { width: valW, align: 'right' });
      doc.font(FONT.regular);
    } else {
      doc.fillColor(COLOR.success).font(FONT.bold);
      doc.roundedRect(labelX, y - 2, 185, 18, 3).fillAndStroke(COLOR.brandLight, COLOR.brandLight);
      doc.fillColor(COLOR.success).text('PAID IN FULL', labelX, y + 2, { width: 185, align: 'center' });
      doc.font(FONT.regular);
    }

    // ── Terms & Conditions ─────────────────────────────────────────────────
    const terms = company.invoiceTerms.split('|').map((t) => t.trim()).filter(Boolean);
    if (terms.length) {
      const footerReserve = 40; // leave room for the disclaimer footer below
      y += 18;
      doc.fontSize(8.5).fillColor(COLOR.muted).text('TERMS & CONDITIONS', PAGE.left, y, { width: PAGE.width });
      y = doc.y + 4;
      doc.fontSize(8).fillColor(COLOR.muted);
      for (let i = 0; i < terms.length; i++) {
        const lineText = `${i + 1}. ${terms[i]}`;
        const h = doc.heightOfString(lineText, { width: PAGE.width });
        if (y + h > 740 - footerReserve) { doc.addPage(); y = 50; }
        doc.text(lineText, PAGE.left, y, { width: PAGE.width });
        y = doc.y + 2;
      }
    }

    // ── Footer ──────────────────────────────────────────────────────────────
    doc.moveTo(PAGE.left, 760).lineTo(PAGE.right, 760).strokeColor(COLOR.line).stroke();
    doc
      .fontSize(8)
      .fillColor(COLOR.faint)
      .text('This is a computer-generated invoice.', PAGE.left, 768, { align: 'center', width: PAGE.width });
    if (company.phone || company.gstin) {
      const bits = [company.phone && `Ph: ${company.phone}`, company.gstin && `GSTIN: ${company.gstin}`].filter(Boolean);
      doc.text(bits.join('   ·   '), PAGE.left, 780, { align: 'center', width: PAGE.width });
    }

    doc.end();
  });
}
