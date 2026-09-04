import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, TallySyncStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/utils/AppError';
import { buildPaginationMeta, toSkipTake } from '../../shared/utils/pagination';
import { enqueue, JobName } from '../../jobs/queue';
import type { AuthUser } from '../../shared/types/api';
import { getTallyConfig, getLedgerMap, updateTallyConfig, ensureTallyDefaults } from './tally.config';

const AGENT_OFFLINE_AFTER_MS = 3 * 60_000;

// ─────────────────────────────── ADMIN ────────────────────────────────────────

export async function getTallySettings() {
  await ensureTallyDefaults();
  const [config, ledgerMap] = await Promise.all([getTallyConfig(), getLedgerMap()]);
  const agentOnline = !!config.agentLastSeenAt && Date.now() - config.agentLastSeenAt.getTime() < AGENT_OFFLINE_AFTER_MS;
  // Never leak the token hash.
  const { agentTokenHash, ...safe } = config;
  return { config: { ...safe, agentPaired: !!agentTokenHash }, agentOnline, ledgerMap };
}

export async function updateTallySettings(user: AuthUser, patch: Record<string, unknown>) {
  const updated = await updateTallyConfig(user, patch);
  // A freshly enabled sync should start building without waiting for the cron.
  if (patch.syncEnabled === true) await enqueue(JobName.TALLY_BUILD_VOUCHERS, {}).catch(() => undefined);
  const { agentTokenHash, ...safe } = updated;
  return { ...safe, agentPaired: !!agentTokenHash };
}

export async function updateLedgerMap(rows: Array<{ id: string; tallyLedgerName: string; tallyParentGroup?: string | null; notes?: string | null }>) {
  await prisma.$transaction(
    rows.map((r) =>
      prisma.tallyLedgerMap.update({
        where: { id: r.id },
        data: {
          tallyLedgerName: r.tallyLedgerName.trim(),
          tallyParentGroup: r.tallyParentGroup?.trim() || null,
          notes: r.notes?.trim() || null,
          validatedAt: null, // a changed name needs re-validating against Tally
        },
      }),
    ),
  );
  // Rebuild anything that failed on a missing/renamed ledger.
  await enqueue(JobName.TALLY_BUILD_VOUCHERS, {}).catch(() => undefined);
  return getLedgerMap();
}

export async function listQueue(query: { page?: number; limit?: number; status?: TallySyncStatus; entityType?: string; search?: string }) {
  const where: Prisma.TallySyncQueueWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.entityType ? { entityType: query.entityType as never } : {}),
    ...(query.search
      ? { OR: [{ docNumber: { contains: query.search, mode: 'insensitive' } }, { partyName: { contains: query.search, mode: 'insensitive' } }] }
      : {}),
  };
  const { skip, take } = toSkipTake({ page: query.page ?? 1, limit: query.limit ?? 25 });
  const [rows, total, byStatus] = await Promise.all([
    prisma.tallySyncQueue.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.tallySyncQueue.count({ where }),
    prisma.tallySyncQueue.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const counts = { PENDING: 0, SYNCED: 0, FAILED: 0, EXCLUDED: 0 } as Record<string, number>;
  for (const g of byStatus) counts[g.status] = g._count._all;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      voucherType: r.voucherType,
      status: r.status,
      docNumber: r.docNumber,
      partyName: r.partyName,
      amount: Number(r.amount),
      entityDate: r.entityDate,
      revision: r.revision,
      attempts: r.attempts,
      excludedReason: r.excludedReason,
      errorMessage: r.errorMessage,
      tallyVoucherId: r.tallyVoucherId,
      isReady: r.status === TallySyncStatus.PENDING && r.payloadJson != null,
      syncedAt: r.syncedAt,
      updatedAt: r.updatedAt,
    })),
    counts,
    meta: buildPaginationMeta({ page: query.page ?? 1, limit: query.limit ?? 25 }, total),
  };
}

export async function retryQueueItem(id: string) {
  const row = await prisma.tallySyncQueue.findUnique({ where: { id } });
  if (!row) throw AppError.notFound('Queue item not found');
  if (row.status === TallySyncStatus.EXCLUDED) throw AppError.invalidState('An excluded entry is not synced by design and cannot be retried');
  if (row.status === TallySyncStatus.SYNCED) throw AppError.invalidState('This voucher is already in Tally');
  await prisma.tallySyncQueue.update({
    where: { id },
    data: { status: TallySyncStatus.PENDING, payloadJson: Prisma.DbNull, errorMessage: null, attempts: 0, lastAttemptAt: null },
  });
  await enqueue(JobName.TALLY_BUILD_VOUCHERS, {}).catch(() => undefined);
  return { retried: true };
}

/** Generate a fresh agent pairing token. Returned in plaintext ONCE. */
export async function rotateAgentToken(user: AuthUser) {
  const token = `mea_${crypto.randomBytes(24).toString('hex')}`;
  await updateTallyConfig(user, {}); // ensure row
  await prisma.tallyConfig.update({ where: { id: 'singleton' }, data: { agentTokenHash: await bcrypt.hash(token, 10), updatedById: user.id } });
  return { token };
}

// ─────────────────────────────── AGENT ────────────────────────────────────────

/** Verify an agent bearer token. Returns true or throws 401. */
export async function assertAgentToken(token: string | null): Promise<void> {
  if (!token) throw AppError.unauthorized('Missing agent token');
  const cfg = await prisma.tallyConfig.findUnique({ where: { id: 'singleton' }, select: { agentTokenHash: true } });
  if (!cfg?.agentTokenHash || !(await bcrypt.compare(token, cfg.agentTokenHash))) {
    throw AppError.unauthorized('Invalid agent token');
  }
}

export async function agentHeartbeat(input: { label?: string; tallyCompanyName?: string }) {
  await prisma.tallyConfig.update({
    where: { id: 'singleton' },
    data: {
      agentLastSeenAt: new Date(),
      ...(input.label ? { agentLabel: input.label } : {}),
      ...(input.tallyCompanyName ? { tallyCompanyName: input.tallyCompanyName } : {}),
    },
  });
  return { ok: true };
}

/** Hand the agent a batch of built, un-pushed vouchers. */
export async function agentPending(limit: number) {
  await prisma.tallyConfig.update({ where: { id: 'singleton' }, data: { agentLastSeenAt: new Date() } }).catch(() => undefined);
  const rows = await prisma.tallySyncQueue.findMany({
    where: { status: TallySyncStatus.PENDING, payloadJson: { not: Prisma.DbNull } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  if (rows.length) {
    await prisma.tallySyncQueue.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
    });
  }
  return rows.map((r) => ({ id: r.id, dedupKey: r.dedupKey, revision: r.revision, payload: r.payloadJson }));
}

/**
 * Ledgers the agent may create directly in Tally — only when the owner has
 * turned `autoProvisionLedgers` on, and never the GST duty ledgers (see the
 * schema comment on that flag for why).
 */
export async function agentLedgersPending() {
  const cfg = await prisma.tallyConfig.findUnique({ where: { id: 'singleton' }, select: { autoProvisionLedgers: true } });
  if (!cfg?.autoProvisionLedgers) return [];

  const rows = await prisma.tallyLedgerMap.findMany({
    where: { validatedAt: null, slot: { not: 'GST' } },
    orderBy: { slot: 'asc' },
  });
  if (!rows.length) return [];

  const outletIds = rows.filter((r) => r.slot === 'PARTY_OUTLET').map((r) => r.slotKey);
  const supplierIds = rows.filter((r) => r.slot === 'PARTY_SUPPLIER').map((r) => r.slotKey);
  const [outlets, suppliers] = await Promise.all([
    outletIds.length
      ? prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, gstin: true, address: true, phone: true } })
      : [],
    supplierIds.length
      ? prisma.contact.findMany({ where: { id: { in: supplierIds } }, select: { id: true, gstin: true, stateName: true, address: true, phone: true } })
      : [],
  ]);
  const outletById = new Map(outlets.map((o) => [o.id, o]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  return rows.map((r) => {
    let gstin: string | null = null;
    let state: string | null = null;
    let address: string | null = null;
    let phone: string | null = null;
    if (r.slot === 'PARTY_OUTLET') {
      const o = outletById.get(r.slotKey);
      if (o) { gstin = o.gstin; state = o.gstin ? 'Maharashtra' : null; address = o.address; phone = o.phone; }
    } else if (r.slot === 'PARTY_SUPPLIER') {
      const s = supplierById.get(r.slotKey);
      if (s) { gstin = s.gstin; state = s.stateName; address = s.address; phone = s.phone; }
    }
    return {
      id: r.id,
      name: r.tallyLedgerName,
      parentGroup: r.tallyParentGroup || (r.slot === 'PARTY_OUTLET' ? 'Sundry Debtors' : r.slot === 'PARTY_SUPPLIER' ? 'Sundry Creditors' : 'Primary'),
      isParty: r.slot === 'PARTY_OUTLET' || r.slot === 'PARTY_SUPPLIER',
      gstin, state, address, phone,
    };
  });
}

export async function agentReportLedgerResults(results: Array<{ id: string; status: 'CREATED' | 'EXISTS' | 'FAILED'; error?: string }>) {
  const ok = results.filter((r) => r.status !== 'FAILED');
  if (ok.length) {
    await prisma.tallyLedgerMap.updateMany({ where: { id: { in: ok.map((r) => r.id) } }, data: { validatedAt: new Date() } });
  }
  for (const r of results.filter((x) => x.status === 'FAILED')) {
    logger.warn({ ledgerMapId: r.id, error: r.error }, 'tally: ledger provisioning failed');
  }
  return { created: ok.length, failed: results.length - ok.length };
}

export async function agentReportResults(
  results: Array<{ id: string; status: 'SYNCED' | 'FAILED'; tallyVoucherId?: string; tallyResponse?: string; error?: string }>,
) {
  let synced = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'SYNCED') {
      await prisma.tallySyncQueue.update({
        where: { id: r.id },
        data: {
          status: TallySyncStatus.SYNCED,
          tallyVoucherId: r.tallyVoucherId ?? null,
          tallyResponse: r.tallyResponse?.slice(0, 8000) ?? null,
          errorMessage: null,
          syncedAt: new Date(),
        },
      }).catch((e) => logger.warn({ e, id: r.id }, 'tally: agent result (synced) — row gone?'));
      synced += 1;
    } else {
      await prisma.tallySyncQueue.update({
        where: { id: r.id },
        data: {
          status: TallySyncStatus.FAILED,
          errorMessage: r.error?.slice(0, 2000) ?? 'Tally rejected the voucher',
          tallyResponse: r.tallyResponse?.slice(0, 8000) ?? null,
        },
      }).catch((e) => logger.warn({ e, id: r.id }, 'tally: agent result (failed) — row gone?'));
      failed += 1;
    }
  }
  return { synced, failed };
}

export const tallyService = {
  getTallySettings, updateTallySettings, updateLedgerMap, listQueue, retryQueueItem, rotateAgentToken,
  assertAgentToken, agentHeartbeat, agentPending, agentReportResults,
  agentLedgersPending, agentReportLedgerResults,
};
