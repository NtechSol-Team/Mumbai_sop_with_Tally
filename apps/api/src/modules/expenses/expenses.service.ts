import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { cache, CacheTag } from '../../config/cache';
import { AppError } from '../../shared/utils/AppError';
import { buildPaginationMeta, toSkipTake } from '../../shared/utils/pagination';
import { IST_AT, istRange } from '../../shared/utils/date';
import { booksScopeFor } from '../../shared/utils/books';
import type { AuthUser } from '../../shared/types/api';
import { enqueueTallySync, markTallyDeleted } from '../tally/tally.outbox';
import type { CreateExpenseInput, ExpenseSummaryQuery, ListExpensesQuery, UpdateExpenseInput } from './expenses.schema';

const invalidate = () => cache.invalidateTags(CacheTag.EXPENSES, CacheTag.ANALYTICS, CacheTag.DASHBOARD);

type ExpenseSyncRow = {
  id: string; amount: Prisma.Decimal; expenseDate: Date; paidTo: string | null;
  invoiceNumber: string | null; outletId: string | null; supplierBillId: string | null;
};

/** Enqueue (or re-enqueue) an expense for the Tally sync. Excluded when it is a
 *  branch's own cost, or when it is already carried by a purchase bill's voucher. */
async function enqueueExpenseSync(tx: Prisma.TransactionClient, e: ExpenseSyncRow): Promise<void> {
  const excludedReason = e.supplierBillId
    ? 'Line of a purchase bill — already posted with that bill’s Purchase voucher.'
    : e.outletId
      ? 'Branch expense — the outlet bears this cost; excluded from the company books.'
      : null;
  await enqueueTallySync(tx, {
    entityType: 'EXPENSE', entityId: e.id, voucherType: 'PAYMENT',
    entityDate: e.expenseDate, amount: e.amount,
    docNumber: e.invoiceNumber, partyName: e.paidTo, excludedReason,
  });
}

/** IST calendar window for expenseDate — half-open, so the final day isn't clipped. */
function dateWindow(from?: Date, to?: Date): Prisma.ExpenseWhereInput {
  const expenseDate = istRange(from, to);
  return expenseDate ? { expenseDate } : {};
}

export async function listCategories() {
  return prisma.expenseCategory.findMany({
    where: { isDeleted: false, isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, isSystem: true },
  });
}

export async function createCategory(name: string, createdById: string) {
  return prisma.expenseCategory.create({ data: { name, createdById } });
}

/**
 * Rename a category. The name is renamed in place, so every expense already
 * pointing at this category (by id) instantly reflects the new label — no data
 * migration needed. System categories are protected from renaming.
 */
export async function updateCategory(id: string, name: string) {
  const existing = await prisma.expenseCategory.findFirst({ where: { id, isDeleted: false } });
  if (!existing) throw AppError.notFound('Category not found');
  if (existing.isSystem) throw AppError.badRequest('System categories cannot be renamed');
  const category = await prisma.expenseCategory.update({ where: { id }, data: { name } });
  invalidate();
  return category;
}

export async function listExpenses(query: ListExpensesQuery, user: AuthUser) {
  const where: Prisma.ExpenseWhereInput = {
    isDeleted: false,
    ...booksScopeFor(user),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.location ? { location: query.location } : {}),
    ...(query.paidBy ? { paidBy: query.paidBy } : {}),
    ...dateWindow(query.from, query.to),
  };
  const { skip, take } = toSkipTake(query);
  const [rows, total] = await Promise.all([
    prisma.expense.findMany({
      where, orderBy: { expenseDate: 'desc' }, skip, take,
      include: { category: { select: { id: true, name: true } } },
    }),
    prisma.expense.count({ where }),
  ]);
  return { rows, meta: buildPaginationMeta(query, total) };
}

export async function createExpense(input: CreateExpenseInput, user: AuthUser) {
  const category = await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, isDeleted: false } });
  if (!category) throw AppError.badRequest('Invalid expense category', undefined, 'categoryId');
  const expense = await prisma.$transaction(async (tx) => {
    const created = await tx.expense.create({
      // outletId comes from who is filing, never from the request body.
      data: { ...input, ...booksScopeFor(user), createdById: user.id },
      include: { category: { select: { id: true, name: true } } },
    });
    await enqueueExpenseSync(tx, created);
    return created;
  });
  invalidate();
  return expense;
}

export async function updateExpense(id: string, input: UpdateExpenseInput, user: AuthUser) {
  const existing = await prisma.expense.findFirst({ where: { id, isDeleted: false, ...booksScopeFor(user) } });
  if (!existing) throw AppError.notFound('Expense not found');
  const expense = await prisma.$transaction(async (tx) => {
    const updated = await tx.expense.update({ where: { id }, data: input, include: { category: { select: { id: true, name: true } } } });
    await enqueueExpenseSync(tx, updated);
    return updated;
  });
  invalidate();
  return expense;
}

export async function deleteExpense(id: string, user: AuthUser) {
  const existing = await prisma.expense.findFirst({ where: { id, isDeleted: false, ...booksScopeFor(user) } });
  if (!existing) throw AppError.notFound('Expense not found');
  await prisma.$transaction(async (tx) => {
    await tx.expense.update({ where: { id }, data: { isDeleted: true } });
    await markTallyDeleted(tx, 'EXPENSE', id);
  });
  invalidate();
  return { deleted: true };
}

export async function getSummary(query: ExpenseSummaryQuery, user: AuthUser) {
  const { outletId } = booksScopeFor(user);
  const where: Prisma.ExpenseWhereInput = {
    isDeleted: false,
    outletId,
    ...(query.location ? { location: query.location } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.paidBy ? { paidBy: query.paidBy } : {}),
    ...dateWindow(query.from, query.to),
  };

  const [byCategoryRaw, byLocationRaw, byPaidByRaw, totalAgg, countAgg] = await Promise.all([
    prisma.expense.groupBy({ by: ['categoryId'], _sum: { amount: true }, where }),
    prisma.expense.groupBy({ by: ['location'], _sum: { amount: true }, where }),
    // Who fronted the money — drives the partner-reimbursement view in reports.
    prisma.expense.groupBy({ by: ['paidBy'], _sum: { amount: true }, where }),
    prisma.expense.aggregate({ _sum: { amount: true }, where }),
    prisma.expense.count({ where }),
  ]);

  const categoryIds = byCategoryRaw.map((c) => c.categoryId);
  const cats = await prisma.expenseCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } });
  const nameOf = new Map(cats.map((c) => [c.id, c.name]));

  // Rolling 6-month trend. Deliberately ignores from/to — the point of a trend is
  // the months either side of whatever window is selected — but it does honour the
  // location and category filters so the line matches what's being looked at.
  // Months are IST months: an expense at 02:00 IST on 1 Aug belongs to August, not
  // to July, which is where a UTC date_trunc would file it.
  const monthly = await prisma.$queryRaw<Array<{ month: string; total: number }>>`
    SELECT to_char(date_trunc('month', expense_date ${Prisma.raw(IST_AT)}), 'YYYY-MM') AS month,
           COALESCE(SUM(amount), 0)::float AS total
    FROM expenses
    WHERE is_deleted = false
      ${outletId ? Prisma.sql`AND outlet_id = ${outletId}::uuid` : Prisma.sql`AND outlet_id IS NULL`}
      ${query.location ? Prisma.sql`AND location = ${query.location}::"ExpenseLocation"` : Prisma.empty}
      ${query.categoryId ? Prisma.sql`AND category_id = ${query.categoryId}::uuid` : Prisma.empty}
      -- The bound is converted, not the column: wrapping expense_date in AT TIME
      -- ZONE makes it non-sargable, so the index on it can no longer range-seek.
      AND expense_date >= (date_trunc('month', now() ${Prisma.raw(IST_AT)}) - interval '5 months') ${Prisma.raw(IST_AT)}
    GROUP BY 1 ORDER BY 1`;

  return {
    total: Number(totalAgg._sum.amount ?? 0),
    count: countAgg,
    byCategory: byCategoryRaw
      // categoryId rides along so the UI can turn a bar into a filter.
      .map((c) => ({ categoryId: c.categoryId, category: nameOf.get(c.categoryId) ?? 'Unknown', total: Number(c._sum.amount ?? 0) }))
      .sort((a, b) => b.total - a.total),
    byLocation: byLocationRaw.map((l) => ({ location: l.location, total: Number(l._sum.amount ?? 0) })),
    byPaidBy: byPaidByRaw
      .map((p) => ({ paidBy: p.paidBy, total: Number(p._sum.amount ?? 0) }))
      .sort((a, b) => b.total - a.total),
    monthly,
  };
}

export const expensesService = {
  listCategories, createCategory, updateCategory,
  listExpenses, createExpense, updateExpense, deleteExpense, getSummary,
};
