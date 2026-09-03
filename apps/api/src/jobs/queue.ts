import PgBoss from 'pg-boss';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { IST_TZ } from '../config/timezone';

export const JobName = {
  REFRESH_ANALYTICS: 'refresh-analytics-views',
  GENERATE_BILL_PDF: 'generate-bill-pdf',
  SUPPLIER_BILL_REMINDERS: 'supplier-bill-reminders',
  POS_SESSION_ROLLOVER: 'pos-session-rollover',
  SERVER_METRICS_SAMPLE: 'server-metrics-sample',
  TALLY_BUILD_VOUCHERS: 'tally-build-vouchers',
} as const;

export type JobNameValue = (typeof JobName)[keyof typeof JobName];

let boss: PgBoss | null = null;

export function getBoss(): PgBoss {
  if (!boss) throw new Error('pg-boss not started — call startJobs() first');
  return boss;
}

/** Enqueue a job (no-op safe before boss starts is avoided by getBoss throw). */
export async function enqueue<T extends object>(name: JobNameValue, data: T): Promise<string | null> {
  return getBoss().send(name, data);
}

/**
 * Start pg-boss, ensure queues exist, register workers, and schedule the
 * recurring materialized-view refresh (every 15 min by default).
 */
export async function startJobs(): Promise<void> {
  // pg-boss defaults to its own 10-connection pool (node-postgres's default),
  // entirely uncoordinated with Prisma's pool — both draw from the same managed
  // Postgres max_connections ceiling. Our job volume here is light (a handful of
  // scheduled/queued jobs, not high-throughput queueing), so cap it explicitly
  // and leave the bulk of the connection budget to the API's own Prisma pool.
  boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'pgboss', max: env.DB_POOL_SIZE_PGBOSS });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();

  for (const name of Object.values(JobName)) {
    await boss.createQueue(name);
  }

  // Lazy-load handlers to avoid circular imports with feature modules.
  const { refreshAnalyticsHandler } = await import('./handlers/refreshAnalytics');
  const { generateBillPdfHandler } = await import('./handlers/generateBillPdf');
  const { supplierBillRemindersHandler } = await import('./handlers/supplierBillReminders');
  const { dailySessionRolloverHandler } = await import('./handlers/dailySessionRollover');
  const { serverMetricsSampleHandler } = await import('./handlers/serverMetricsSample');
  const { tallyBuildVouchersHandler } = await import('./handlers/tallyBuildVouchers');

  await boss.work(JobName.REFRESH_ANALYTICS, refreshAnalyticsHandler);
  await boss.work(JobName.GENERATE_BILL_PDF, generateBillPdfHandler);
  await boss.work(JobName.SUPPLIER_BILL_REMINDERS, supplierBillRemindersHandler);
  await boss.work(JobName.POS_SESSION_ROLLOVER, dailySessionRolloverHandler);
  await boss.work(JobName.SERVER_METRICS_SAMPLE, serverMetricsSampleHandler);
  await boss.work(JobName.TALLY_BUILD_VOUCHERS, tallyBuildVouchersHandler);

  // Schedule recurring analytics refresh + daily supplier-bill due-date sweep.
  // The two interval schedules (*/15, */5) are timezone-agnostic; the ones with a
  // wall-clock hour are pinned to IST so "8am" and "midnight" mean the business's,
  // not the server's — a UTC droplet would otherwise fire them at 13:30 and 05:30.
  await boss.schedule(JobName.REFRESH_ANALYTICS, env.MATERIALIZED_VIEW_REFRESH_CRON, {});
  await boss.schedule(JobName.SUPPLIER_BILL_REMINDERS, env.SUPPLIER_BILL_REMINDER_CRON, {}, { tz: IST_TZ });
  await boss.schedule(JobName.POS_SESSION_ROLLOVER, env.POS_SESSION_ROLLOVER_CRON, {}, { tz: IST_TZ });
  // Whole-server telemetry for the developer console (one tiny row per run).
  await boss.schedule(JobName.SERVER_METRICS_SAMPLE, env.SERVER_METRICS_SAMPLE_CRON, {});
  // Turn PENDING Tally-sync rows into validated vouchers — cheap no-op when the
  // sync is off or the queue is empty.
  await boss.schedule(JobName.TALLY_BUILD_VOUCHERS, '* * * * *', {});

  logger.info('pg-boss started (queues + scheduled jobs registered)');
}

export async function stopJobs(): Promise<void> {
  await boss?.stop({ graceful: true });
  boss = null;
}
