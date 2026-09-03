import { Prisma, PayrollStatus, ExpenseLocation, PaymentMethod } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { cache, CacheTag } from '../../config/cache';
import { AppError } from '../../shared/utils/AppError';
import { nextDocNumber } from '../../shared/utils/docNumber';
import { enqueueTallySync, markTallyDeleted } from '../tally/tally.outbox';
import { computePayroll, payableDaysFor } from './payroll.calc';
import { applyAdvanceRecoveryTx, outstandingAdvanceBalance, reverseAdvanceRecoveryTx } from './advances.service';
import type {
  GeneratePayrollInput, ListAttendanceQuery, ListPayrollQuery, MarkPaidInput,
  PeriodQuery, SaveAttendanceInput, UpdatePayrollInput,
} from './payroll.schema';

/** Every salary payout books against this one category, so the P&L has a single line for wages. */
const SALARY_CATEGORY = 'Salary & Wages';

function invalidate(): void {
  cache.invalidateTags(CacheTag.PAYROLL, CacheTag.EXPENSES, CacheTag.ANALYTICS, CacheTag.DASHBOARD);
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const periodLabel = (year: number, month: number) => `${MONTH_NAMES[month - 1]} ${year}`;

// ───────────────────────────── Attendance ───────────────────────────────────
const attendanceSelect = {
  id: true, employeeId: true, year: true, month: true,
  totalWorkingDays: true, presentDays: true, absentDays: true, halfDays: true,
  paidLeave: true, unpaidLeave: true, overtimeHours: true, workingHours: true, notes: true,
  employee: { select: { id: true, employeeNo: true, name: true, department: true, salaryType: true } },
} satisfies Prisma.AttendanceSelect;

export async function listAttendance(query: ListAttendanceQuery) {
  const rows = await prisma.attendance.findMany({
    where: {
      isDeleted: false,
      year: query.year,
      month: query.month,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    },
    select: attendanceSelect,
    orderBy: { employee: { name: 'asc' } },
  });
  // Payable days are derived, never stored on attendance — one definition, in the
  // calculator, so the figure shown here can't drift from the one payroll uses.
  return rows.map((r) => ({ ...r, payableDays: Number(payableDaysFor(r)) }));
}

/** Upsert one employee's attendance for a month. */
export async function saveAttendance(input: SaveAttendanceInput, createdById: string) {
  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, isDeleted: false },
    select: { id: true },
  });
  if (!employee) throw AppError.notFound('Employee not found');

  const counted = input.presentDays + input.absentDays + input.halfDays + input.paidLeave + input.unpaidLeave;
  if (counted > input.totalWorkingDays) {
    throw AppError.badRequest(
      `Days entered (${counted}) exceed the ${input.totalWorkingDays} working days in this month`,
      undefined,
      'presentDays',
    );
  }

  const { employeeId, year, month, ...rest } = input;
  const row = await prisma.attendance.upsert({
    where: { employeeId_year_month: { employeeId, year, month } },
    create: { employeeId, year, month, ...rest, createdById },
    update: { ...rest },
    select: attendanceSelect,
  });
  invalidate();
  return { ...row, payableDays: Number(payableDaysFor(row)) };
}

export async function deleteAttendance(id: string) {
  const existing = await prisma.attendance.findFirst({ where: { id, isDeleted: false }, select: { id: true } });
  if (!existing) throw AppError.notFound('Attendance record not found');
  await prisma.attendance.delete({ where: { id } });
  invalidate();
  return { deleted: true };
}

// ────────────────────────────── Payroll ─────────────────────────────────────
const payrollSelect = {
  id: true, payrollNo: true, employeeId: true, year: true, month: true,
  salaryType: true, monthlySalary: true, perDaySalary: true, perHourSalary: true, shiftSalary: true,
  overtimeRate: true,
  totalWorkingDays: true, presentDays: true, halfDays: true, paidLeave: true, unpaidLeave: true,
  overtimeHours: true, workingHours: true, payableDays: true,
  grossSalary: true, allowances: true, overtimeAmount: true, bonus: true, incentives: true,
  deductions: true, advanceRecovery: true, loanRecovery: true, netSalary: true,
  status: true, paymentDate: true, expenseId: true, notes: true,
  employee: {
    select: {
      id: true, employeeNo: true, employeeCode: true, name: true, department: true,
      mobile: true, employmentType: true,
      shift: { select: { name: true } },
    },
  },
} satisfies Prisma.PayrollSelect;

export async function listPayroll(query: ListPayrollQuery) {
  const rows = await prisma.payroll.findMany({
    where: {
      isDeleted: false,
      year: query.year,
      month: query.month,
      ...(query.status ? { status: query.status } : {}),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    },
    select: payrollSelect,
    orderBy: { employee: { name: 'asc' } },
  });
  const totals = rows.reduce(
    (acc, r) => ({
      gross: acc.gross + Number(r.grossSalary),
      net: acc.net + Number(r.netSalary),
      paid: acc.paid + (r.status === PayrollStatus.PAID ? Number(r.netSalary) : 0),
      pending: acc.pending + (r.status === PayrollStatus.PENDING ? Number(r.netSalary) : 0),
    }),
    { gross: 0, net: 0, paid: 0, pending: 0 },
  );
  return { rows, totals };
}

/**
 * Build (or rebuild) payroll for a month from each employee's salary structure and
 * their recorded attendance.
 *
 * Rows already marked PAID are left alone — the money is out and the payslip issued,
 * so a re-run must not quietly restate it. Pending rows are recomputed in place,
 * which is what makes this safe to run again after fixing an attendance mistake.
 */
export async function generatePayroll(input: GeneratePayrollInput, createdById: string) {
  const employees = await prisma.employee.findMany({
    where: {
      isDeleted: false,
      status: 'ACTIVE',
      ...(input.employeeIds?.length ? { id: { in: input.employeeIds } } : {}),
    },
    select: {
      id: true, name: true, salaryType: true,
      monthlySalary: true, perDaySalary: true, perHourSalary: true, shiftSalary: true,
      allowances: true, deductions: true, overtimeRate: true,
    },
  });
  if (employees.length === 0) throw AppError.badRequest('No active employees to generate payroll for');

  const attendance = await prisma.attendance.findMany({
    where: { isDeleted: false, year: input.year, month: input.month, employeeId: { in: employees.map((e) => e.id) } },
  });
  const attendanceBy = new Map(attendance.map((a) => [a.employeeId, a]));

  const existing = await prisma.payroll.findMany({
    where: { isDeleted: false, year: input.year, month: input.month, employeeId: { in: employees.map((e) => e.id) } },
    select: { id: true, employeeId: true, status: true, bonus: true, incentives: true, advanceRecovery: true, loanRecovery: true },
  });
  const existingBy = new Map(existing.map((p) => [p.employeeId, p]));

  const created: string[] = [];
  const updated: string[] = [];
  const skippedPaid: string[] = [];
  const skippedNoAttendance: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const emp of employees) {
      const att = attendanceBy.get(emp.id);
      if (!att) { skippedNoAttendance.push(emp.name); continue; }

      const prior = existingBy.get(emp.id);
      if (prior?.status === PayrollStatus.PAID) { skippedPaid.push(emp.name); continue; }

      // A brand-new row starts with the employee's whole outstanding advance balance
      // pre-filled as this month's recovery — the admin can still adjust it down (or
      // up) before paying. A re-run of an existing PENDING row leaves it exactly as
      // last saved, so re-generating after an attendance fix can't silently overwrite
      // a deliberate manual edit.
      const advanceOwed = prior ? null : await outstandingAdvanceBalance(emp.id, tx);

      // Manual adjustments already keyed against a pending row survive a re-run.
      const computed = computePayroll(emp, att, {
        bonus: prior ? Number(prior.bonus) : 0,
        incentives: prior ? Number(prior.incentives) : 0,
        advanceRecovery: prior ? Number(prior.advanceRecovery) : Number(advanceOwed),
        loanRecovery: prior ? Number(prior.loanRecovery) : 0,
      });

      const snapshot = {
        salaryType: emp.salaryType,
        monthlySalary: emp.monthlySalary,
        perDaySalary: emp.perDaySalary,
        perHourSalary: emp.perHourSalary,
        shiftSalary: emp.shiftSalary,
        overtimeRate: emp.overtimeRate ?? new Prisma.Decimal(0),
        totalWorkingDays: att.totalWorkingDays,
        presentDays: att.presentDays,
        halfDays: att.halfDays,
        paidLeave: att.paidLeave,
        unpaidLeave: att.unpaidLeave,
        overtimeHours: att.overtimeHours,
        workingHours: att.workingHours ?? new Prisma.Decimal(0),
        ...computed,
      };

      if (prior) {
        await tx.payroll.update({ where: { id: prior.id }, data: snapshot });
        updated.push(emp.name);
      } else {
        const payrollNo = await nextDocNumber(tx, 'PAYROLL');
        await tx.payroll.create({
          data: { payrollNo, employeeId: emp.id, year: input.year, month: input.month, createdById, ...snapshot },
        });
        created.push(emp.name);
      }
    }
  });

  invalidate();
  return {
    period: periodLabel(input.year, input.month),
    created: created.length,
    updated: updated.length,
    skippedPaid: skippedPaid.length,
    skippedNoAttendance,
  };
}

export async function updatePayroll(id: string, input: UpdatePayrollInput) {
  const row = await prisma.payroll.findFirst({
    where: { id, isDeleted: false },
    select: {
      id: true, status: true, salaryType: true,
      monthlySalary: true, perDaySalary: true, perHourSalary: true, shiftSalary: true, overtimeRate: true,
      totalWorkingDays: true, presentDays: true, halfDays: true, paidLeave: true, unpaidLeave: true,
      overtimeHours: true, workingHours: true,
      allowances: true, deductions: true, bonus: true, incentives: true, advanceRecovery: true, loanRecovery: true,
    },
  });
  if (!row) throw AppError.notFound('Payroll record not found');
  if (row.status === PayrollStatus.PAID) {
    throw AppError.invalidState('This salary has already been paid and can no longer be edited');
  }

  const computed = computePayroll(
    {
      salaryType: row.salaryType,
      monthlySalary: row.monthlySalary,
      perDaySalary: row.perDaySalary,
      perHourSalary: row.perHourSalary,
      shiftSalary: row.shiftSalary,
      allowances: row.allowances,
      deductions: row.deductions,
      overtimeRate: row.overtimeRate,
    },
    row,
    {
      bonus: input.bonus ?? Number(row.bonus),
      incentives: input.incentives ?? Number(row.incentives),
      advanceRecovery: input.advanceRecovery ?? Number(row.advanceRecovery),
      loanRecovery: input.loanRecovery ?? Number(row.loanRecovery),
      allowances: input.allowances ?? Number(row.allowances),
      deductions: input.deductions ?? Number(row.deductions),
    },
  );

  const saved = await prisma.payroll.update({
    where: { id },
    data: { ...computed, ...(input.notes !== undefined ? { notes: input.notes } : {}) },
    select: payrollSelect,
  });
  invalidate();
  return saved;
}

/** The category every salary payout books to, created on first use. */
async function salaryCategoryId(tx: Prisma.TransactionClient): Promise<string> {
  const existing = await tx.expenseCategory.findFirst({ where: { name: SALARY_CATEGORY }, select: { id: true } });
  if (existing) return existing.id;
  const created = await tx.expenseCategory.create({
    data: { name: SALARY_CATEGORY, isSystem: true },
    select: { id: true },
  });
  return created.id;
}

/**
 * Mark a salary paid and book the expense.
 *
 * The Expense is created here rather than at generation because that is when the
 * money actually leaves — a pending payroll row shouldn't depress this month's profit.
 * Anything written into `expenses` flows into the P&L view automatically.
 */
export async function markPayrollPaid(id: string, input: MarkPaidInput, userId: string) {
  const row = await prisma.payroll.findFirst({
    where: { id, isDeleted: false },
    select: { id: true, status: true, netSalary: true, advanceRecovery: true, year: true, month: true, employeeId: true, employee: { select: { name: true, employeeNo: true } } },
  });
  if (!row) throw AppError.notFound('Payroll record not found');
  if (row.status === PayrollStatus.PAID) throw AppError.invalidState('This salary is already marked paid');

  const saved = await prisma.$transaction(async (tx) => {
    const categoryId = await salaryCategoryId(tx);
    const expense = await tx.expense.create({
      data: {
        categoryId,
        amount: row.netSalary,
        expenseDate: input.paymentDate,
        paymentMethod: PaymentMethod.CASH,
        location: ExpenseLocation.GENERAL,
        paidTo: row.employee.name,
        note: `Salary ${periodLabel(row.year, row.month)} — ${row.employee.name} (${row.employee.employeeNo})`,
        createdById: userId,
      },
      select: { id: true },
    });
    // Payment voucher — Dr Salaries, Cr Cash/Bank.
    await enqueueTallySync(tx, {
      entityType: 'EXPENSE', entityId: expense.id, voucherType: 'PAYMENT',
      entityDate: input.paymentDate, amount: row.netSalary,
      docNumber: null, partyName: row.employee.name,
    });
    // Only now — the money is actually leaving — does the deduction shown on this
    // payslip actually reduce what the employee still owes.
    await applyAdvanceRecoveryTx(tx, row.employeeId, id, new Prisma.Decimal(row.advanceRecovery));
    return tx.payroll.update({
      where: { id },
      data: { status: PayrollStatus.PAID, paymentDate: input.paymentDate, expenseId: expense.id },
      select: payrollSelect,
    });
  });

  invalidate();
  return saved;
}

/** Undo a payment: removes the booked expense so the P&L doesn't keep counting it. */
export async function revertPayrollPayment(id: string) {
  const row = await prisma.payroll.findFirst({
    where: { id, isDeleted: false },
    select: { id: true, status: true, expenseId: true },
  });
  if (!row) throw AppError.notFound('Payroll record not found');
  if (row.status !== PayrollStatus.PAID) throw AppError.invalidState('This salary is not marked paid');

  const saved = await prisma.$transaction(async (tx) => {
    // Undo the advance recovery first — the employee still owes whatever this
    // payroll had claimed to recover, now that the payment itself is undone.
    await reverseAdvanceRecoveryTx(tx, id);
    const updated = await tx.payroll.update({
      where: { id },
      data: { status: PayrollStatus.PENDING, paymentDate: null, expenseId: null },
      select: payrollSelect,
    });
    if (row.expenseId) {
      await markTallyDeleted(tx, 'EXPENSE', row.expenseId);
      await tx.expense.delete({ where: { id: row.expenseId } });
    }
    return updated;
  });

  invalidate();
  return saved;
}

export async function getPayslip(id: string) {
  const row = await prisma.payroll.findFirst({
    where: { id, isDeleted: false },
    select: {
      ...payrollSelect,
      employee: {
        select: {
          id: true, employeeNo: true, employeeCode: true, name: true, department: true,
          mobile: true, email: true, employmentType: true, joiningDate: true,
          shift: { select: { name: true, startTime: true, endTime: true } },
        },
      },
    },
  });
  if (!row) throw AppError.notFound('Payroll record not found');
  return row;
}

// ─────────────────────── Dashboard + reports (stage 3) ──────────────────────
export async function getPayrollDashboard(query: PeriodQuery) {
  const [total, active, byStatus, byDepartment, attendanceAgg, salaryPaidAgg] = await Promise.all([
    prisma.employee.count({ where: { isDeleted: false } }),
    prisma.employee.count({ where: { isDeleted: false, status: 'ACTIVE' } }),
    prisma.payroll.groupBy({
      by: ['status'],
      where: { isDeleted: false, year: query.year, month: query.month },
      _count: { _all: true },
      _sum: { netSalary: true },
    }),
    prisma.employee.groupBy({
      by: ['department'],
      where: { isDeleted: false, status: 'ACTIVE' },
      _count: { _all: true },
    }),
    prisma.attendance.aggregate({
      where: { isDeleted: false, year: query.year, month: query.month },
      _sum: { presentDays: true, absentDays: true, halfDays: true, paidLeave: true, unpaidLeave: true, overtimeHours: true },
      _count: { _all: true },
    }),
    prisma.payroll.aggregate({
      where: { isDeleted: false, year: query.year, month: query.month, status: PayrollStatus.PAID },
      _sum: { netSalary: true },
    }),
  ]);

  const statusRow = (s: PayrollStatus) => byStatus.find((b) => b.status === s);
  const paid = statusRow(PayrollStatus.PAID);
  const pending = statusRow(PayrollStatus.PENDING);

  return {
    period: periodLabel(query.year, query.month),
    totalEmployees: total,
    activeEmployees: active,
    payrollProcessed: paid?._count._all ?? 0,
    payrollPending: pending?._count._all ?? 0,
    totalSalaryExpense: Number(salaryPaidAgg._sum.netSalary ?? 0),
    pendingSalaryAmount: Number(pending?._sum.netSalary ?? 0),
    attendance: {
      employeesRecorded: attendanceAgg._count._all,
      presentDays: Number(attendanceAgg._sum.presentDays ?? 0),
      absentDays: Number(attendanceAgg._sum.absentDays ?? 0),
      halfDays: Number(attendanceAgg._sum.halfDays ?? 0),
      paidLeave: Number(attendanceAgg._sum.paidLeave ?? 0),
      unpaidLeave: Number(attendanceAgg._sum.unpaidLeave ?? 0),
      overtimeHours: Number(attendanceAgg._sum.overtimeHours ?? 0),
    },
    byDepartment: byDepartment
      .map((d) => ({ department: d.department ?? 'Unassigned', count: d._count._all }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Every employee, for the Employee Master report. */
export async function employeeMasterReport() {
  return prisma.employee.findMany({
    where: { isDeleted: false },
    select: {
      employeeNo: true, employeeCode: true, name: true, mobile: true, email: true,
      department: true, employmentType: true, status: true, joiningDate: true, gender: true,
      salaryType: true, monthlySalary: true, perDaySalary: true, perHourSalary: true, shiftSalary: true,
      shift: { select: { name: true } },
    },
    orderBy: { name: 'asc' },
  });
}

/** Attendance + leave for a month — backs both the attendance and leave reports. */
export async function attendanceReport(query: PeriodQuery) {
  const rows = await prisma.attendance.findMany({
    where: { isDeleted: false, year: query.year, month: query.month },
    select: attendanceSelect,
    orderBy: { employee: { name: 'asc' } },
  });
  return rows.map((r) => ({ ...r, payableDays: Number(payableDaysFor(r)) }));
}

/** The salary register: one line per employee with the full earnings/deductions split. */
export async function salaryRegisterReport(query: PeriodQuery) {
  const { rows, totals } = await listPayroll({ year: query.year, month: query.month });
  return { period: periodLabel(query.year, query.month), rows, totals };
}

/** Twelve months of payroll totals, for the monthly summary report. */
export async function monthlySummaryReport(query: { year: number }) {
  const rows = await prisma.payroll.groupBy({
    by: ['month'],
    where: { isDeleted: false, year: query.year },
    _count: { _all: true },
    _sum: { grossSalary: true, netSalary: true, deductions: true, overtimeAmount: true },
    orderBy: { month: 'asc' },
  });
  return rows.map((r) => ({
    month: r.month,
    monthName: MONTH_NAMES[r.month - 1],
    employees: r._count._all,
    gross: Number(r._sum.grossSalary ?? 0),
    net: Number(r._sum.netSalary ?? 0),
    deductions: Number(r._sum.deductions ?? 0),
    overtime: Number(r._sum.overtimeAmount ?? 0),
  }));
}

export const payrollService = {
  listAttendance, saveAttendance, deleteAttendance,
  listPayroll, generatePayroll, updatePayroll, markPayrollPaid, revertPayrollPayment, getPayslip,
  getPayrollDashboard, employeeMasterReport, attendanceReport, salaryRegisterReport, monthlySummaryReport,
};
