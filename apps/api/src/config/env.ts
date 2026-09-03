// Must be first: pins the process to IST before any Date is constructed.
import './timezone';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Single source of truth: the monorepo-root .env. When the API runs (tsx/node)
// the cwd is apps/api, so the root is two levels up.
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
// Also allow a local apps/api/.env to override during isolated runs.
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  // Interface to bind. Set to 127.0.0.1 behind a reverse proxy so the API is not
  // exposed on a public interface; containers need the 0.0.0.0 default.
  API_HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // Comma-separated allow-list (e.g. Mac localhost + a LAN IP for tablets on
  // the same network) — a single value still works exactly as before.
  WEB_ORIGIN: z
    .string()
    .default('http://localhost:3100')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  RAZORPAY_KEY_ID: z.string().default('rzp_test_placeholder'),
  RAZORPAY_KEY_SECRET: z.string().default('placeholder_secret'),
  RAZORPAY_WEBHOOK_SECRET: z.string().default('placeholder_webhook_secret'),

  // GST: home state for CGST/SGST vs IGST, and GSTzen GSTIN-lookup provider.
  // 27 = Maharashtra (Mumbai). CONFIRM against the client's GST registration
  // certificate before go-live — the registered state, not the office city,
  // decides the CGST+SGST vs IGST split on every voucher pushed to Tally.
  HOME_STATE_CODE: z.string().default('27'), // Maharashtra
  GSTZEN_API_KEY: z.string().default(''),
  GSTZEN_API_URL: z.string().default('https://my.gstzen.in/api/gstin-validator/'),

  UPLOAD_DIR: z.string().default('uploads'),
  // Files that must never be served statically — bill PDFs carry customer GSTIN,
  // addresses and line items, and their filenames are guessable invoice numbers.
  PRIVATE_STORAGE_DIR: z.string().default('storage'),
  // 5MB used to be the default, but a modern phone/tablet camera photo (the
  // realistic source for a POS item photo) routinely runs 8-15MB, so that
  // limit was rejecting ordinary photos outright.
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(20),

  KPI_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // Prisma's own default pool size is derived from CPU count (small droplets get
  // as few as ~5), which starves the app under real concurrent traffic even though
  // individual queries are fast. Set explicitly rather than trusting the formula.
  // pg-boss keeps its own separate pool (see DB_POOL_SIZE_PGBOSS) — both share the
  // managed Postgres instance's max_connections ceiling, so keep the two numbers
  // (plus a little headroom for the LISTEN client and admin tools) under that limit.
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DB_POOL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(20),
  DB_POOL_SIZE_PGBOSS: z.coerce.number().int().positive().default(4),
  MATERIALIZED_VIEW_REFRESH_CRON: z.string().default('*/15 * * * *'),
  SUPPLIER_BILL_REMINDER_CRON: z.string().default('0 8 * * *'), // daily 8am: flags bills due in 10 or 5 days
  POS_SESSION_ROLLOVER_CRON: z.string().default('0 0 * * *'), // midnight IST: auto-close + reopen every open till

  // Whole-server telemetry for the developer console's hosting-cost view. The
  // sample itself is two in-process OS reads plus one small file read, so a
  // 5-minute cadence costs nothing; retention keeps the table a few thousand
  // rows at most. Interface defaults to the PUBLIC nic (eth0) because that is
  // what DigitalOcean's bandwidth billing counts — not the private-VPC eth1
  // the database connection uses.
  SERVER_METRICS_SAMPLE_CRON: z.string().default('*/5 * * * *'),
  SERVER_METRICS_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  SERVER_METRICS_NET_INTERFACE: z.string().default('eth0'),

  // Company letterhead details — FIRST-RUN FALLBACK ONLY. The live values are
  // maintained by the main owner in Settings → Business Profile (stored in
  // app_settings as COMPANY_PROFILE) and override everything below once saved.
  // See modules/settings/settings.service.ts → getCompanyProfile().
  COMPANY_NAME: z.string().default('Mumbai ERP'),
  COMPANY_TAGLINE: z.string().default('Mumbai ERP'),
  COMPANY_ADDRESS: z.string().default(''),
  COMPANY_PHONE: z.string().default(''),
  COMPANY_GSTIN: z.string().default(''),
  // Terms & Conditions printed at the foot of every sales invoice — pipe-separated,
  // one term per segment, numbered automatically. Placeholder wording — replace
  // with the Mumbai ERP client's actual terms (money amounts especially) before
  // relying on it, then override via env instead of editing code.
  COMPANY_TERMS: z.string().default(
    'Orders must be placed at least 2 days in advance with advance payment.'
    + '|Any changes to the order must be informed in advance.'
    + '|Cancelling a confirmed order will incur a cancellation charge.',
  ),

  // Passphrase that unlocks the hidden developer window (outlet management).
  // Set your own in production; the default only exists so local dev works.
  // requireDeveloperKey fails closed, so an empty value blocks all outlet writes.
  DEVELOPER_KEY: z.string().default('Developer'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast at startup — never boot with an invalid configuration.
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\n❌ Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
