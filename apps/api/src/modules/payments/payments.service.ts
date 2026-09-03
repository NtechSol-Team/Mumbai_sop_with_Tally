import { Prisma, BillStatus, PaymentChannel, PaymentMethod, PaymentStatus, UserRole } from '@prisma/client';
import { startOfMonth } from 'date-fns';
import { prisma } from '../../config/prisma';
import { cache, CacheTag } from '../../config/cache';
import { AppError } from '../../shared/utils/AppError';
import { nextDocNumber } from '../../shared/utils/docNumber';
import { buildPaginationMeta, toSkipTake } from '../../shared/utils/pagination';
import { emitRealtime } from '../../sockets/realtime';
import { RealtimeEvent } from '../../sockets/events';
import { razorpay, razorpayErrorMessage, verifyCheckoutSignature, verifyWebhookSignature } from '../../config/razorpay';
import { env } from '../../config/env';
import { getCompanyProfile } from '../settings/settings.service';
import { ordersService } from '../orders/orders.service';
import type { AuthUser } from '../../shared/types/api';
import type { CashPaymentInput, ListPaymentsQuery, VerifyRazorpayInput } from './payments.schema';

interface RecordPaymentArgs {
  billId: string;
  amount: Prisma.Decimal;
  channel: PaymentChannel;
  method: PaymentMethod;
  receivedById?: string;
  createdById?: string;
  notes?: string;
  referenceNumber?: string;
  receiptPhotoUrl?: string;
  razorpay?: { orderId: string; paymentId: string; signature: string };
}

/**
 * Record a payment (INSERT-ONLY) and reconcile the bill. Guards against
 * over-payment. All money math is server-side.
 */
async function recordPayment(args: RecordPaymentArgs) {
  const result = await prisma.$transaction(async (tx) => {
    const bill = await tx.bill.findFirst({ where: { id: args.billId, isDeleted: false } });
    if (!bill) throw AppError.notFound('Bill not found');
    if (bill.status === BillStatus.PAID) throw AppError.invalidState('This bill is already fully paid');
    if (bill.status === BillStatus.CANCELLED) throw AppError.invalidState('This bill is cancelled');

    const balance = new Prisma.Decimal(bill.balanceDue);
    if (args.amount.greaterThan(balance)) {
      throw AppError.badRequest(`Amount exceeds balance due (${balance.toString()})`, undefined, 'amount');
    }

    const paymentNumber = await nextDocNumber(tx, 'PAYMENT');
    const payment = await tx.payment.create({
      data: {
        paymentNumber,
        billId: bill.id,
        outletId: bill.outletId,
        channel: args.channel,
        method: args.method,
        amount: args.amount,
        receivedById: args.receivedById,
        createdById: args.createdById,
        notes: args.notes,
        referenceNumber: args.referenceNumber,
        receiptPhotoUrl: args.receiptPhotoUrl,
        status: PaymentStatus.SUCCESS,
        razorpayOrderId: args.razorpay?.orderId,
        razorpayPaymentId: args.razorpay?.paymentId,
        razorpaySignature: args.razorpay?.signature,
      },
    });

    const newPaid = new Prisma.Decimal(bill.amountPaid).add(args.amount);
    const newBalance = new Prisma.Decimal(bill.grandTotal).sub(newPaid);
    const newStatus = newBalance.lessThanOrEqualTo(0) ? BillStatus.PAID : BillStatus.PARTIALLY_PAID;
    const updatedBill = await tx.bill.update({
      where: { id: bill.id },
      data: { amountPaid: newPaid, balanceDue: newBalance, status: newStatus },
      select: { id: true, billNumber: true, status: true, balanceDue: true, outletId: true },
    });

    return { payment, bill: updatedBill };
  });

  cache.invalidateTags(CacheTag.PAYMENTS, CacheTag.BILLS, CacheTag.ORDERS, CacheTag.DASHBOARD, CacheTag.outlet(result.bill.outletId));
  await emitRealtime(
    RealtimeEvent.PAYMENT_RECEIVED,
    { paymentNumber: result.payment.paymentNumber, amount: Number(result.payment.amount), billNumber: result.bill.billNumber, billStatus: result.bill.status },
    { global: true, outletId: result.bill.outletId },
  );
  return result;
}

export async function recordCashPayment(input: CashPaymentInput, user: AuthUser) {
  return recordPayment({
    billId: input.billId,
    amount: new Prisma.Decimal(input.amount),
    // Channel follows the method: only literal cash is CASH, everything else
    // (UPI against the collection QR, a bank transfer) moved digitally even
    // though a person keyed it in.
    channel: input.method === PaymentMethod.CASH ? PaymentChannel.CASH : PaymentChannel.DIGITAL,
    method: input.method,
    receivedById: user.id,
    createdById: user.id,
    notes: input.notes,
    referenceNumber: input.referenceNumber,
    receiptPhotoUrl: input.receiptPhotoUrl,
  });
}

/** Create a Razorpay order for the bill's outstanding balance. */
export async function createRazorpayOrder(billId: string, user: AuthUser) {
  const bill = await prisma.bill.findFirst({ where: { id: billId, isDeleted: false } });
  if (!bill) throw AppError.notFound('Bill not found');
  if (user.role !== UserRole.SUPER_ADMIN && bill.outletId !== user.outletId) throw AppError.forbidden();
  if (bill.status === BillStatus.PAID) throw AppError.invalidState('Bill already paid');

  const amountPaise = Math.round(Number(bill.balanceDue) * 100);
  try {
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: bill.billNumber,
      notes: { billId: bill.id, outletId: bill.outletId },
    });
    const company = await getCompanyProfile();
    const checkoutName = company.displayName || company.legalName || 'Payment';
    return { orderId: order.id, amount: amountPaise, currency: 'INR', keyId: env.RAZORPAY_KEY_ID, checkoutName };
  } catch (err) {
    throw AppError.payment(`Could not initiate payment: ${razorpayErrorMessage(err)}`);
  }
}

/** Verify the checkout signature and record the digital payment. */
export async function verifyRazorpayPayment(input: VerifyRazorpayInput, user: AuthUser) {
  const valid = verifyCheckoutSignature({
    orderId: input.razorpayOrderId,
    paymentId: input.razorpayPaymentId,
    signature: input.razorpaySignature,
  });
  if (!valid) throw AppError.payment('Payment signature verification failed');

  const bill = await prisma.bill.findFirst({ where: { id: input.billId, isDeleted: false } });
  if (!bill) throw AppError.notFound('Bill not found');
  if (user.role !== UserRole.SUPER_ADMIN && bill.outletId !== user.outletId) throw AppError.forbidden();

  // Idempotency: ignore if this payment id was already recorded.
  const existing = await prisma.payment.findFirst({ where: { razorpayPaymentId: input.razorpayPaymentId } });
  if (existing) return { alreadyRecorded: true };

  return recordPayment({
    billId: bill.id,
    amount: new Prisma.Decimal(bill.balanceDue),
    channel: PaymentChannel.DIGITAL,
    method: PaymentMethod.RAZORPAY,
    createdById: user.id,
    razorpay: { orderId: input.razorpayOrderId, paymentId: input.razorpayPaymentId, signature: input.razorpaySignature },
  });
}

/**
 * Reverse a payment recorded by mistake — wrong bill, wrong amount, double
 * entry, whatever. Soft-deletes the payment and re-derives the bill's
 * amountPaid/balanceDue/status from what's actually left (every remaining
 * SUCCESS payment on it), rather than just subtracting this one figure —
 * that stays correct even if amounts were ever hand-corrected or two
 * reversals land close together. Every other view (Cash Book, Day Book,
 * Financial Position, the Ledger, the Item Sales Report) reads live off
 * Payment.isDeleted and Bill.amountPaid/balanceDue, so nothing else needs
 * touching for the reversal to show up everywhere it should.
 */
export async function deletePayment(id: string) {
  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id, isDeleted: false } });
    if (!payment) throw AppError.notFound('Payment not found');
    if (!payment.billId) {
      // Only possible on a payment from before bills were raised instantly at
      // order placement — held against the order itself, never against a bill.
      throw AppError.invalidState('This payment was never tied to a bill, so there is nothing to reverse it against.');
    }

    const bill = await tx.bill.findFirst({ where: { id: payment.billId, isDeleted: false } });
    if (!bill) throw AppError.notFound('The bill this payment was recorded against no longer exists');

    await tx.payment.update({ where: { id: payment.id }, data: { isDeleted: true } });

    const remaining = await tx.payment.aggregate({
      _sum: { amount: true },
      where: { billId: bill.id, isDeleted: false, status: PaymentStatus.SUCCESS },
    });
    const amountPaid = new Prisma.Decimal(remaining._sum.amount ?? 0);
    const balanceDue = new Prisma.Decimal(bill.grandTotal).sub(amountPaid);
    const status = balanceDue.lessThanOrEqualTo(0)
      ? BillStatus.PAID
      : amountPaid.greaterThan(0)
        ? BillStatus.PARTIALLY_PAID
        : BillStatus.UNPAID;

    const updatedBill = await tx.bill.update({
      where: { id: bill.id },
      data: { amountPaid, balanceDue, status },
      select: { id: true, billNumber: true, status: true, amountPaid: true, balanceDue: true, outletId: true },
    });

    return { payment, bill: updatedBill };
  });

  cache.invalidateTags(CacheTag.PAYMENTS, CacheTag.BILLS, CacheTag.ORDERS, CacheTag.DASHBOARD, CacheTag.outlet(result.bill.outletId));
  return {
    deleted: true,
    paymentNumber: result.payment.paymentNumber,
    bill: { billNumber: result.bill.billNumber, status: result.bill.status, amountPaid: result.bill.amountPaid, balanceDue: result.bill.balanceDue },
  };
}

export async function listPayments(user: AuthUser, query: ListPaymentsQuery) {
  const scoped = user.role === UserRole.FRANCHISE_OWNER || user.role === UserRole.CASHIER;
  const where: Prisma.PaymentWhereInput = {
    isDeleted: false,
    ...(scoped ? { outletId: user.outletId ?? '__none__' } : query.outletId ? { outletId: query.outletId } : {}),
    ...(query.billId ? { billId: query.billId } : {}),
  };
  const { skip, take } = toSkipTake(query);
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({
      where, orderBy: { paymentDate: 'desc' }, skip, take,
      select: {
        id: true, paymentNumber: true, amount: true, channel: true, method: true, paymentDate: true,
        referenceNumber: true, notes: true,
        bill: { select: { billNumber: true } }, outlet: { select: { name: true } },
      },
    }),
    prisma.payment.count({ where }),
  ]);
  return { rows, meta: buildPaginationMeta(query, total) };
}

/** Payment dashboard: receivables, overdue, outlet-wise outstanding, aging. */
export async function getPaymentSummary(user: AuthUser) {
  const scoped = user.role === UserRole.FRANCHISE_OWNER ? user.outletId ?? '__none__' : undefined;
  const cacheKey = `payments:summary:${scoped ?? 'GLOBAL'}`;

  return cache.getOrSet(cacheKey, [CacheTag.PAYMENTS, CacheTag.BILLS], async () => {
    const outstandingWhere: Prisma.BillWhereInput = {
      isDeleted: false,
      status: { in: [BillStatus.UNPAID, BillStatus.PARTIALLY_PAID] },
      ...(scoped ? { outletId: scoped } : {}),
    };

    const [receivables, collectedThisMonth, byOutlet, aging] = await Promise.all([
      prisma.bill.aggregate({ _sum: { balanceDue: true }, where: outstandingWhere }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { isDeleted: false, paymentDate: { gte: startOfMonth(new Date()) }, ...(scoped ? { outletId: scoped } : {}) } }),
      prisma.bill.groupBy({ by: ['outletId'], _sum: { balanceDue: true }, where: outstandingWhere }),
      agingReport(scoped),
    ]);

    // Resolve outlet names for the outstanding breakdown.
    const outletIds = byOutlet.map((b) => b.outletId);
    const outlets = await prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true } });
    const nameOf = new Map(outlets.map((o) => [o.id, o.name]));

    return {
      totalReceivables: Number(receivables._sum.balanceDue ?? 0),
      collectedThisMonth: Number(collectedThisMonth._sum.amount ?? 0),
      overdueAmount: aging.buckets.reduce((s, b) => (b.label !== 'current' ? s + b.amount : s), 0),
      outletOutstanding: byOutlet
        .map((b) => ({ outletId: b.outletId, outletName: nameOf.get(b.outletId) ?? 'Unknown', outstanding: Number(b._sum.balanceDue ?? 0) }))
        .sort((a, b) => b.outstanding - a.outstanding),
      aging: aging.buckets,
    };
  });
}

async function agingReport(outletId?: string) {
  // Days overdue buckets on outstanding bills.
  const rows = await prisma.$queryRawUnsafe<Array<{ bucket: string; amount: number }>>(
    `SELECT
        CASE
          WHEN due_date >= now() THEN 'current'
          WHEN now()::date - due_date::date BETWEEN 1 AND 7 THEN '1-7'
          WHEN now()::date - due_date::date BETWEEN 8 AND 15 THEN '8-15'
          WHEN now()::date - due_date::date BETWEEN 16 AND 30 THEN '16-30'
          ELSE '30+'
        END AS bucket,
        COALESCE(SUM(balance_due), 0)::float AS amount
      FROM bills
      WHERE is_deleted = false AND status IN ('UNPAID','PARTIALLY_PAID')
        ${outletId ? `AND outlet_id = '${outletId}'::uuid` : ''}
      GROUP BY 1`,
  );
  const order = ['current', '1-7', '8-15', '16-30', '30+'];
  const map = new Map(rows.map((r) => [r.bucket, r.amount]));
  return { buckets: order.map((label) => ({ label, amount: map.get(label) ?? 0 })) };
}

/**
 * Razorpay webhook (backup to client-side verify). Verifies the signature, then
 * idempotently records captured payments by mapping the order back to its bill.
 */
export async function handleWebhook(rawBody: Buffer, signature: string, body: RazorpayWebhookBody) {
  if (!verifyWebhookSignature(rawBody, signature)) {
    throw AppError.badRequest('Invalid webhook signature', undefined, 'signature');
  }
  if (body.event !== 'payment.captured') return { ignored: true };

  const entity = body.payload?.payment?.entity;
  if (!entity?.id || !entity.order_id) return { ignored: true };

  const existing = await prisma.payment.findFirst({ where: { razorpayPaymentId: entity.id } });
  if (existing) return { alreadyRecorded: true };

  const order = await razorpay.orders.fetch(entity.order_id);
  const notes = order.notes as Record<string, string> | undefined;

  // Checkout against an outlet ORDER (pay-before-confirm): the order's bill doesn't
  // exist yet, so hand off to the orders module, which raises the bill, records the
  // payment and confirms the order in one transaction. This is the safety net for a
  // payment that succeeded after the outlet's browser closed mid-checkout.
  if (notes?.orderId) {
    return ordersService.confirmPaidOrderFromWebhook(notes.orderId, {
      razorpayOrderId: entity.order_id,
      razorpayPaymentId: entity.id,
    });
  }

  const billId = notes?.billId;
  if (!billId) return { ignored: true };

  const bill = await prisma.bill.findFirst({ where: { id: billId, isDeleted: false } });
  if (!bill || bill.status === BillStatus.PAID || bill.status === BillStatus.CANCELLED) return { ignored: true };

  const captured = new Prisma.Decimal(entity.amount).div(100);
  const balance = new Prisma.Decimal(bill.balanceDue);
  const amount = captured.greaterThan(balance) ? balance : captured;
  if (amount.lessThanOrEqualTo(0)) return { ignored: true };

  await recordPayment({
    billId: bill.id,
    amount,
    channel: PaymentChannel.DIGITAL,
    method: PaymentMethod.RAZORPAY,
    razorpay: { orderId: entity.order_id, paymentId: entity.id, signature: 'webhook' },
  });
  return { recorded: true };
}

interface RazorpayWebhookBody {
  event: string;
  payload?: { payment?: { entity?: { id?: string; order_id?: string; amount: number } } };
}

export const paymentsService = {
  recordCashPayment,
  createRazorpayOrder,
  verifyRazorpayPayment,
  listPayments,
  getPaymentSummary,
  handleWebhook,
  deletePayment,
};
