'use client';

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { AlertTriangle, ChevronRight, Receipt, Ban, ReceiptText, Clock, Search, Printer, ArrowUpDown, Store, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { cn, formatINR } from '@/lib/utils';
import { useRevenueTrend, useTopProducts, useFinancial, useOutletPerformance, useInventoryAnalytics, usePosAnalytics, type TrendPeriod, type PosAnalyticsRange } from '@/hooks/useAnalytics';
import { useOutlets } from '@/hooks/useOutlets';
import { TrendingUp, Wallet, BadgeIndianRupee } from 'lucide-react';
import { OutletDetailDialog } from '@/components/analytics/outlet-detail-dialog';
import { useAuthStore } from '@/store/auth.store';
import { printAnalyticsPaymentModeReport } from '@/lib/receipt-print';

type Tab = 'sales' | 'pos' | 'outlets' | 'inventory' | 'financial';

// Store-wide tabs (Sales trend, Outlets, Inventory, Financial P&L) hit
// super-admin-only endpoints — a franchise owner only ever sees their own
// outlet's POS collections, so they get just that one tab, no picker at all.
const ALL_TABS = [['sales', 'Sales'], ['pos', 'POS'], ['outlets', 'Outlets'], ['inventory', 'Inventory'], ['financial', 'Financial P&L']] as const;

export default function AnalyticsPage() {
  const role = useAuthStore((s) => s.user?.role);
  const isOwner = role === 'FRANCHISE_OWNER';
  const [tab, setTab] = useState<Tab>(isOwner ? 'pos' : 'sales');

  if (isOwner) {
    return (
      <div className="space-y-5">
        <PosDetail header={<p className="text-caption text-muted-foreground">Your outlet&apos;s POS collections.</p>} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex gap-2 border-b border-border">
        {ALL_TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={cn('border-b-2 px-4 py-2 text-body font-medium', tab === k ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>{l}</button>
        ))}
      </div>
      {tab === 'sales' && <SalesTab />}
      {tab === 'pos' && <PosTab />}
      {tab === 'outlets' && <OutletsTab />}
      {tab === 'inventory' && <InventoryTab />}
      {tab === 'financial' && <FinancialTab />}
    </div>
  );
}

function SalesTab() {
  const [period, setPeriod] = useState<TrendPeriod>('monthly');
  const { data: trend, isLoading } = useRevenueTrend(period);
  const { data: top } = useTopProducts();
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Revenue Trend</CardTitle>
          <div className="flex flex-wrap gap-1">
            {(['daily', 'weekly', 'monthly'] as const).map((p) => (
              <button key={p} onClick={() => setPeriod(p)} className={cn('rounded-md px-3 py-1 text-caption font-medium capitalize', period === p ? 'bg-primary text-primary-foreground' : 'bg-surface')}>{p}</button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading || !trend ? <Skeleton className="h-72" /> : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: '#6B7280' }} />
                <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} />
                <Tooltip formatter={(v: number) => formatINR(v)} />
                <Legend />
                <Line type="monotone" dataKey="pos" name="POS" stroke="#16A34A" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="billing" name="Billing" stroke="#D97706" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="total" name="Total" stroke="#234CCE" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TopChart title="Top 10 by Revenue" data={(top?.byRevenue ?? []).map((d) => ({ name: d.name, value: d.revenue }))} money />
        <TopChart title="Top 10 by Quantity" data={(top?.byQuantity ?? []).map((d) => ({ name: d.name, value: d.qty }))} />
      </div>
    </div>
  );
}

function TopChart({ title, data, money }: { title: string; data: Array<{ name: string; value: number }>; money?: boolean }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {!data.length ? <p className="py-8 text-center text-muted-foreground">No data</p> : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data} layout="vertical" margin={{ left: 30 }}>
              <XAxis type="number" tick={{ fontSize: 11, fill: '#6B7280' }} tickFormatter={(v) => (money ? `₹${v}` : `${v}`)} />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: '#6B7280' }} />
              <Tooltip formatter={(v: number) => (money ? formatINR(v) : v)} />
              <Bar dataKey="value" fill="#234CCE" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Admin POS tab: pick an outlet (or the main-branch till), then drill into its
 * full analytics. A franchise owner never reaches here — they get PosDetail for
 * their own outlet directly.
 */
function PosTab() {
  const { data: outlets } = useOutlets();
  const [scope, setScope] = useState<{ id: string | 'main'; name: string } | null>(null);

  if (scope) {
    return (
      <PosDetail
        outletId={scope.id}
        header={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setScope(null)}><ArrowLeft className="h-4 w-4" /> All outlets</Button>
            <div>
              <p className="text-body font-semibold">{scope.name}</p>
              <p className="text-caption text-muted-foreground">POS analytics</p>
            </div>
          </div>
        }
      />
    );
  }

  const active = (outlets ?? []).filter((o) => o.isActive);
  return (
    <div className="space-y-3">
      <p className="text-caption text-muted-foreground">Choose a till to see its full POS analytics — sales trend, peak hours, top-selling items, payment mix and cashier performance.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Main-branch till (SUPER_ADMIN sells here directly). */}
        <PosOutletCard name="Main Branch" sub="Head-office till" onClick={() => setScope({ id: 'main', name: 'Main Branch' })} />
        {active.map((o) => (
          <PosOutletCard key={o.id} name={o.name} sub={o.code} onClick={() => setScope({ id: o.id, name: o.name })} />
        ))}
      </div>
    </div>
  );
}

function PosOutletCard({ name, sub, onClick }: { name: string; sub: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:border-primary/50 hover:shadow-md active:scale-[0.99]"
    >
      <span className="flex items-center gap-3 min-w-0">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Store className="h-5 w-5" /></span>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{name}</span>
          <span className="block truncate text-caption text-muted-foreground">{sub}</span>
        </span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function PosDetail({ outletId, header }: { outletId?: string | 'main'; header?: React.ReactNode }) {
  const [range, setRange] = useState<PosAnalyticsRange>({});
  const { data, isLoading } = usePosAnalytics(outletId, true, range);

  // Header (back button + outlet name) and the date filter share one row,
  // right-aligned — and stay visible through loading/refetches instead of
  // vanishing behind the skeleton below.
  const topRow = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {header ?? <div />}
      <DateRangeFilter range={range} onChange={setRange} />
    </div>
  );

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        {topRow}
        <Skeleton className="h-72" />
      </div>
    );
  }
  const { summary } = data;
  const peakHour = data.byHour.reduce((best, h) => (h.revenue > best.revenue ? h : best), data.byHour[0]);
  const fmtHour = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
  // Dynamic period labels: once a filter is applied every drill-down section
  // below shares this exact range instead of its own historical default.
  const applied = data.appliedRange;
  const dailyLabel = applied ? `${applied.from} to ${applied.to}` : 'last 30 days';
  const pmLabel = applied ? `${applied.from} to ${applied.to}` : 'this month';
  const monthlyTotal = data.monthly.reduce((sum, m) => sum + m.revenue, 0);

  return (
    <div className="space-y-4">
      {topRow}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <KpiCard label="Today's POS Sales" value={formatINR(summary.todayRevenue, { decimals: false })} icon={Receipt} accent="primary" />
        <KpiCard label="This Month" value={formatINR(summary.monthRevenue, { decimals: false })} icon={TrendingUp} accent="success" />
        <KpiCard label="Last Month" value={formatINR(summary.lastMonthRevenue, { decimals: false })} icon={TrendingUp} accent="primary" />
        <KpiCard label="This Year" value={formatINR(summary.yearRevenue, { decimals: false })} icon={BadgeIndianRupee} accent="success" />
        <KpiCard label="Transactions (mo)" value={String(summary.monthTransactions)} icon={ReceiptText} accent="primary" />
        <KpiCard label="Avg Bill Value" value={formatINR(summary.avgBillValue, { decimals: false })} icon={BadgeIndianRupee} accent="warning" />
        <KpiCard label="Voided (mo)" value={`${summary.monthVoids} · ${formatINR(summary.monthVoidedAmount, { decimals: false })}`} icon={Ban} accent="danger" />
      </div>

      <Card>
        <CardHeader><CardTitle>Daily POS Sales — {dailyLabel}</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.daily} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6B7280' }} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis yAxisId="revenue" tick={{ fontSize: 11, fill: '#6B7280' }} />
              <YAxis yAxisId="txns" orientation="right" tick={{ fontSize: 11, fill: '#6B7280' }} />
              <Tooltip
                formatter={(v: number, name: string) => (name === 'Revenue' ? formatINR(v) : v)}
                labelFormatter={(d: string) => d}
              />
              <Legend />
              <Bar yAxisId="revenue" dataKey="revenue" name="Revenue" fill="#234CCE" radius={[4, 4, 0, 0]} />
              <Line yAxisId="txns" type="monotone" dataKey="transactions" name="Transactions" stroke="#16A34A" strokeWidth={2} dot={false} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <DailyPosTable rows={data.daily} periodLabel={dailyLabel} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
        <Card className="overflow-hidden">
          <CardHeader className="py-3"><CardTitle className="text-body">Monthly POS Sales (last 12 months)</CardTitle></CardHeader>
          <Table className="text-caption">
            <THead><TR><TH className="h-7 px-3 py-1">Month</TH><TH className="h-7 px-3 py-1 text-right">Sale</TH></TR></THead>
            <TBody>
              {data.monthly.map((m) => (
                <TR key={m.month}>
                  <TD className="px-3 py-1 font-medium">{m.month}</TD>
                  <TD className="px-3 py-1 text-right">{formatINR(m.revenue, { decimals: false })}</TD>
                </TR>
              ))}
              <TR className="bg-surface font-bold">
                <TD className="px-3 py-1">Total</TD>
                <TD className="px-3 py-1 text-right">{formatINR(monthlyTotal, { decimals: false })}</TD>
              </TR>
            </TBody>
          </Table>
        </Card>

        <Card>
          <CardHeader className="py-3"><CardTitle className="text-body">Monthly POS Sales — Trend</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={340}>
              <BarChart data={data.monthly} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#6B7280' }} tickFormatter={(m: string) => m.split(' ')[0]} />
                <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} />
                <Tooltip formatter={(v: number) => formatINR(v)} labelFormatter={(m: string) => m} />
                <Bar dataKey="revenue" name="Revenue" fill="#234CCE" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TopChart title="Top 10 POS Items by Revenue" data={data.topByRevenue.map((d) => ({ name: d.name, value: d.revenue }))} money />
        <TopChart title="Top 10 POS Items by Quantity Sold" data={data.topByQty.map((d) => ({ name: d.name, value: d.qty }))} />
      </div>

      <ItemWiseReport rows={data.itemsReport} paymentModeRows={data.byPaymentMode} periodLabel={dailyLabel} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Payment Mode Mix ({pmLabel})</CardTitle></CardHeader>
          <CardContent>
            {!data.byPaymentMode.length ? <p className="py-8 text-center text-muted-foreground">No data</p> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.byPaymentMode} layout="vertical" margin={{ left: 20 }}>
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#6B7280' }} tickFormatter={(v) => `₹${v}`} />
                  <YAxis type="category" dataKey="mode" width={80} tick={{ fontSize: 11, fill: '#6B7280' }} />
                  <Tooltip formatter={(v: number) => formatINR(v)} />
                  <Bar dataKey="revenue" fill="#D97706" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Sales by Hour of Day ({dailyLabel})</CardTitle>
            {peakHour?.revenue > 0 && <span className="flex items-center gap-1 text-caption text-muted-foreground"><Clock className="h-3.5 w-3.5" /> Peak: {fmtHour(peakHour.hour)}</span>}
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.byHour} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                <XAxis dataKey="hour" tick={{ fontSize: 10, fill: '#6B7280' }} tickFormatter={fmtHour} interval={2} />
                <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} />
                <Tooltip formatter={(v: number) => formatINR(v)} labelFormatter={(h: number) => fmtHour(h)} />
                <Bar dataKey="revenue" fill="#234CCE" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {data.byCashier.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader><CardTitle>Cashier Leaderboard ({pmLabel})</CardTitle></CardHeader>
          <Table>
            <THead><TR><TH>Cashier</TH><TH className="text-right">Transactions</TH><TH className="text-right">Revenue</TH><TH className="text-right">Avg Bill</TH></TR></THead>
            <TBody>
              {data.byCashier.map((c) => (
                <TR key={c.cashier}>
                  <TD className="font-medium">{c.cashier}</TD>
                  <TD className="text-right">{c.transactions}</TD>
                  <TD className="text-right font-semibold">{formatINR(c.revenue)}</TD>
                  <TD className="text-right text-muted-foreground">{formatINR(c.transactions > 0 ? c.revenue / c.transactions : 0)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

/** From/To date-range filter driving every POS drill-down section at once. */
function DateRangeFilter({ range, onChange }: { range: PosAnalyticsRange; onChange: (r: PosAnalyticsRange) => void }) {
  const active = !!(range.from || range.to);
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5">
      <span className="text-caption font-medium text-muted-foreground">Date filter</span>
      <Input type="date" className="h-8 w-[142px] pl-2 pr-1 text-caption" value={range.from ?? ''} max={range.to} onChange={(e) => onChange({ ...range, from: e.target.value || undefined })} />
      <span className="text-caption text-muted-foreground">–</span>
      <Input type="date" className="h-8 w-[142px] pl-2 pr-1 text-caption" value={range.to ?? ''} min={range.from} onChange={(e) => onChange({ ...range, to: e.target.value || undefined })} />
      {active && <Button variant="secondary" size="sm" className="h-8 px-2 text-caption" onClick={() => onChange({})}>Clear</Button>}
    </div>
  );
}

/**
 * Day-by-day counter sheet — the numbers a shop actually reconciles against at
 * close: how many tokens the till issued, how many sales completed, how many were
 * voided, and what was taken. The chart above shows the shape of the week; this
 * shows the figures.
 */
function DailyPosTable({ rows, periodLabel }: {
  rows: Array<{ date: string; revenue: number; transactions: number; itemsSold: number; voided: number; voidedAmount: number }>;
  periodLabel: string;
}) {
  // Zero-filled days pad the chart nicely but are noise in a table you're reading
  // down, so days the till never opened are dropped.
  const active = rows.filter((r) => r.transactions > 0 || r.voided > 0);
  const total = active.reduce(
    (t, r) => ({
      tokens: t.tokens + r.transactions + r.voided,
      transactions: t.transactions + r.transactions,
      itemsSold: t.itemsSold + r.itemsSold,
      revenue: t.revenue + r.revenue,
      voided: t.voided + r.voided,
    }),
    { tokens: 0, transactions: 0, itemsSold: 0, revenue: 0, voided: 0 },
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-1 py-3">
        <CardTitle className="text-body">Day-wise POS Report — {periodLabel}</CardTitle>
        <p className="text-caption text-muted-foreground">
          Every sale takes a token, so tokens issued counts completed and voided bills together.
        </p>
      </CardHeader>
      {!active.length ? (
        <p className="py-10 text-center text-body text-muted-foreground">No sales in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table className="text-caption">
            <THead>
              <TR>
                <TH className="px-3">Date</TH>
                <TH className="px-3 text-right">Tokens issued</TH>
                <TH className="px-3 text-right">Bills completed</TH>
                <TH className="px-3 text-right">Items sold</TH>
                <TH className="px-3 text-right">Voided</TH>
                <TH className="px-3 text-right">Avg bill</TH>
                <TH className="px-3 text-right">Collection</TH>
              </TR>
            </THead>
            <TBody>
              {active.map((r) => (
                <TR key={r.date}>
                  <TD className="whitespace-nowrap px-3 font-medium">{r.date}</TD>
                  <TD className="px-3 text-right tabular-nums">{r.transactions + r.voided}</TD>
                  <TD className="px-3 text-right tabular-nums">{r.transactions}</TD>
                  <TD className="px-3 text-right tabular-nums">{r.itemsSold}</TD>
                  <TD className={cn('px-3 text-right tabular-nums', r.voided > 0 && 'text-danger')}>
                    {r.voided > 0 ? `${r.voided} · ${formatINR(r.voidedAmount, { decimals: false })}` : '—'}
                  </TD>
                  <TD className="px-3 text-right tabular-nums">
                    {r.transactions > 0 ? formatINR(r.revenue / r.transactions, { decimals: false }) : '—'}
                  </TD>
                  <TD className="px-3 text-right font-semibold tabular-nums">{formatINR(r.revenue, { decimals: false })}</TD>
                </TR>
              ))}
              <TR className="bg-surface font-bold">
                <TD className="px-3">Total · {active.length} day{active.length === 1 ? '' : 's'}</TD>
                <TD className="px-3 text-right tabular-nums">{total.tokens}</TD>
                <TD className="px-3 text-right tabular-nums">{total.transactions}</TD>
                <TD className="px-3 text-right tabular-nums">{total.itemsSold}</TD>
                <TD className="px-3 text-right tabular-nums">{total.voided || '—'}</TD>
                <TD className="px-3 text-right tabular-nums">
                  {total.transactions > 0 ? formatINR(total.revenue / total.transactions, { decimals: false }) : '—'}
                </TD>
                <TD className="px-3 text-right tabular-nums">{formatINR(total.revenue, { decimals: false })}</TD>
              </TR>
            </TBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

type ItemSortKey = 'revenue' | 'qty' | 'name';

/** Full item-wise sales report — every item sold over the resolved period, searchable, sortable. */
function ItemWiseReport({ rows, paymentModeRows, periodLabel }: {
  rows: Array<{ name: string; category: string; qty: number; revenue: number; avgPrice: number; revenueSharePct: number }>;
  paymentModeRows: Array<{ mode: string; transactions: number; revenue: number }>;
  periodLabel: string;
}) {
  const userName = useAuthStore((s) => s.user?.name);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<ItemSortKey>('revenue');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)) : rows;
    return [...list].sort((a, b) => (sortKey === 'name' ? a.name.localeCompare(b.name) : b[sortKey] - a[sortKey]));
  }, [rows, search, sortKey]);

  // The printed report is payment-mode-wise (Cash/Card/UPI: method, orders,
  // total) rather than item-wise — the on-screen table below stays item-wise
  // for browsing, but that's not what goes to paper.
  const printReport = () => {
    printAnalyticsPaymentModeReport(paymentModeRows, { periodLabel: `${periodLabel} (POS sales)`, generatedBy: userName });
    toast.success('Printing payment mode report…');
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Item-wise Sales Report</CardTitle>
          <p className="mt-1 text-caption text-muted-foreground">Every item sold — {periodLabel} — {rows.length} distinct item{rows.length === 1 ? '' : 's'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search item or category…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button variant="secondary" size="sm" onClick={printReport} disabled={!paymentModeRows.length}>
            <Printer className="h-3.5 w-3.5" /> Print Payment Report
          </Button>
        </div>
      </CardHeader>
      {!filtered.length ? (
        <p className="py-10 text-center text-muted-foreground">{rows.length ? 'No items match your search.' : `No POS sales — ${periodLabel}.`}</p>
      ) : (
        <div className="max-h-[70vh] overflow-y-auto scrollbar-thin">
          <Table>
            <THead>
              <TR>
                <SortableTH label="Item" active={sortKey === 'name'} onClick={() => setSortKey('name')} />
                <TH>Category</TH>
                <SortableTH label="Qty Sold" active={sortKey === 'qty'} onClick={() => setSortKey('qty')} align="right" />
                <SortableTH label="Revenue" active={sortKey === 'revenue'} onClick={() => setSortKey('revenue')} align="right" />
                <TH className="text-right">Avg Price</TH>
                <TH className="text-right">Share</TH>
              </TR>
            </THead>
            <TBody>
              {filtered.map((r) => (
                <TR key={r.name}>
                  <TD className="font-medium">{r.name}</TD>
                  <TD className="text-muted-foreground">{r.category}</TD>
                  <TD className="text-right">{r.qty}</TD>
                  <TD className="text-right font-semibold">{formatINR(r.revenue)}</TD>
                  <TD className="text-right text-muted-foreground">{formatINR(r.avgPrice)}</TD>
                  <TD className="text-right text-muted-foreground">{r.revenueSharePct}%</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function SortableTH({ label, active, onClick, align }: { label: string; active: boolean; onClick: () => void; align?: 'right' }) {
  return (
    <TH className={cn(align === 'right' && 'text-right')}>
      <button type="button" onClick={onClick} className={cn('inline-flex items-center gap-1 hover:text-foreground', align === 'right' && 'flex-row-reverse', active && 'text-foreground')}>
        {label} <ArrowUpDown className="h-3 w-3" />
      </button>
    </TH>
  );
}

function OutletsTab() {
  const { data, isLoading } = useOutletPerformance();
  const [selected, setSelected] = useState<string | null>(null);
  if (isLoading) return <Skeleton className="h-72" />;
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>Outlet Performance</CardTitle>
        <p className="text-caption text-muted-foreground">Click an outlet for a month-by-month deep dive.</p>
      </CardHeader>
      <Table>
        <THead><TR><TH>Outlet</TH><TH className="text-right">Orders</TH><TH className="text-right">Billed</TH><TH className="text-right">Paid</TH><TH className="text-right">Outstanding</TH><TH /></TR></THead>
        <TBody>
          {data?.map((o) => (
            <TR key={o.outlet_id} className="cursor-pointer" onClick={() => setSelected(o.outlet_id)}>
              <TD className="font-medium text-primary">{o.outlet_name}</TD>
              <TD className="text-right">{o.total_orders}</TD>
              <TD className="text-right">{formatINR(o.total_billed)}</TD>
              <TD className="text-right text-success">{formatINR(o.total_paid)}</TD>
              <TD className="text-right text-warning">{formatINR(o.outstanding)}</TD>
              <TD className="text-right"><ChevronRight className="h-4 w-4 text-muted-foreground" /></TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <OutletDetailDialog outletId={selected} onClose={() => setSelected(null)} />
    </Card>
  );
}

function InventoryTab() {
  const { data, isLoading } = useInventoryAnalytics();
  if (isLoading || !data) return <Skeleton className="h-72" />;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Low Stock Alerts</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {!data.lowStock.length ? <p className="text-muted-foreground">All stock levels healthy 🎉</p> : data.lowStock.map((s, i) => (
            <div key={i} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 text-danger" />{s.name}</span>
              <span className="text-caption text-muted-foreground">{s.location} · {s.quantity} / {s.reorder}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Slow-moving (no sales 30d)</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {!data.slowMoving.length ? <p className="text-muted-foreground">None — everything is selling.</p> : data.slowMoving.map((n) => <Badge key={n} variant="neutral">{n}</Badge>)}
        </CardContent>
      </Card>
    </div>
  );
}

function FinancialTab() {
  const { data, isLoading } = useFinancial();
  if (isLoading || !data) return <Skeleton className="h-72" />;
  const c = data.current;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <KpiCard label="Revenue (mo)" value={formatINR(c?.total_revenue ?? 0, { decimals: false })} icon={TrendingUp} accent="primary" />
        <KpiCard label="COGS (mo)" value={formatINR(c?.cogs ?? 0, { decimals: false })} icon={BadgeIndianRupee} accent="warning" />
        <KpiCard label="Gross Profit" value={formatINR(c?.gross_profit ?? 0, { decimals: false })} icon={Wallet} accent="success" />
        <KpiCard label="Net Profit" value={formatINR(c?.net_profit ?? 0, { decimals: false })} icon={Wallet} accent={(c?.net_profit ?? 0) >= 0 ? 'success' : 'danger'} />
      </div>
      <Card>
        <CardHeader><CardTitle>Monthly P&L</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.monthly} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#6B7280' }} />
              <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} />
              <Tooltip formatter={(v: number) => formatINR(v)} />
              <Legend />
              <Bar dataKey="total_revenue" name="Revenue" fill="#234CCE" radius={[4, 4, 0, 0]} />
              <Bar dataKey="expenses" name="Expenses" fill="#D97706" radius={[4, 4, 0, 0]} />
              <Bar dataKey="net_profit" name="Net Profit" fill="#16A34A" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
