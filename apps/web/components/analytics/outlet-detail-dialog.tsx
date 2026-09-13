'use client';

import { format } from 'date-fns';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { cn, formatINR, ist } from '@/lib/utils';
import { useOutletDetail } from '@/hooks/useAnalytics';

export function OutletDetailDialog({ outletId, onClose }: { outletId: string | null; onClose: () => void }) {
  const { data, isLoading } = useOutletDetail(outletId);

  return (
    <Dialog open={!!outletId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{data?.outlet.name ?? 'Outlet'} — Deep Dive</DialogTitle>
          <DialogDescription>{data ? `${data.outlet.code} · ${data.outlet.creditPeriodDays}-day credit` : 'Loading…'}</DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
        ) : (
          <div className="space-y-5">
            {/* Period comparison */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Compare title="This month" revenue={data.summary.thisMonth.billed} orders={data.summary.thisMonth.orders} />
              <Compare title="vs Last month" revenue={data.summary.lastMonth.billed} orders={data.summary.lastMonth.orders} pct={data.summary.momRevenuePct} />
              <Compare title="vs Same month last yr" revenue={data.summary.sameMonthLastYear.billed} orders={data.summary.sameMonthLastYear.orders} pct={data.summary.yoyRevenuePct} />
            </div>

            {/* Lifetime KPIs */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Kpi label="Lifetime Orders" value={String(data.summary.lifetimeOrders)} />
              <Kpi label="Total Billed" value={formatINR(data.summary.totalBilled, { decimals: false })} />
              <Kpi label="Total Paid" value={formatINR(data.summary.totalPaid, { decimals: false })} accent="success" />
              <Kpi label="Outstanding" value={formatINR(data.summary.outstanding, { decimals: false })} accent={data.summary.outstanding > 0 ? 'danger' : undefined} />
              <Kpi label="Avg Order Value" value={formatINR(data.summary.avgOrderValue, { decimals: false })} />
              <Kpi label="Avg Days to Pay" value={data.summary.avgDaysToPay != null ? `${data.summary.avgDaysToPay}d` : '—'} accent={data.summary.avgDaysToPay != null && data.summary.avgDaysToPay > data.outlet.creditPeriodDays ? 'danger' : undefined} />
            </div>

            {/* 12-month trend */}
            <div>
              <p className="mb-2 text-label font-semibold">Last 12 months — orders & revenue</p>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={data.monthly} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#6B7280' }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#6B7280' }} />
                  <YAxis yAxisId="right" orientation="right" allowDecimals={false} tick={{ fontSize: 11, fill: '#6B7280' }} />
                  <Tooltip formatter={(v: number, n: string) => (n === 'Orders' ? v : formatINR(v))} />
                  <Legend />
                  <Bar yAxisId="left" dataKey="billed" name="Billed" fill="#234CCE" radius={[4, 4, 0, 0]} />
                  <Bar yAxisId="left" dataKey="paid" name="Paid" fill="#16A34A" radius={[4, 4, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="orders" name="Orders" stroke="#D97706" strokeWidth={2} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Top products */}
            <div>
              <p className="mb-2 text-label font-semibold">What this outlet buys most</p>
              {!data.topProducts.length ? (
                <p className="py-4 text-center text-body text-muted-foreground">No purchases yet.</p>
              ) : (
                <Table>
                  <THead><TR><TH>Product</TH><TH className="text-right">Qty</TH><TH className="text-right">Value</TH></TR></THead>
                  <TBody>
                    {data.topProducts.map((p) => (
                      <TR key={p.name}><TD className="font-medium">{p.name}</TD><TD className="text-right">{p.qty}</TD><TD className="text-right">{formatINR(p.value)}</TD></TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>

            {data.summary.lastOrderDate && (
              <p className="text-caption text-muted-foreground">Last order: {format(ist(data.summary.lastOrderDate), 'dd MMM yyyy')}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Compare({ title, revenue, orders, pct }: { title: string; revenue: number; orders: number; pct?: number }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-caption uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-1 text-card-title font-bold leading-none">{formatINR(revenue, { decimals: false })}</p>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-caption text-muted-foreground">{orders} orders</span>
        {pct !== undefined && (
          <span className={cn('inline-flex items-center gap-0.5 text-caption font-semibold', pct >= 0 ? 'text-success' : 'text-danger')}>
            {pct >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}{Math.abs(pct)}%
          </span>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: 'success' | 'danger' }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-caption uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1 font-bold', accent === 'success' && 'text-success', accent === 'danger' && 'text-danger')}>{value}</p>
    </div>
  );
}
