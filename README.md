# Mumbai ERP — Management System

Full-stack food manufacturing + franchise management: production (godown), inventory,
inter-branch transfers, franchise stock ordering, billing, payments (Razorpay + cash),
expenses, POS (with offline), analytics, and one-way accounting sync to **Tally Prime**.

> **Stack:** Next.js 14 · TypeScript · Tailwind · shadcn/ui · Zustand · React Query ·
> Express · Prisma · PostgreSQL 15 · Socket.IO (PG LISTEN/NOTIFY) · pg-boss · node-cache ·
> JWT · Razorpay · PDFKit. **No Redis** — Postgres is the only infrastructure dependency.

> **This project is a fresh clone** of an earlier system, re-provisioned for a new
> client (Mumbai, Maharashtra). It runs on its **own isolated database** — Docker
> container `mumbai_erp_postgres`, host port **5434**, database `mumbai_erp`. It must
> never connect to the original project's database (`surat_food_chain`, port 5432).

---

## Monorepo layout

```
/                            npm workspaces root
├── apps/api                 Express + Prisma backend  (@mumbai-erp/api)
├── apps/web                 Next.js 14 frontend       (@mumbai-erp/web)
├── apps/android-print-bridge  Android WebView wrapper — Bluetooth ESC/POS
│                            receipt printing on tablets (see its README)
├── apps/print-agent-windows  Windows tray app — local ESC/POS printing
├── docker-compose.yml       Postgres 15 only (isolated stack: port 5434)
└── .env                     single source of truth (gitignored)
```

---

## Prerequisites

- **Node ≥ 20**, **npm ≥ 10**
- **Docker + Docker Compose** (for Postgres)

---

## Quick start

```bash
# 1. Install all workspace dependencies
npm install

# 2. Copy env template and fill values
cp .env.example .env

# 3. Start Postgres (isolated container mumbai_erp_postgres on port 5434)
npm run db:up

# 4. SAFETY CHECK — confirm DATABASE_URL points at port 5434 / mumbai_erp
grep DATABASE_URL .env

# 5. Apply migrations (schema + audit triggers + materialized views)
npm run prisma:migrate      # or: npm run -w @mumbai-erp/api prisma:deploy

# 6. Seed realistic sample data
npm run db:seed

# 7. Run API + web
npm run dev                  # API at http://localhost:4100, web at http://localhost:3100
```

One-shot bootstrap: `npm run bootstrap` (install → db:up → migrate → seed).

---

## Seed login credentials

| Role           | Email / User ID                                | Password      |
|----------------|------------------------------------------------|---------------|
| Super Admin    | `admin@mumbaierp.local` · `ADMIN001`            | `Admin@123`   |
| Godown Manager | `godown@mumbaierp.local` · `GODOWN001`          | `Godown@123`  |
| Franchise Owner| `owner.adajan@mumbaierp.local` · `OWNER001`     | `Owner@123`   |
| Cashier        | `cashier.adajan@mumbaierp.local` · `CASH001`    | `Cashier@123` |

Login accepts **either** the email **or** the user ID in a single field.
Change every seeded password before any real use.

---

## Environment variables

All config lives in the root `.env` (consumed by docker-compose, the API via `dotenv`,
and the web app). Validated at API startup with Zod — the server refuses to boot on
invalid config. See [.env.example](.env.example) for the full list. Key ones:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string — **must be port 5434 / mumbai_erp** |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | token signing (access 15m, refresh 30d) |
| `HOME_STATE_CODE` | GST home state — `27` (Maharashtra); confirm vs client GST cert |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | payments |
| `WEB_ORIGIN` | CORS + Socket.IO origin |
| `KPI_CACHE_TTL_SECONDS` | node-cache TTL for dashboard KPIs |
| `MATERIALIZED_VIEW_REFRESH_CRON` | pg-boss schedule for analytics refresh |

---

## API conventions

- **Base URL:** `http://localhost:4100/api/v1`
- **Success envelope:** `{ success: true, data, message, meta? }`
- **Error envelope:** `{ success: false, error: { code, message, field? } }`
- **Auth:** `Authorization: Bearer <accessToken>`; rotate via `POST /auth/refresh`.
- **Pagination:** `?page=&limit=` (default 25, max 100); `meta` carries totals.
- **Rate limits:** auth endpoints 5/min, write endpoints 30/min per IP.

---

## Database design highlights

- UUID PKs (`gen_random_uuid()`), `created_at`/`updated_at`, soft delete (`is_deleted`),
  `created_by` on every domain table. **No hard deletes** in this financial system.
- Money as `DECIMAL(12,2)`; tax rate `DECIMAL(5,2)`; fractional quantities `DECIMAL(12,4)`.
- Composite indexes on hot paths and **trigram GIN** indexes for fuzzy search (`pg_trgm`).
- **Shadow audit tables** for bills, payments, stock transfers, production batches —
  populated by DB triggers (`fn_record_audit`). The acting user is read from the
  transaction-local GUC `app.user_id`.
- **Materialized views** `mv_monthly_pl` and `mv_outlet_sales`, refreshed every 15 min by
  a pg-boss scheduled job (`refresh_analytics_views()`).
- Atomic, year-prefixed document numbers (`BL-2025-00001`, …) via `document_counters`.

### Migrations

```bash
npm run -w @mumbai-erp/api prisma:migrate   # dev: create + apply
npm run -w @mumbai-erp/api prisma:deploy    # prod: apply pending
npm run -w @mumbai-erp/api prisma:reset     # drop + re-migrate + re-seed (dev only)
npm run -w @mumbai-erp/api prisma:studio    # browse data
```

Advanced objects (triggers, materialized views, refresh function) live in
`apps/api/prisma/migrations/*_audit_and_views/migration.sql`.

---

## Real-time + background jobs (no Redis)

- **Real-time:** app writes call `pg_notify('mumbai_erp_events', …)`; a dedicated pg client
  `LISTEN`s and relays to Socket.IO rooms (`role:admin`, `outlet:<id>`).
- **Jobs:** pg-boss runs the analytics refresh schedule and async bill-PDF generation.

---

## Tally Prime accounting sync

One-way push only — data flows **from this ERP into Tally Prime**, never the reverse.
Sales, receipts, GST-registered purchases, expense payments and stock journals are
pushed as correctly structured double-entry vouchers via a local sync agent that runs
on the client's Tally machine. Non-GST purchases are recorded in the ERP only and are
**never** synced to the statutory books. See the project docs for the accounting
mapping, architecture and reliability design.
