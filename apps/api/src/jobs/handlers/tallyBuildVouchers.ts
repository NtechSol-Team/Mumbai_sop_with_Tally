import type { Job } from 'pg-boss';
import { Prisma, TallySyncStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { emitRealtime } from '../../sockets/realtime';
import { RealtimeEvent } from '../../sockets/events';
import { buildVoucher } from '../../modules/tally/tally.builder';
import { TallyBuildError, TallyDeferError } from '../../modules/tally/tally.types';
import { getTallyConfig, ensureTallyDefaults } from '../../modules/tally/tally.config';

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

  // Pick up anything added since the last pass — a new outlet, a new expense
  // category, a supplier that has just had its first bill. Without this, the
  // map only refreshes when someone opens the settings screen, and a voucher
  // for something brand-new fails on a mapping that simply doesn't exist yet.
  await ensureTallyDefaults();

  // Rows needing a build: PENDING with no payload yet (fresh or re-opened after an edit).
  const rows = await prisma.tallySyncQueue.findMany({
    where: { status: TallySyncStatus.PENDING, payloadJson: { equals: Prisma.DbNull } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  if (!rows.length) return;

  let built = 0;
  let failed = 0;
  let deferred = 0;
  for (const row of rows) {
    try {
      const payload = await buildVoucher(row);
      if (!payload) continue; // not eligible yet
      const saved = await prisma.tallySyncQueue.updateMany({
        where: { id: row.id, revision: row.revision, status: TallySyncStatus.PENDING, payloadJson: { equals: Prisma.DbNull } },
        data: { payloadJson: payload as unknown as Prisma.InputJsonValue, errorMessage: null },
      });
      built += saved.count;
    } catch (err) {
      // Deferred is not failed: the row stays PENDING and is retried, but the
      // reason is recorded so it never looks stuck for no apparent cause.
      if (err instanceof TallyDeferError) {
        const saved = await prisma.tallySyncQueue.updateMany({ where: { id: row.id, revision: row.revision, status: TallySyncStatus.PENDING, payloadJson: { equals: Prisma.DbNull } }, data: { errorMessage: err.message } });
        deferred += saved.count;
        continue;
      }
      const message = err instanceof TallyBuildError
        ? err.message
        : `Could not build the voucher: ${err instanceof Error ? err.message : String(err)}`;
      const saved = await prisma.tallySyncQueue.updateMany({
        where: { id: row.id, revision: row.revision, status: TallySyncStatus.PENDING, payloadJson: { equals: Prisma.DbNull } },
        data: { status: TallySyncStatus.FAILED, errorMessage: message },
      });
      failed += saved.count;
    }
  }

  if (built || failed || deferred) {
    logger.info({ built, failed, deferred, scanned: rows.length }, 'tally: voucher build pass');
    await emitRealtime(RealtimeEvent.REPORT_READY, { type: 'tally_build', built, failed }, { global: true });
  }
}
