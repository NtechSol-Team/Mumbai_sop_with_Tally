import type { Job } from 'pg-boss';
import { Prisma, TallySyncStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { emitRealtime } from '../../sockets/realtime';
import { RealtimeEvent } from '../../sockets/events';
import { buildVoucher } from '../../modules/tally/tally.builder';
import { TallyBuildError } from '../../modules/tally/tally.types';
import { getTallyConfig } from '../../modules/tally/tally.config';

/**
 * Turn PENDING queue rows into validated canonical vouchers.
 *
 *  • build returns a payload  → store it; the row stays PENDING and the agent
 *    picks it up on its next pull (ready = status PENDING AND payload_json set).
 *  • build returns null       → not eligible yet (module off, before the cutover
 *    date, an accrued expense not yet paid). Left untouched, retried next run.
 *  • build throws TallyBuildError → the voucher can't be posted as-is (missing
 *    ledger mapping, unbalanced). Recorded FAILED with the reason; the owner
 *    fixes the mapping and hits Retry.
 *
 * Runs every minute and is also nudged right after an enqueue.
 */
export async function tallyBuildVouchersHandler(_jobs: Job[]): Promise<void> {
  const cfg = await getTallyConfig();
  if (!cfg.syncEnabled) return;

  // Rows needing a build: PENDING with no payload yet (fresh or re-opened after an edit).
  const rows = await prisma.tallySyncQueue.findMany({
    where: { status: TallySyncStatus.PENDING, payloadJson: { equals: Prisma.DbNull } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  if (!rows.length) return;

  let built = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const payload = await buildVoucher(row);
      if (!payload) continue; // not eligible yet
      await prisma.tallySyncQueue.update({
        where: { id: row.id },
        data: { payloadJson: payload as unknown as Prisma.InputJsonValue, errorMessage: null },
      });
      built += 1;
    } catch (err) {
      const message = err instanceof TallyBuildError
        ? err.message
        : `Could not build the voucher: ${err instanceof Error ? err.message : String(err)}`;
      await prisma.tallySyncQueue.update({
        where: { id: row.id },
        data: { status: TallySyncStatus.FAILED, errorMessage: message },
      });
      failed += 1;
    }
  }

  if (built || failed) {
    logger.info({ built, failed, scanned: rows.length }, 'tally: voucher build pass');
    await emitRealtime(RealtimeEvent.REPORT_READY, { type: 'tally_build', built, failed }, { global: true });
  }
}
