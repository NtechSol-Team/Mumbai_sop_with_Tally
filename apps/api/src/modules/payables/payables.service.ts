import { Prisma, SupplierBillStatus, PaymentMethod } from '@prisma/client';
import { startOfMonth } from 'date-fns';
import { prisma } from '../../config/prisma';
import { cache, CacheTag } from '../../config/cache';
import { AppError } from '../../shared/utils/AppError';
import { booksScopeFor } from '../../shared/utils/books';
import type { AuthUser } from '../../shared/types/api';
import { nextDocNumber } from '../../shared/utils/docNumber';
import { buildPaginationMeta, toSkipTake } from '../../shared/utils/pagination';
import { enqueueTallySync } from '../tally/tally.outbox';
import type { ListPayablesQuery, PaySupplierInput } from './payables.schema';

export async function listPayables(query: ListPayablesQuery, user: AuthUser) {
  const where: Prisma.SupplierBillWhereInput = {
    isDeleted: false,
    ...booksScopeFor(user),
    ...(query.status ? { status: query.status } : {}),
    ...(query.outstandingOnly ? { status: { in: [SupplierBillStatus.UNPAID, SupplierBillStatus.PARTIALLY_PAID] } } : {}),
    ...(query.search ? { OR: [{ supplierName: { contains: query.search, mode: 'insensitive' } }, { invoiceNumber: { contains: query.search, mode: 'insensitive' } }, { billNumber: { contains: query.search, mode: 'insensitive' } }] } : {}),
  };
  const { skip, take } = toSkipTake(query);
  const [rows, total] = await Promise.all([
    prisma.supplierBill.findMany({
      where, orderBy: { billDate: 'desc' }, skip, take,
      select: { id: true, billNumber: true, supplierName: true, invoiceNumber: true, billDate: true, dueDate: true, totalAmount: true, amountPaid: true, balanceDue: true, status: true },
    }),
    prisma.supplierBill.count({ where }),
  ]);
  return { rows, meta: buildPaginationMeta(query, total) };
}

export async function getPayable(id: string, user: AuthUser) {
  const bill = await prisma.supplierBill.findFirst({
    where: { id, isDeleted: false, ...booksScopeFor(user) },
    include: {
      payments: { where: { isDeleted: false }, orderBy: { paymentDate: 'desc' } },
      intakeLines: { include: { rawMaterial: { select: { name: true, unit: { select: { id: true, name: true, decimalPlaces: true } } } } } },
      expenseLines: { include: { category: { select: { name: true } } } },
    },
  });
  if (!bill) throw AppError.notFound('Supplier bill not found');
  return bill;
}

/** Record a payment to a supplier against a bill (insert-only). */
export async function paySupplier(id: string, input: PaySupplierInput, user: AuthUser) {
  const userId = user.id;
  const { outletId } = booksScopeFor(user);
  const result = await prisma.$transaction(async (tx) => {
    const bill = await tx.supplierBill.findFirst({ where: { id, isDeleted: false, outletId } });
    if (!bill) throw AppError.notFound('Supplier bill not found');
    if (bill.status === SupplierBillStatus.PAID) throw AppError.invalidState('This bill is already fully paid');

    const balance = new Prisma.Decimal(bill.balanceDue);
    const amount = new Prisma.Decimal(input.amount);
    if (amount.greaterThan(balance)) throw AppError.badRequest(`Amount exceeds balance due (${balance.toString()})`, undefined, 'amount');

    const payment = await tx.supplierPayment.create({
      data: {
        paymentNumber: await nextDocNumber(tx, 'SUPPLIER_PAYMENT'),
        supplierBillId: bill.id, amount, method: input.method, paymentDate: input.paymentDate,
        notes: input.notes, paidById: userId, createdById: userId,
      },
    });
    const newPaid = new Prisma.Decimal(bill.amountPaid).add(amount);
    const newBalance = new Prisma.Decimal(bill.totalAmount).sub(newPaid);
    const status = newBalance.lessThanOrEqualTo(0) ? SupplierBillStatus.PAID : SupplierBillStatus.PARTIALLY_PAID;
    const updated = await tx.supplierBill.update({ where: { id: bill.id }, data: { amountPaid: newPaid, balanceDue: newBalance, status } });

    // Payment voucher — but only if the bill it settles is itself synced.
    const excludedReason = !bill.isGstBill
      ? 'Payment against a non-GST purchase — excluded from Tally along with its bill.'
      : outletId
        ? 'Payment for a branch purchase — excluded from the company books.'
        : null;
    await enqueueTallySync(tx, {
      entityType: 'SUPPLIER_PAYMENT', entityId: payment.id, voucherType: 'PAYMENT',
      entityDate: payment.paymentDate, amount: payment.amount, docNumber: payment.paymentNumber,
      partyName: bill.supplierName, excludedReason,
    });
    return { payment, bill: updated };
  });

  cache.invalidateTags(CacheTag.PAYMENTS, CacheTag.DASHBOARD, CacheTag.ANALYTICS);
  return result;
}

/** Payables dashboard: total owed, paid this month, supplier-wise + aging. */
export async function getPayablesSummary(user: AuthUser) {
  const { outletId } = booksScopeFor(user);
  // Cached per books — a branch's payables and the company's are different figures.
  return cache.getOrSet(`payables:summary:${outletId ?? 'HEAD_OFFICE'}`, [CacheTag.PAYMENTS], async () => {
    const outstandingWhere: Prisma.SupplierBillWhereInput = { isDeleted: false, outletId, status: { in: [SupplierBillStatus.UNPAID, SupplierBillStatus.PARTIALLY_PAID] } };
    const [totalPayable, paidThisMonth, bySupplierRaw, aging] = await Promise.all([
      prisma.supplierBill.aggregate({ _sum: { balanceDue: true }, where: outstandingWhere }),
      prisma.supplierPayment.aggregate({
        _sum: { amount: true },
        where: { isDeleted: false, paymentDate: { gte: startOfMonth(new Date()) }, bill: { outletId } },
      }),
      prisma.supplierBill.groupBy({ by: ['supplierName'], _sum: { balanceDue: true }, where: outstandingWhere }),
      prisma.$queryRawUnsafe<Array<{ bucket: string; amount: number }>>(
        `SELECT CASE
            WHEN now()::date - bill_date::date BETWEEN 0 AND 7 THEN '0-7'
            WHEN now()::date - bill_date::date BETWEEN 8 AND 15 THEN '8-15'
            WHEN now()::date - bill_date::date BETWEEN 16 AND 30 THEN '16-30'
            ELSE '30+'
          END AS bucket, COALESCE(SUM(balance_due),0)::float AS amount
          FROM supplier_bills
          WHERE is_deleted=false AND status IN ('UNPAID','PARTIALLY_PAID')
            AND outlet_id IS NOT DISTINCT FROM $1::uuid
          GROUP BY 1`,
        outletId,
      ),
    ]);
    const order = ['0-7', '8-15', '16-30', '30+'];
    const map = new Map(aging.map((a) => [a.bucket, a.amount]));
    return {
      totalPayable: Number(totalPayable._sum.balanceDue ?? 0),
      paidThisMonth: Number(paidThisMonth._sum.amount ?? 0),
      bySupplier: bySupplierRaw
        .map((b) => ({ supplierName: b.supplierName ?? 'Unknown', outstanding: Number(b._sum.balanceDue ?? 0) }))
        .filter((b) => b.outstanding > 0)
        .sort((a, b) => b.outstanding - a.outstanding),
      aging: order.map((label) => ({ label, amount: map.get(label) ?? 0 })),
    };
  });
}

export const payablesService = { listPayables, getPayable, paySupplier, getPayablesSummary };
export { PaymentMethod };
