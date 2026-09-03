import { Prisma, TallyEntityType, TallyVoucherType, TallySyncStatus } from '@prisma/client';

/**
 * The transactional outbox for the Tally sync.
 *
 * `enqueueTallySync` is called INSIDE the same `prisma.$transaction(...)` as the
 * financial write it mirrors — so a queue row can never exist for a rolled-back
 * transaction, and a committed financial row can never be missed. The build +
 * validate + push happens later, off a pg-boss worker; this function only records
 * that something happened.
 *
 * Two hard rules live here (not in config — the accountant cannot switch them off):
 *   • a non-GST purchase, or stock intake with no purchase bill, is written
 *     straight as EXCLUDED with a reason;
 *   • branch-scoped costs (outletId != null) are EXCLUDED — they are already kept
 *     off the company's books.
 * Everything else lands PENDING and the worker decides eligibility (module on/off,
 * cutover date) at build time.
 */

export function tallyDedupKey(entityType: TallyEntityType, entityId: string): string {
  return `MUMBAIERP-${entityType}-${entityId}`;
}

export interface EnqueueTallyInput {
  entityType: TallyEntityType;
  entityId: string;
  voucherType: TallyVoucherType;
  entityDate: Date;
  amount: Prisma.Decimal | number;
  docNumber?: string | null;
  partyName?: string | null;
  /** Present → the row is written EXCLUDED and never built. */
  excludedReason?: string | null;
}

/**
 * Record (or re-record) a financial event for the Tally sync. Safe to call on
 * create and on every edit: an edit bumps `revision`, clears the previous
 * outcome, and re-opens the row so the worker rebuilds and the agent reposts
 * (treating a higher revision as "cancel the old voucher, post the new one").
 */
export async function enqueueTallySync(tx: Prisma.TransactionClient, input: EnqueueTallyInput): Promise<void> {
  const dedupKey = tallyDedupKey(input.entityType, input.entityId);
  const amount = new Prisma.Decimal(input.amount ?? 0);
  const excluded = !!input.excludedReason;

  const existing = await tx.tallySyncQueue.findUnique({
    where: { entityType_entityId: { entityType: input.entityType, entityId: input.entityId } },
    select: { id: true, revision: true, status: true },
  });

  const commonWrite = {
    voucherType: input.voucherType,
    entityDate: input.entityDate,
    amount,
    docNumber: input.docNumber ?? null,
    partyName: input.partyName ?? null,
  };

  if (!existing) {
    await tx.tallySyncQueue.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        dedupKey,
        status: excluded ? TallySyncStatus.EXCLUDED : TallySyncStatus.PENDING,
        excludedReason: input.excludedReason ?? null,
        ...commonWrite,
      },
    });
    return;
  }

  await tx.tallySyncQueue.update({
    where: { id: existing.id },
    data: {
      ...commonWrite,
      revision: { increment: 1 },
      status: excluded ? TallySyncStatus.EXCLUDED : TallySyncStatus.PENDING,
      excludedReason: input.excludedReason ?? null,
      // Re-opening: drop the stale build + outcome so nothing half-synced lingers.
      payloadJson: Prisma.DbNull,
      errorMessage: null,
      tallyVoucherId: existing.status === TallySyncStatus.SYNCED ? undefined : null,
      tallyResponse: null,
      attempts: 0,
      lastAttemptAt: null,
      syncedAt: existing.status === TallySyncStatus.SYNCED ? undefined : null,
    },
  });
}

/**
 * The source row was soft-deleted / voided. Bump the revision and re-open so the
 * worker emits a CANCEL for the voucher already in Tally. No-op if the event was
 * never queued (e.g. it predates the sync).
 */
export async function markTallyDeleted(
  tx: Prisma.TransactionClient,
  entityType: TallyEntityType,
  entityId: string,
): Promise<void> {
  const row = await tx.tallySyncQueue.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { id: true, status: true },
  });
  if (!row) return;
  // An EXCLUDED row was never in Tally — nothing to cancel.
  if (row.status === TallySyncStatus.EXCLUDED) return;

  await tx.tallySyncQueue.update({
    where: { id: row.id },
    data: {
      revision: { increment: 1 },
      status: TallySyncStatus.PENDING,
      payloadJson: Prisma.DbNull,
      errorMessage: null,
      attempts: 0,
      lastAttemptAt: null,
    },
  });
}
