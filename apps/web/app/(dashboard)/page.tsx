'use client';

import Link from 'next/link';
import { navForRole } from '@/components/shared/nav-config';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { IndianRupee, TrendingUp, Wallet, AlertTriangle, Trophy, ArrowUpRight, ArrowRight } from 'lucide-react';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboard } from '@/hooks/useDashboard';
import { useAuthStore } from '@/store/auth.store';
import { ORDER_STATUS_BADGE, ORDER_STATUS_LABEL, type OrderStatus } from '@/hooks/useOrders';
import { formatINR, ist } from '@/lib/utils';

export default function DashboardPage() {
  const { data, isLoading, isError, refetch } = useDashboard();
  const user = useAuthStore((s) => s.user);

  const shortcuts = user ? navForRole(user.role).filter((item) => ['/sales', '/purchases', '/inventory', '/payments'].includes(item.href)) : [];

  return (
    <div className="space-y-6">
      <section className="arthx-hero arthx-enter rounded-2xl px-6 py-8 text-white sm:px-8">
        <div className="relative z-10 flex flex-wrap items-end justify-between gap-6">
          <div><p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-blue-200">Business overview</p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Welcome back{user?.name ? `, ${user.name.split(' ')[0]}` : ''}.</h2>
            <p className="mt-3 max-w-lg text-sm leading-6 text-blue-100/80">Your operations, finances, and next steps. All in one place.</p>
          </div>
          <div className="border-l border-white/20 pl-5"><p className="text-[10px] uppercase tracking-[0.18em] text-blue-200">Your workspace</p><p className="mt-2 text-lg font-medium">Arthx <span className="font-light text-blue-200">/ ERP</span></p></div>
        </div>
      </section>
      {isError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/20 bg-danger/5 p-4 text-sm"><p>We couldn’t load your business overview. Please try again.</p><Button size="sm" variant="secondary" onClick={() => refetch()}>Try again</Button></div>}

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32" />)
        ) : (
          data ? <>
            <KpiCard label="Today's Sales" value={formatINR(data.todaySales, { decimals: false })} icon={IndianRupee} accent="success" />
            <KpiCard label="Revenue (This Month)" value={formatINR(data.monthRevenue, { decimals: false })} changePct={data.revenueChangePct} icon={TrendingUp} accent="primary" />
            <KpiCard label="Outstanding" value={formatINR(data.outstandingReceivables, { decimals: false })} icon={Wallet} accent="warning" href="/payments" />
            <KpiCard label="Low Stock Alerts" value={String(data.lowStockCount)} icon={AlertTriangle} accent="danger" href="/inventory" />
          </> : null
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Quick access</span>
        {shortcuts.map(({href,label,icon:Icon}) => <Link key={href} href={href} className="group flex items-center gap-2 rounded-lg border border-border bg-white px-4 py-2.5 text-xs font-medium text-slate-600 transition-colors hover:border-primary/30 hover:text-primary"><Icon className="h-4 w-4" />{label}<ArrowUpRight className="ml-2 h-3.5 w-3.5 text-slate-400 group-hover:text-primary" /></Link>)}
      </div>

      {/* Top product */}
      {data?.topProductToday && (
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-warning/10 text-warning">
              <Trophy className="h-5 w-5" />
            </div>
            <div>
              <p className="text-caption text-muted-foreground">Top selling product today</p>
              <p className="text-label font-semibold">
                {data.topProductToday.name} · {data.topProductToday.quantity} sold
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Live feeds */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3"><CardTitle>Recent orders</CardTitle><Link href="/sales" className="flex items-center gap-1 text-xs font-medium text-primary">View sales <ArrowRight className="h-3.5 w-3.5" /></Link></div><p className="text-xs text-muted-foreground">The latest activity across your outlets</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)
            ) : data?.recentOrders.length ? (
              data.recentOrders.map((o) => (
                <div key={o.id} className="flex items-center justify-between rounded-md border border-border/70 bg-slate-50/40 px-4 py-3">
                  <div>
                    <p className="text-body font-medium">{o.orderNumber}</p>
                    <p className="text-caption text-muted-foreground">{o.outletName} · {format(ist(o.orderDate), 'dd MMM')}</p>
                  </div>
                  <Badge variant={ORDER_STATUS_BADGE[o.status as OrderStatus] ?? 'neutral'}>
                    {ORDER_STATUS_LABEL[o.status as OrderStatus] ?? o.status}
                  </Badge>
                </div>
              ))
            ) : (
              <EmptyState text={isError ? "Order activity is unavailable." : "New orders will appear here."} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3"><CardTitle>Recent payments</CardTitle><Link href="/payments" className="flex items-center gap-1 text-xs font-medium text-primary">View payments <ArrowRight className="h-3.5 w-3.5" /></Link></div><p className="text-xs text-muted-foreground">Keep track of incoming collections</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)
            ) : data?.recentPayments.length ? (
              data.recentPayments.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-md border border-border/70 bg-slate-50/40 px-4 py-3">
                  <div>
                    <p className="text-body font-medium">{formatINR(p.amount)}</p>
                    <p className="text-caption text-muted-foreground">{p.outletName} · {p.method}</p>
                  </div>
                  <span className="text-caption text-muted-foreground">{format(ist(p.paymentDate), 'dd MMM')}</span>
                </div>
              ))
            ) : (
              <EmptyState text={isError ? "Payment activity is unavailable." : "Payment activity will appear here."} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="py-6 text-center text-body text-muted-foreground">{text}</p>;
}
