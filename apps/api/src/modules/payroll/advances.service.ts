import { Prisma, AdvanceStatus, ExpenseLocation } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { cache, CacheTag } from '../../config/cache';
import { AppError } from '../../shared/utils/AppError';
import { nextDocNumber } from '../../shared/utils/docNumber';
import { enqueueTallySync, markTallyDeleted } from '../tally/tally.outbox';
import type { CreateAdvanceInput, ListAdvancesQuery, UpdateAdvanceInput } from './payroll.schema';

const ADVANCE_CATEGORY = 'Employee Advance';

function invalidate(): void {
  cache.invalidateTags(CacheTag.PAYROLL, CacheTag.EXPENSES, CacheTag.ANALYTICS, CacheTag.DASHBOARD);
}

const advanceSelect = {
  id: true, advanceNo: true, employeeId: true, amount: true, amountRecovered: true,
  givenDate: true, paymentMethod: true, status: true, notes: true,
  employee: { select: { id: true, employeeNo: true, name: true } },
} satisfies Prisma.EmployeeAdvanceSelect;

/** Every advance books against its own category, kept apart from "Salary & Wages" so
 * outstanding-but-recoverable cash reads separately from settled wage cost. */
async function advanceCategoryId(tx: Prisma.TransactionClient): Promise<string> {
  const existing = await tx.expenseCategory.findFirst({ where: { name: ADVANCE_CATEGORY }, select: { id: true } });
  if (existing) return existing.id;
  const created = await tx.expenseCategory.create({ data: { name: ADVANCE_CATEGORY, isSystem: true }, select: { id: true } });
  return created.id;
}

export async function listAdvances(query: ListAdvancesQuery) {
  const rows = await prisma.employeeAdvance.findMany({
    where: {
      isDeleted: false,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    select: advanceSelect,
    orderBy: { givenDate: 'desc' },
  });
  const outstandingTotal = rows.reduce(
    (sum, r) => (r.status === AdvanceStatus.OUTSTANDING ? sum.add(new Prisma.Decimal(r.amount).sub(r.amountRecovered)) : sum),
    new Prisma.Decimal(0),
  );
  return { rows, outstandingTotal: Number(outstandingTotal) };
}

/**
 * Cash handed to an employee now, recovered from salary later. Booked as its own
 * Expense immediately — see the model comment on EmployeeAdvance for why that's
 * correct rather than double-counting.
 */
export async function createAdvance(input: CreateAdvanceInput, createdById: string) {
  const employee = await prisma.employee.findFirst({ where: { id: input.employeeId, isDeleted: false }, select: { id: true, name: true } });
  if (!employee) throw AppError.notFound('Employee not found');

  const advance = await prisma.$transaction(async (tx) => {
    const categoryId = await advanceCategoryId(tx);
    const expense = await tx.expense.create({
      data: {
        categoryId,
        amount: input.amount,
        expenseDate: input.givenDate,
        paymentMethod: input.paymentMethod,
        location: ExpenseLocation.GENERAL,
        paidTo: employee.name,
        note: `Advance to ${employee.name}`,
        createdById,
      },
      select: { id: true },
    });
    await enqueueTallySync(tx, {
      entityType: 'EXPENSE', entityId: expense.id, voucherType: 'PAYMENT',
      entityDate: input.givenDate, amount: input.amount, docNumber: null, partyName: employee.name,
    });
    const advanceNo = await nextDocNumber(tx, 'ADVANCE');
    return tx.employeeAdvance.create({
      data: { advanceNo, employeeId: input.employeeId, amount: input.amount, givenDate: input.givenDate, paymentMethod: input.paymentMethod, notes: input.notes, expenseId: expense.id, createdById },
      select: advanceSelect,
    });
  });
  invalidate();
  return advance;
}

/** Editable only up to the point nothing has been recovered against it yet — once a
 * payroll has drawn on this advance, its figures are load-bearing history. */
export async function updateAdvance(id: string, input: UpdateAdvanceInput) {
  const existing = await prisma.employeeAdvance.findFirst({ where: { id, isDeleted: false } });
  if (!existing) throw AppError.notFound('Advance not found');
  if (Number(existing.amountRecovered) > 0) {
    throw AppError.invalidState('This advance has already been partly recovered and can no longer be edited');
  }

  const advance = await prisma.$transaction(async (tx) => {
    if (input.amount !== undefined && existing.expenseId) {
      await tx.expense.update({ where: { id: existing.expenseId }, data: { amount: input.amount } });
    }
    if (input.givenDate !== undefined && existing.expenseId) {
      await tx.expense.update({ where: { id: existing.expenseId }, data: { expenseDate: input.givenDate } });
    }
    if (input.paymentMethod !== undefined && existing.expenseId) {
      await tx.expense.update({ where: { id: existing.expenseId }, data: { paymentMethod: input.paymentMethod } });
    }
    if (existing.expenseId && (input.amount !== undefined || input.givenDate !== undefined || input.paymentMethod !== undefined)) {
      const e = await tx.expense.findUniqueOrThrow({ where: { id: existing.expenseId }, select: { id: true, amount: true, expenseDate: true, paidTo: true } });
      await enqueueTallySync(tx, {
        entityType: 'EXPENSE', entityId: e.id, voucherType: 'PAYMENT',
        entityDate: e.expenseDate, amount: e.amount, docNumber: null, partyName: e.paidTo,
      });
    }
    return tx.employeeAdvance.update({ where: { id }, data: input, select: advanceSelect });
  });
  invalidate();
  return advance;
}

export async function deleteAdvance(id: string) {
  const existing = await prisma.employeeAdvance.findFirst({ where: { id, isDeleted: false } });
  if (!existing) throw AppError.notFound('Advance not found');
  if (Number(existing.amountRecovered) > 0) {
    throw AppError.invalidState('This advance has already been partly recovered and cannot be deleted');
  }

  await prisma.$transaction(async (tx) => {
    await tx.employeeAdvance.update({ where: { id }, data: { isDeleted: true } });
    if (existing.expenseId) {
      await markTallyDeleted(tx, 'EXPENSE', existing.expenseId);
      await tx.expense.delete({ where: { id: existing.expenseId } });
    }
  });
  invalidate();
  return { deleted: true };
}

/** Sum of amount − amountRecovered across an employee's still-outstanding advances. */
export async function outstandingAdvanceBalance(
  employeeId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Prisma.Decimal> {
  const rows = await tx.employeeAdvance.findMany({
    where: { employeeId, isDeleted: false, status: AdvanceStatus.OUTSTANDING },
    select: { amount: true, amountRecovered: true },
  });
  return rows.reduce((sum, r) => sum.add(new Prisma.Decimal(r.amount).sub(r.amountRecovered)), new Prisma.Decimal(0));
}

/**
 * Apply a payroll's advanceRecovery figure against an employee's outstanding advances,
 * oldest first, splitting across as many as it takes. Called from markPayrollPaid,
 * inside the same transaction — recovery only becomes real once the salary is actually
 * paid, matching how the Expense itself is only booked at that point too.
 */
export async function applyAdvanceRecoveryTx(
  tx: Prisma.TransactionClient,
  employeeId: string,
  payrollId: string,
  amount: Prisma.Decimal,
): Promise<void> {
  if (amount.lessThanOrEqualTo(0)) return;
  const advances = await tx.employeeAdvance.findMany({
    where: { employeeId, isDeleted: false, status: AdvanceStatus.OUTSTANDING },
    orderBy: { givenDate: 'asc' },
  });

  let remaining = amount;
  for (const adv of advances) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const outstanding = new Prisma.Decimal(adv.amount).sub(adv.amountRecovered);
    if (outstanding.lessThanOrEqualTo(0)) continue;

    const applied = Prisma.Decimal.min(outstanding, remaining);
    await tx.advanceRecoveryEntry.create({ data: { advanceId: adv.id, payrollId, amount: applied } });
    const newRecovered = new Prisma.Decimal(adv.amountRecovered).add(applied);
    await tx.employeeAdvance.update({
      where: { id: adv.id },
      data: {
        amountRecovered: newRecovered,
        status: newRecovered.greaterThanOrEqualTo(adv.amount) ? AdvanceStatus.RECOVERED : AdvanceStatus.OUTSTANDING,
      },
    });
    remaining = remaining.sub(applied);
  }
}

/** Undo every recovery a payroll applied — mirrors revertPayrollPayment's own undo. */
export async function reverseAdvanceRecoveryTx(tx: Prisma.TransactionClient, payrollId: string): Promise<void> {
  const entries = await tx.advanceRecoveryEntry.findMany({ where: { payrollId } });
  for (const entry of entries) {
    const adv = await tx.employeeAdvance.findUniqueOrThrow({ where: { id: entry.advanceId } });
    const restored = Prisma.Decimal.max(new Prisma.Decimal(adv.amountRecovered).sub(entry.amount), new Prisma.Decimal(0));
    await tx.employeeAdvance.update({
      where: { id: entry.advanceId },
      data: { amountRecovered: restored, status: AdvanceStatus.OUTSTANDING },
    });
  }
  await tx.advanceRecoveryEntry.deleteMany({ where: { payrollId } });
}

export const advancesService = {
  listAdvances, createAdvance, updateAdvance, deleteAdvance,
  outstandingAdvanceBalance, applyAdvanceRecoveryTx, reverseAdvanceRecoveryTx,
};
