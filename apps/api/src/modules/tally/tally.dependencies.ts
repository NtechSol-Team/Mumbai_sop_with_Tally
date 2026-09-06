import type { TallyEntityType } from '@prisma/client';
import { prisma } from '../../config/prisma';

/** An Agst Ref allocation requires a confirmed parent, even after a failed import. */
export async function parentVoucherWaitReason(
  entityType: 'SALES_BILL' | 'PURCHASE_BILL', entityId: string, label: string,
): Promise<string | null> {
  const parent = await prisma.tallySyncQueue.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { status: true, docNumber: true },
  });
  if (parent?.status === 'SYNCED') return null;
  return `Payment held: ${parent?.docNumber ?? label} has not been confirmed in Tally (${parent?.status ?? 'not queued'}). Resolve and sync the bill first; this payment has not been sent.`;
}

/** Recheck source links at dispatch: queued payloads may predate a parent failure. */
export async function paymentVoucherWaitReason(row: {
  entityType: TallyEntityType; entityId: string; payloadJson: unknown;
}): Promise<string | null> {
  if ((row.payloadJson as { action?: string } | null)?.action === 'CANCEL') return null;
  if (row.entityType === 'SUPPLIER_PAYMENT') {
    const payment = await prisma.supplierPayment.findUnique({
      where: { id: row.entityId }, select: { supplierBillId: true },
    });
    if (!payment) return 'Payment held: source payment is missing. Rebuild its queue item before dispatch.';
    return parentVoucherWaitReason('PURCHASE_BILL', payment.supplierBillId, 'purchase bill');
  }
  if (row.entityType === 'PAYMENT_IN') {
    const payment = await prisma.payment.findUnique({
      where: { id: row.entityId }, select: { billId: true },
    });
    if (!payment) return 'Payment held: source receipt is missing. Rebuild its queue item before dispatch.';
    // A genuine advance has no invoice dependency.
    if (payment.billId) return parentVoucherWaitReason('SALES_BILL', payment.billId, 'sales bill');
  }
  return null;
}
