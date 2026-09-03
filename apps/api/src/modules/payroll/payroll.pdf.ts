import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import type { Prisma } from '@prisma/client';
import { getCompanyProfile } from '../settings/settings.service';

const LOGO_PATH = path.resolve(process.cwd(), 'assets/logo.png');

const COLOR = {
  brand: '#3730A3',
  brandLight: '#EEF2FF',
  text: '#111827',
  muted: '#6B7280',
  line: '#E5E7EB',
  success: '#16A34A',
  danger: '#DC2626',
  headerBg: '#F3F4F6',
};

const PAGE = { left: 50, right: 545, width: 495 };

// The built-in Helvetica has no rupee glyph, same as the bill PDF.
const INR = (v: Prisma.Decimal | number): string =>
  `Rs ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface PayslipData {
  payrollNo: string;
  year: number;
  month: number;
  salaryType: string;
  totalWorkingDays: Prisma.Decimal | number;
  presentDays: Prisma.Decimal | number;
  halfDays: Prisma.Decimal | number;
  paidLeave: Prisma.Decimal | number;
  unpaidLeave: Prisma.Decimal | number;
  overtimeHours: Prisma.Decimal | number;
  payableDays: Prisma.Decimal | number;
  grossSalary: Prisma.Decimal | number;
  allowances: Prisma.Decimal | number;
  overtimeAmount: Prisma.Decimal | number;
  bonus: Prisma.Decimal | number;
  incentives: Prisma.Decimal | number;
  deductions: Prisma.Decimal | number;
  advanceRecovery: Prisma.Decimal | number;
  loanRecovery: Prisma.Decimal | number;
  netSalary: Prisma.Decimal | number;
  status: string;
  paymentDate: Date | null;
  employee: {
    employeeNo: string;
    employeeCode: string | null;
    name: string;
    department: string | null;
    mobile: string | null;
    employmentType: string;
    joiningDate: Date;
    shift: { name: string } | null;
  };
}

const titleCase = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Render a salary slip, piped into `dest` (an HTTP response or a file stream).
 * Mirrors renderBillPdf's shape so both documents look like the same business.
 */
export async function renderPayslipPdf(slip: PayslipData, dest: NodeJS.WritableStream): Promise<void> {
  const company = await getCompanyProfile();
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(dest);
    dest.on('finish', () => resolve());
    dest.on('error', reject);
    doc.on('error', reject);

    const hasLogo = fs.existsSync(LOGO_PATH);

    // ── Letterhead ──────────────────────────────────────────────────────────
    const headerTop = 50;
    if (hasLogo) doc.image(LOGO_PATH, PAGE.left, headerTop, { width: 70 });
    const textX = hasLogo ? PAGE.left + 82 : PAGE.left;
    doc.font('Helvetica-Bold').fontSize(18).fillColor(COLOR.text).text(company.legalName || company.displayName, textX, headerTop, { width: 280 });
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted);
    let hy = doc.y;
    if (company.tagline) { doc.text(company.tagline, textX, hy, { width: 280 }); hy = doc.y; }
    if (company.address) { doc.text(company.address, textX, hy, { width: 280 }); hy = doc.y; }
    if (company.phone) { doc.text(`Phone: ${company.phone}`, textX, hy, { width: 280 }); hy = doc.y; }

    doc.font('Helvetica-Bold').fontSize(15).fillColor(COLOR.brand)
      .text('SALARY SLIP', PAGE.right - 200, headerTop, { width: 200, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted)
      .text(slip.payrollNo, PAGE.right - 200, headerTop + 20, { width: 200, align: 'right' })
      .text(`${MONTH_NAMES[slip.month - 1]} ${slip.year}`, PAGE.right - 200, headerTop + 33, { width: 200, align: 'right' });

    let y = Math.max(hy, headerTop + 52) + 12;
    doc.moveTo(PAGE.left, y).lineTo(PAGE.right, y).strokeColor(COLOR.line).lineWidth(1).stroke();
    y += 16;

    // ── Employee details ────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.text).text('EMPLOYEE DETAILS', PAGE.left, y);
    y += 16;

    const pairs: Array<[string, string]> = [
      ['Employee ID', slip.employee.employeeNo],
      ['Name', slip.employee.name],
      ['Department', slip.employee.department ?? '-'],
      ['Employment Type', titleCase(slip.employee.employmentType)],
      ['Joining Date', slip.employee.joiningDate.toLocaleDateString('en-IN')],
      ['Shift', slip.employee.shift?.name ?? '-'],
    ];
    if (slip.employee.employeeCode) pairs.splice(1, 0, ['Employee Code', slip.employee.employeeCode]);
    if (slip.employee.mobile) pairs.push(['Mobile', slip.employee.mobile]);

    const colW = PAGE.width / 2;
    doc.fontSize(9);
    pairs.forEach(([label, value], i) => {
      const col = i % 2;
      const rowY = y + Math.floor(i / 2) * 15;
      const x = PAGE.left + col * colW;
      doc.font('Helvetica').fillColor(COLOR.muted).text(`${label}:`, x, rowY, { width: 95 });
      doc.font('Helvetica-Bold').fillColor(COLOR.text).text(value, x + 98, rowY, { width: colW - 105 });
    });
    y += Math.ceil(pairs.length / 2) * 15 + 14;

    // ── Attendance summary ──────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.text).text('ATTENDANCE SUMMARY', PAGE.left, y);
    y += 16;

    const att: Array<[string, string]> = [
      ['Working Days', String(Number(slip.totalWorkingDays))],
      ['Present', String(Number(slip.presentDays))],
      ['Half Days', String(Number(slip.halfDays))],
      ['Paid Leave', String(Number(slip.paidLeave))],
      ['Unpaid Leave', String(Number(slip.unpaidLeave))],
      ['Overtime (hrs)', String(Number(slip.overtimeHours))],
    ];
    const attColW = PAGE.width / 6;
    doc.rect(PAGE.left, y, PAGE.width, 34).fill(COLOR.brandLight);
    att.forEach(([label, value], i) => {
      const x = PAGE.left + i * attColW;
      doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted).text(label.toUpperCase(), x + 4, y + 6, { width: attColW - 8, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.text).text(value, x + 4, y + 17, { width: attColW - 8, align: 'center' });
    });
    y += 34;
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted)
      .text(`Payable days: ${Number(slip.payableDays)}  ·  Salary basis: ${titleCase(slip.salaryType)}`, PAGE.left, y + 5);
    y += 24;

    // ── Earnings vs deductions, side by side ────────────────────────────────
    const earnings: Array<[string, Prisma.Decimal | number]> = [
      ['Gross Salary', slip.grossSalary],
      ['Allowances', slip.allowances],
      ['Overtime', slip.overtimeAmount],
      ['Bonus', slip.bonus],
      ['Incentives', slip.incentives],
    ];
    const deductions: Array<[string, Prisma.Decimal | number]> = [
      ['Deductions', slip.deductions],
      ['Advance Recovery', slip.advanceRecovery],
      ['Loan Recovery', slip.loanRecovery],
    ];

    const half = PAGE.width / 2 - 6;
    const boxTop = y;
    const rows = Math.max(earnings.length, deductions.length);
    const boxH = 22 + rows * 16 + 22;

    const renderColumn = (x: number, heading: string, items: Array<[string, Prisma.Decimal | number]>, totalLabel: string, tone: string) => {
      doc.rect(x, boxTop, half, boxH).strokeColor(COLOR.line).lineWidth(1).stroke();
      doc.rect(x, boxTop, half, 22).fill(COLOR.headerBg);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.text).text(heading, x + 8, boxTop + 7, { width: half - 16 });
      let ry = boxTop + 26;
      let total = 0;
      for (const [label, value] of items) {
        total += Number(value);
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted).text(label, x + 8, ry, { width: half - 100 });
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.text).text(INR(value), x + half - 96, ry, { width: 88, align: 'right' });
        ry += 16;
      }
      const totalY = boxTop + boxH - 18;
      doc.moveTo(x + 8, totalY - 5).lineTo(x + half - 8, totalY - 5).strokeColor(COLOR.line).stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(tone).text(totalLabel, x + 8, totalY, { width: half - 100 });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(tone).text(INR(total), x + half - 96, totalY, { width: 88, align: 'right' });
      return total;
    };

    const totalEarnings = renderColumn(PAGE.left, 'EARNINGS', earnings, 'Total Earnings', COLOR.success);
    const totalDeductions = renderColumn(PAGE.left + half + 12, 'DEDUCTIONS', deductions, 'Total Deductions', COLOR.danger);
    y = boxTop + boxH + 16;

    // ── Net pay ─────────────────────────────────────────────────────────────
    doc.rect(PAGE.left, y, PAGE.width, 42).fill(COLOR.brand);
    doc.font('Helvetica').fontSize(9).fillColor('#FFFFFF').text('NET SALARY PAYABLE', PAGE.left + 14, y + 9);
    doc.font('Helvetica').fontSize(7.5).fillColor('#C7D2FE')
      .text(`Earnings ${INR(totalEarnings)}  -  Deductions ${INR(totalDeductions)}`, PAGE.left + 14, y + 24);
    doc.font('Helvetica-Bold').fontSize(19).fillColor('#FFFFFF')
      .text(INR(slip.netSalary), PAGE.right - 214, y + 11, { width: 200, align: 'right' });
    y += 56;

    // ── Payment status ──────────────────────────────────────────────────────
    const isPaid = slip.status === 'PAID';
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted).text('Payment status:', PAGE.left, y);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(isPaid ? COLOR.success : COLOR.danger)
      .text(isPaid ? 'PAID' : 'PENDING', PAGE.left + 82, y);
    if (slip.paymentDate) {
      doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted)
        .text(`Paid on ${slip.paymentDate.toLocaleDateString('en-IN')}`, PAGE.left + 140, y);
    }
    y += 46;

    // ── Signatures ──────────────────────────────────────────────────────────
    doc.moveTo(PAGE.left, y).lineTo(PAGE.left + 150, y).strokeColor(COLOR.line).stroke();
    doc.moveTo(PAGE.right - 150, y).lineTo(PAGE.right, y).strokeColor(COLOR.line).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted)
      .text('Employee Signature', PAGE.left, y + 5, { width: 150, align: 'center' })
      .text('Authorised Signatory', PAGE.right - 150, y + 5, { width: 150, align: 'center' });

    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted)
      .text('This is a computer-generated salary slip.', PAGE.left, 780, { width: PAGE.width, align: 'center' });

    doc.end();
  });
}
