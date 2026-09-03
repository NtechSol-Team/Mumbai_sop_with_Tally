'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import {
  Terminal, Lock, LogIn, Plus, Pencil, Trash2, Tag, ArrowLeft, Store, Loader2, ReceiptText,
  IndianRupee, AlertTriangle, History, Cpu, MemoryStick, ArrowDownToLine, ArrowUpFromLine,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { apiErrorMessage } from '@/lib/api';
import { cn, formatINR, ist, todayIso } from '@/lib/utils';
import { useDevStore } from '@/store/dev.store';
import { useOutlets, useSaveOutlet, useVerifyDeveloperKey, type Outlet } from '@/hooks/useOutlets';
import {
  useDeveloperPaymentClients, useSaveDeveloperPayment, useDeleteDeveloperPayment,
  type DeveloperPaymentClient, type RenewalStatus,
} from '@/hooks/useDeveloperPayments';
import { useOnlineUsers, useTodayActivityTotals } from '@/hooks/useDeveloperPresence';
import { useRecentServerMetrics } from '@/hooks/useDeveloperMetrics';
import {
  useDeveloperExpenses, useSaveDeveloperExpense, useDeleteDeveloperExpense,
  type DeveloperExpense, type ExpenseCategory,
} from '@/hooks/useDeveloperExpenses';
import { getSocket } from '@/lib/socket';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { ROLE_LABEL } from '@/components/shared/nav-config';
import { OutletPricesDialog } from '@/components/outlets/outlet-prices-dialog';

export default function DeveloperPage() {
  const [mounted, setMounted] = useState(false);
  const devKey = useDevStore((s) => s.devKey);
  useEffect(() => setMounted(true), []);

  // Avoid an SSR/hydration flash: the key lives in sessionStorage, which only
  // exists on the client, so wait until we've mounted before deciding the screen.
  if (!mounted) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>;
  }
  return devKey ? <DeveloperConsole /> : <UnlockScreen />;
}

// ─────────────────────────────── Unlock ─────────────────────────────────────
function UnlockScreen() {
  const setDevKey = useDevStore((s) => s.setDevKey);
  const verify = useVerifyDeveloperKey();
  const [pass, setPass] = useState('');

  const unlock = () => {
    if (!pass.trim()) { toast.error('Enter the developer passphrase'); return; }
    verify.mutate(pass, {
      onSuccess: () => { setDevKey(pass); toast.success('Developer access granted'); },
      onError: (e) => toast.error(apiErrorMessage(e, 'Invalid passphrase')),
    });
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><Terminal className="h-7 w-7" /></div>
          <h1 className="text-page-heading font-bold">Developer Console</h1>
          <p className="text-body text-slate-400">Restricted area. Enter the developer passphrase to manage outlets.</p>
        </div>
        <Label className="text-slate-300">Passphrase</Label>
        <Input
          type="password" autoFocus value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') unlock(); }}
          className="mt-1.5 border-slate-700 bg-slate-950 text-slate-100"
          placeholder="••••••••"
        />
        <Button className="mt-5 w-full" loading={verify.isPending} onClick={unlock}><LogIn className="h-4 w-4" /> Unlock</Button>
      </div>
      <Button asChild variant="ghost" className="text-slate-400 hover:bg-slate-800 hover:text-slate-100">
        <Link href="/"><ArrowLeft className="h-4 w-4" /> Back to app</Link>
      </Button>
    </div>
  );
}

// ─────────────────────────────── Console ────────────────────────────────────
function DeveloperConsole() {
  const clearDevKey = useDevStore((s) => s.clearDevKey);
  const [tab, setTab] = useState<'outlets' | 'payments' | 'costs' | 'presence' | 'server'>('outlets');

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground"><Terminal className="h-5 w-5" /></div>
          <div>
            <h1 className="text-page-heading font-bold leading-none">Developer Console</h1>
            <p className="mt-1 text-caption text-slate-400">Outlet provisioning, special pricing &amp; your service payments</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800" asChild>
            <Link href="/"><ArrowLeft className="h-4 w-4" /> App</Link>
          </Button>
          <Button variant="secondary" className="border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800" onClick={() => { clearDevKey(); toast.success('Locked'); }}>
            <Lock className="h-4 w-4" /> Lock
          </Button>
        </div>
      </div>

      <div className="mb-5 flex gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
        {([['outlets', 'Outlets'], ['payments', 'Payments & Renewals'], ['costs', 'Costs & Profit'], ['presence', "Who's Active"], ['server', 'Server Health']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              'flex-1 rounded-md px-3 py-2 text-caption font-medium transition-colors sm:flex-none sm:px-4',
              tab === k ? 'bg-primary text-primary-foreground' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'outlets' ? <OutletsTab />
        : tab === 'payments' ? <PaymentsTab />
        : tab === 'costs' ? <CostsProfitTab />
        : tab === 'presence' ? <PresenceTab />
        : <ServerHealthTab />}
    </div>
  );
}

// ─────────────────────────────── Outlets tab ─────────────────────────────────
function OutletsTab() {
  const { data: outlets, isLoading } = useOutlets();
  const [editing, setEditing] = useState<Outlet | null>(null);
  const [creating, setCreating] = useState(false);
  const [pricesFor, setPricesFor] = useState<Outlet | null>(null);

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Outlet</Button>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : !outlets?.length ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Store className="h-8 w-8 text-muted-foreground" />
            <p className="text-body text-muted-foreground">No outlets yet.</p>
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Create the first outlet</Button>
          </div>
        ) : (
          <Table>
            <THead><TR><TH>Outlet</TH><TH>Code</TH><TH>Pricing</TH><TH className="text-right">Credit</TH><TH className="text-right">Actions</TH></TR></THead>
            <TBody>
              {outlets.map((o) => (
                <TR key={o.id}>
                  <TD className="font-medium">{o.name}{!o.isActive && <span className="ml-1.5 text-caption text-muted-foreground">(inactive)</span>}</TD>
                  <TD className="text-muted-foreground">{o.code}</TD>
                  <TD><Badge variant={o.pricingMode === 'SPECIAL' ? 'info' : 'neutral'}>{o.pricingMode === 'SPECIAL' ? 'Special' : 'Generic'}</Badge></TD>
                  <TD className="text-right text-muted-foreground">{o.creditPeriodDays}d</TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setPricesFor(o)}><Tag className="h-3.5 w-3.5" /> Prices</Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit" onClick={() => setEditing(o)}><Pencil className="h-4 w-4" /></Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <OutletFormDialog
        open={creating || !!editing}
        outlet={editing}
        onOpenChange={(v) => { if (!v) { setCreating(false); setEditing(null); } }}
        onManagePrices={(o) => { setCreating(false); setEditing(null); setPricesFor(o); }}
      />
      <OutletPricesDialog outlet={pricesFor} onClose={() => setPricesFor(null)} />
    </div>
  );
}

// ─────────────────────────────── Payments tab ────────────────────────────────
const STATUS_META: Record<RenewalStatus, { label: string; variant: 'danger' | 'warning' | 'success' | 'neutral' }> = {
  OVERDUE: { label: 'Overdue', variant: 'danger' },
  DUE_SOON: { label: 'Due soon', variant: 'warning' },
  OK: { label: 'OK', variant: 'success' },
  NEVER_PAID: { label: 'Never paid', variant: 'neutral' },
};

// Partnership split: the CA friend's cut of every payment collected. Purely a
// display split of money already recorded above — doesn't change what's
// stored, so adjusting this later needs no data migration.
const PARTNER_SHARE_PCT = 40;
const MY_SHARE_PCT = 100 - PARTNER_SHARE_PCT;

/**
 * How the partner's cut is taken. After-expenses = both share the running
 * costs (the default); before-expenses = the partner's cut comes off the gross
 * and the developer absorbs all costs from their own share. Display-only, so
 * flipping it never rewrites anything stored — kept per-device in localStorage.
 */
const SPLIT_BASIS_KEY = 'mumbai-erp-dev-split-after-expenses';

function splitFor(collected: number, expenses: number, afterExpenses: boolean) {
  const profit = collected - expenses;
  if (afterExpenses) {
    return { profit, mine: (profit * MY_SHARE_PCT) / 100, partner: (profit * PARTNER_SHARE_PCT) / 100 };
  }
  return {
    profit,
    mine: (collected * MY_SHARE_PCT) / 100 - expenses,
    partner: (collected * PARTNER_SHARE_PCT) / 100,
  };
}

function MoneyRow({ label, value, tone, strong }: { label: string; value: number; tone?: 'good' | 'bad' | 'brand'; strong?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between text-body', strong && 'font-semibold')}>
      <span className="text-slate-300">{label}</span>
      <span className={cn(
        'font-semibold tabular-nums',
        tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-danger' : tone === 'brand' ? 'text-primary' : 'text-slate-100',
      )}>
        {value < 0 ? `-${formatINR(Math.abs(value))}` : formatINR(value)}
      </span>
    </div>
  );
}

function ProfitCard({ label, collected, expenses, afterExpenses, hint }: {
  label: string; collected: number; expenses: number; afterExpenses: boolean; hint?: string;
}) {
  const { profit, mine, partner } = splitFor(collected, expenses, afterExpenses);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <p className="text-caption uppercase tracking-wide text-slate-400">{label}</p>
      {hint && <p className="mt-0.5 text-caption text-slate-500">{hint}</p>}
      <p className={cn('mt-2 text-page-heading font-bold', profit >= 0 ? 'text-slate-100' : 'text-danger')}>
        {profit < 0 ? `-${formatINR(Math.abs(profit))}` : formatINR(profit)}
      </p>
      <p className="text-caption text-slate-500">profit</p>
      <div className="mt-3 space-y-1.5 border-t border-slate-800 pt-2.5">
        <MoneyRow label="Collected" value={collected} tone="good" />
        <MoneyRow label="Costs" value={-expenses} tone="bad" />
      </div>
      <div className="mt-2 space-y-1.5 border-t border-slate-800 pt-2.5">
        <MoneyRow label={`You (${MY_SHARE_PCT}%)`} value={mine} tone="good" strong />
        <MoneyRow label={`Partner (${PARTNER_SHARE_PCT}%)`} value={partner} tone="brand" strong />
      </div>
    </div>
  );
}

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  DROPLET: 'Droplet',
  DATABASE: 'Database',
  AI: 'AI / API',
  DOMAIN: 'Domain',
  OTHER: 'Other',
};

function CostsProfitTab() {
  const { data: clients } = useDeveloperPaymentClients(true);
  const { data: expenseData, isLoading } = useDeveloperExpenses(true);
  const [editing, setEditing] = useState<DeveloperExpense | null>(null);
  const [creating, setCreating] = useState(false);
  const del = useDeleteDeveloperExpense();

  const [afterExpenses, setAfterExpenses] = useState(true);
  useEffect(() => {
    const saved = localStorage.getItem(SPLIT_BASIS_KEY);
    if (saved !== null) setAfterExpenses(saved === 'true');
  }, []);
  const toggleBasis = (v: boolean) => { setAfterExpenses(v); localStorage.setItem(SPLIT_BASIS_KEY, String(v)); };

  const payments = (clients ?? []).flatMap((c) => c.history);
  const year = new Date().getFullYear();
  const collectedThisYear = payments.filter((h) => new Date(h.paidOn).getFullYear() === year).reduce((s, h) => s + Number(h.amount), 0);
  const collectedAllTime = payments.reduce((s, h) => s + Number(h.amount), 0);
  const totals = expenseData?.totals;

  // Yearly run rate: every client renews annually, so their latest payment is
  // their current annual fee. Costs use the active recurring monthly × 12.
  const annualRevenueRunRate = (clients ?? []).reduce((s, c) => s + (c.lastPayment ? Number(c.lastPayment.amount) : 0), 0);

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-800 bg-slate-900 p-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
          checked={afterExpenses}
          onChange={(e) => toggleBasis(e.target.checked)}
        />
        <span>
          <span className="block text-body font-medium text-slate-100">Partner&apos;s {PARTNER_SHARE_PCT}% is taken after costs</span>
          <span className="block text-caption text-slate-400">
            {afterExpenses
              ? 'Ticked: costs come off first, then you split the profit — you both share hosting/AI costs.'
              : 'Unticked: the partner gets their cut of everything collected, and you absorb all costs from your own share.'}
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <ProfitCard label={`Actual — ${year}`} collected={collectedThisYear} expenses={totals?.thisYear ?? 0} afterExpenses={afterExpenses} />
        <ProfitCard label="Actual — All Time" collected={collectedAllTime} expenses={totals?.allTime ?? 0} afterExpenses={afterExpenses} />
        <ProfitCard
          label="Yearly Projection"
          hint="At today's rates, if every client renews"
          collected={annualRevenueRunRate}
          expenses={totals?.annualRunRate ?? 0}
          afterExpenses={afterExpenses}
        />
      </div>

      {totals && totals.monthlyRunRate > 0 && (
        <p className="text-caption text-slate-400">
          Running costs: <b className="text-slate-200">{formatINR(totals.monthlyRunRate)}/month</b>
          {' '}({formatINR(totals.annualRunRate)}/year) from active monthly items.
        </p>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="font-semibold">Running costs</p>
            <p className="text-caption text-muted-foreground">Droplet, database, AI and anything else you pay to run this.</p>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add Cost</Button>
        </div>
        {!expenseData?.expenses.length ? (
          <p className="py-10 text-center text-body text-muted-foreground">No costs recorded yet.</p>
        ) : (
          <Table>
            <THead><TR><TH>Category</TH><TH>Detail</TH><TH>Type</TH><TH>Period</TH><TH className="text-right">Amount</TH><TH className="text-right">Actions</TH></TR></THead>
            <TBody>
              {expenseData.expenses.map((e) => (
                <TR key={e.id} className={cn(e.isEnded && 'opacity-50')}>
                  <TD className="font-medium">{CATEGORY_LABEL[e.category]}</TD>
                  <TD className="text-muted-foreground">{e.label ?? '—'}</TD>
                  <TD>
                    {e.isRecurring
                      ? <Badge variant={e.isEnded ? 'neutral' : 'info'}>{e.isEnded ? 'Stopped' : 'Monthly'}</Badge>
                      : <Badge variant="neutral">One-off</Badge>}
                  </TD>
                  <TD className="text-muted-foreground">
                    {format(ist(e.incurredOn), 'MMM yyyy')}
                    {e.isRecurring && ` → ${e.endedOn ? format(ist(e.endedOn), 'MMM yyyy') : 'ongoing'}`}
                  </TD>
                  <TD className="text-right font-semibold">
                    {formatINR(e.amount)}{e.isRecurring && <span className="text-caption font-normal text-muted-foreground">/mo</span>}
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit" onClick={() => setEditing(e)}><Pencil className="h-4 w-4" /></Button>
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8" title="Remove"
                        onClick={() => del.mutate(e.id, { onSuccess: () => toast.success('Cost removed') })}
                      >
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <ExpenseFormDialog
        open={creating || !!editing}
        expense={editing}
        onOpenChange={(v) => { if (!v) { setCreating(false); setEditing(null); } }}
      />
    </div>
  );
}

const CATEGORIES: ExpenseCategory[] = ['DROPLET', 'DATABASE', 'AI', 'DOMAIN', 'OTHER'];
const monthInput = (iso?: string | null) => (iso ? format(ist(iso), 'yyyy-MM-dd') : format(ist(), 'yyyy-MM-dd'));

function ExpenseFormDialog({ open, expense, onOpenChange }: {
  open: boolean; expense: DeveloperExpense | null; onOpenChange: (v: boolean) => void;
}) {
  const save = useSaveDeveloperExpense();
  const [category, setCategory] = useState<ExpenseCategory>('DROPLET');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [isRecurring, setIsRecurring] = useState(true);
  const [incurredOn, setIncurredOn] = useState(monthInput());
  const [endedOn, setEndedOn] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) return;
    setCategory(expense?.category ?? 'DROPLET');
    setLabel(expense?.label ?? '');
    setAmount(expense ? String(expense.amount) : '');
    setIsRecurring(expense ? expense.isRecurring : true);
    setIncurredOn(monthInput(expense?.incurredOn));
    setEndedOn(expense?.endedOn ? monthInput(expense.endedOn) : '');
    setNotes(expense?.notes ?? '');
  }, [open, expense]);

  const submit = () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) { toast.error('Enter a valid amount'); return; }
    save.mutate(
      {
        id: expense?.id,
        category,
        label: label.trim() || undefined,
        amount: amt,
        isRecurring,
        incurredOn: new Date(incurredOn).toISOString(),
        endedOn: isRecurring && endedOn ? new Date(endedOn).toISOString() : null,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => { toast.success(expense ? 'Cost updated' : 'Cost added'); onOpenChange(false); },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{expense ? 'Edit Cost' : 'Add Cost'}</DialogTitle>
          <DialogDescription>A monthly cost counts automatically every month — no need to re-enter it.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label required>Category</Label>
            <Select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Detail</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. 2GB droplet, Claude API" />
          </div>
          <div className="space-y-1.5">
            <Label required>Amount{isRecurring && ' (per month)'}</Label>
            <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div className="space-y-1.5">
            <Label required>{isRecurring ? 'Starts' : 'Date paid'}</Label>
            <Input type="date" value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)} />
          </div>
          {isRecurring && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Stopped on (leave blank if still running)</Label>
              <Input type="date" value={endedOn} min={incurredOn} onChange={(e) => setEndedOn(e.target.value)} />
            </div>
          )}
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-border bg-surface p-2.5 text-body">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
          <span>
            <span className="font-medium">Repeats every month</span>
            <span className="block text-caption text-muted-foreground">
              Tick for subscriptions (droplet, database). Untick for a one-time payment.
            </span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending}>{expense ? 'Save' : 'Add Cost'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentsTab() {
  const { data: clients, isLoading } = useDeveloperPaymentClients(true);
  const [payFor, setPayFor] = useState<DeveloperPaymentClient | null>(null);
  const [historyFor, setHistoryFor] = useState<DeveloperPaymentClient | null>(null);

  const dueSoon = (clients ?? []).filter((c) => c.status === 'OVERDUE' || c.status === 'DUE_SOON');

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;

  return (
    <div className="space-y-4">
      {dueSoon.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4">
          <p className="mb-2 flex items-center gap-2 font-semibold text-warning"><AlertTriangle className="h-4 w-4" /> Renewals due soon</p>
          <ul className="space-y-1 text-body text-slate-200">
            {dueSoon.map((c) => (
              <li key={c.outletId ?? 'main'} className="flex items-center justify-between">
                <span>{c.name}</span>
                <span className={cn('font-medium', c.status === 'OVERDUE' ? 'text-danger' : 'text-warning')}>
                  {c.status === 'OVERDUE'
                    ? `Overdue by ${Math.abs(c.daysUntilRenewal ?? 0)}d`
                    : `Due in ${c.daysUntilRenewal}d`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card className="overflow-hidden">
        <Table>
          <THead><TR><TH>Client</TH><TH className="text-right">Last Paid</TH><TH>Renewal Date</TH><TH>Status</TH><TH className="text-right">Actions</TH></TR></THead>
          <TBody>
            {(clients ?? []).map((c) => (
              <TR key={c.outletId ?? 'main'}>
                <TD className="font-medium">
                  <span className="flex items-center gap-1.5">
                    {c.outletId ? <Store className="h-3.5 w-3.5 text-slate-500" /> : <IndianRupee className="h-3.5 w-3.5 text-slate-500" />}
                    {c.name}
                    {!c.isActive && <span className="text-caption text-slate-500">(inactive)</span>}
                  </span>
                </TD>
                <TD className="text-right text-slate-300">
                  {c.lastPayment ? `${formatINR(c.lastPayment.amount)} · ${format(ist(c.lastPayment.paidOn), 'dd MMM yyyy')}` : '—'}
                </TD>
                <TD className="text-slate-300">{c.lastPayment ? format(ist(c.lastPayment.renewalDate), 'dd MMM yyyy') : '—'}</TD>
                <TD><Badge variant={STATUS_META[c.status].variant}>{STATUS_META[c.status].label}</Badge></TD>
                <TD className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setHistoryFor(c)} disabled={!c.history.length}><History className="h-3.5 w-3.5" /> History</Button>
                    <Button size="sm" onClick={() => setPayFor(c)}><Plus className="h-3.5 w-3.5" /> Record Payment</Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <RecordPaymentDialog client={payFor} onClose={() => setPayFor(null)} />
      <PaymentHistoryDialog client={historyFor} onClose={() => setHistoryFor(null)} />
    </div>
  );
}

const METHODS = ['CASH', 'CARD', 'UPI', 'NET_BANKING', 'RAZORPAY', 'BANK_TRANSFER'];
const today = () => todayIso();

function RecordPaymentDialog({ client, onClose }: { client: DeveloperPaymentClient | null; onClose: () => void }) {
  const save = useSaveDeveloperPayment();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('UPI');
  const [paidOn, setPaidOn] = useState(today());
  const [renewalDate, setRenewalDate] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!client) return;
    setAmount(client.lastPayment ? String(Number(client.lastPayment.amount)) : '');
    setMethod('UPI');
    setPaidOn(today());
    setRenewalDate('');
    setNotes('');
  }, [client]);

  if (!client) return null;

  const submit = () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) { toast.error('Enter a valid amount'); return; }
    save.mutate(
      {
        scope: client.scope,
        outletId: client.outletId ?? undefined,
        amount: amt,
        method,
        paidOn: new Date(paidOn).toISOString(),
        renewalDate: renewalDate ? new Date(renewalDate).toISOString() : undefined,
        notes: notes || undefined,
      },
      {
        onSuccess: () => { toast.success(`Payment recorded for ${client.name}`); onClose(); },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record Payment — {client.name}</DialogTitle>
          <DialogDescription>Renewal date defaults to one year after the paid-on date if left blank.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label required>Amount</Label><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
          <div className="space-y-1.5">
            <Label>Method</Label>
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}</Select>
          </div>
          <div className="space-y-1.5"><Label required>Paid on</Label><Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Renewal date (optional)</Label><Input type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} /></div>
          <div className="sm:col-span-2 space-y-1.5"><Label>Notes</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending}>Save Payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentHistoryDialog({ client, onClose }: { client: DeveloperPaymentClient | null; onClose: () => void }) {
  const del = useDeleteDeveloperPayment();
  if (!client) return null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Payment History — {client.name}</DialogTitle></DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto scrollbar-thin">
          <Table>
            <THead><TR><TH>Paid On</TH><TH className="text-right">Amount</TH><TH>Renewal</TH><TH>Method</TH><TH className="w-8" /></TR></THead>
            <TBody>
              {client.history.map((h) => (
                <TR key={h.id}>
                  <TD>{format(ist(h.paidOn), 'dd MMM yyyy')}</TD>
                  <TD className="text-right font-medium">{formatINR(h.amount)}</TD>
                  <TD>{format(ist(h.renewalDate), 'dd MMM yyyy')}</TD>
                  <TD className="text-muted-foreground">{h.method?.replace('_', ' ') ?? '—'}</TD>
                  <TD>
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7"
                      loading={del.isPending}
                      onClick={() => del.mutate(h.id, { onSuccess: () => toast.success('Payment removed') })}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-danger" />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
        <DialogFooter><Button variant="secondary" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────── Who's Active tab ────────────────────────────
/** "1h 04m" / "12m 30s" — compact, and never shows a bare "0s" for a live row. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function PresenceTab() {
  const qc = useQueryClient();
  const { data: online, isLoading } = useOnlineUsers(true);
  const { data: totals } = useTodayActivityTotals(true);
  // One shared 1s tick drives every live duration — no per-row timers, and it
  // runs only while this tab is open (developer-only page).
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Presence changes are rare (a login/logout), so refetch on the event rather
  // than polling on a timer.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = () => void qc.invalidateQueries({ queryKey: ['developer-presence'] });
    socket.on('presence_online', handler);
    socket.on('presence_offline', handler);
    return () => { socket.off('presence_online', handler); socket.off('presence_offline', handler); };
  }, [qc]);

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="flex items-center gap-2 font-semibold">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
            </span>
            Live now
          </p>
          <span className="text-caption text-muted-foreground">{online?.length ?? 0} online</span>
        </div>
        {!online?.length ? (
          <p className="py-10 text-center text-body text-muted-foreground">Nobody is using the app right now.</p>
        ) : (
          <Table>
            <THead><TR><TH>User</TH><TH>Role</TH><TH>Since</TH><TH className="text-right">Online for</TH></TR></THead>
            <TBody>
              {online.map((u) => (
                <TR key={u.userId}>
                  <TD className="font-medium">{u.name}</TD>
                  <TD><Badge variant="info">{ROLE_LABEL[u.role]}</Badge></TD>
                  <TD className="text-muted-foreground">{format(ist(u.onlineSince), 'hh:mm a')}</TD>
                  <TD className="text-right font-semibold tabular-nums text-success">
                    {formatDuration((now - new Date(u.onlineSince).getTime()) / 1000)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <p className="font-semibold">Today&apos;s usage</p>
          <p className="text-caption text-muted-foreground">Total time in the app today, per user (includes time still running).</p>
        </div>
        {!totals?.length ? (
          <p className="py-10 text-center text-body text-muted-foreground">No activity recorded today yet.</p>
        ) : (
          <Table>
            <THead><TR><TH>User</TH><TH>Role</TH><TH>Outlet</TH><TH className="text-right">Active today</TH></TR></THead>
            <TBody>
              {totals.map((t) => (
                <TR key={t.userId}>
                  <TD className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {t.isOnline && <span className="h-2 w-2 shrink-0 rounded-full bg-success" title="Online now" />}
                      {t.name}
                    </span>
                  </TD>
                  <TD><Badge variant="neutral">{ROLE_LABEL[t.role]}</Badge></TD>
                  <TD className="text-muted-foreground">{t.outletName ?? '—'}</TD>
                  <TD className="text-right font-semibold tabular-nums">{formatDuration(t.activeSeconds)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ─────────────────────────────── Server Health tab ───────────────────────────
const WINDOWS = [[6, '6h'], [24, '24h'], [72, '3d'], [168, '7d']] as const;
const toMb = (bytes: number | null) => (bytes == null ? 0 : bytes / 1024 / 1024);

function ServerHealthTab() {
  const [hours, setHours] = useState<number>(24);
  const { data: points, isLoading } = useRecentServerMetrics(hours, true);

  const latest = points?.length ? points[points.length - 1] : null;
  const totalRxMb = (points ?? []).reduce((s, p) => s + toMb(p.netRxBytes), 0);
  const totalTxMb = (points ?? []).reduce((s, p) => s + toMb(p.netTxBytes), 0);
  const chartData = (points ?? []).map((p) => ({
    at: format(ist(p.at), hours > 48 ? 'dd MMM' : 'HH:mm'),
    load: Number(p.loadAvg1.toFixed(2)),
    mem: Number(p.memUsedPct.toFixed(1)),
    rx: Number(toMb(p.netRxBytes).toFixed(2)),
    tx: Number(toMb(p.netTxBytes).toFixed(2)),
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-muted-foreground">Whole-server usage, sampled every 5 minutes.</p>
        <div className="flex gap-1 rounded-md border border-slate-800 bg-slate-900 p-1">
          {WINDOWS.map(([h, label]) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              className={cn('rounded px-2.5 py-1 text-caption font-medium', hours === h ? 'bg-primary text-primary-foreground' : 'text-slate-400 hover:text-slate-100')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : !points?.length ? (
        <Card className="py-16 text-center">
          <p className="text-body text-muted-foreground">No samples yet — the first one lands within 5 minutes of the API starting.</p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="CPU load (1m)" value={latest ? latest.loadAvg1.toFixed(2) : '—'} icon={Cpu} accent={(latest?.loadAvg1 ?? 0) > 1 ? 'warning' : 'success'} />
            <KpiCard label="Memory used" value={latest ? `${latest.memUsedPct.toFixed(0)}%` : '—'} icon={MemoryStick} accent={(latest?.memUsedPct ?? 0) > 85 ? 'danger' : 'primary'} />
            <KpiCard label={`Downloaded (${hours}h)`} value={`${totalRxMb.toFixed(0)} MB`} icon={ArrowDownToLine} accent="primary" />
            <KpiCard label={`Uploaded (${hours}h)`} value={`${totalTxMb.toFixed(0)} MB`} icon={ArrowUpFromLine} accent="primary" />
          </div>

          <Card className="p-4">
            <p className="mb-3 font-semibold">CPU load average</p>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis dataKey="at" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={30} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, color: '#e2e8f0' }} />
                <Line type="monotone" dataKey="load" name="Load (1m)" stroke="#6366F1" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card className="p-4">
            <p className="mb-3 font-semibold">Network traffic per sample (MB)</p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis dataKey="at" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={30} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, color: '#e2e8f0' }} />
                <Legend />
                <Bar dataKey="rx" name="In" fill="#16A34A" radius={[3, 3, 0, 0]} />
                <Bar dataKey="tx" name="Out" fill="#D97706" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────── Outlet form ────────────────────────────────
function suggestCode(name: string): string {
  const letters = name.trim().toUpperCase().replace(/[^A-Z ]/g, '').split(/\s+/).filter(Boolean).map((w) => w.slice(0, 4)).join('-');
  return letters ? `OUT-${letters}` : '';
}
const empty = { name: '', code: '', address: '', phone: '', creditPeriodDays: 15, special: false, gstBilling: true };

function OutletFormDialog({ open, outlet, onOpenChange, onManagePrices }: {
  open: boolean;
  outlet: Outlet | null;
  onOpenChange: (v: boolean) => void;
  onManagePrices: (o: Outlet) => void;
}) {
  const isEdit = !!outlet;
  const save = useSaveOutlet();
  const [form, setForm] = useState({ ...empty });
  const [codeTouched, setCodeTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(outlet
        ? {
            name: outlet.name, code: outlet.code, address: outlet.address ?? '', phone: outlet.phone ?? '',
            creditPeriodDays: outlet.creditPeriodDays, special: outlet.pricingMode === 'SPECIAL', gstBilling: outlet.gstBilling,
          }
        : { ...empty });
      setCodeTouched(!!outlet);
    }
  }, [open, outlet]);

  const setName = (name: string) => setForm((f) => ({ ...f, name, code: codeTouched ? f.code : suggestCode(name) }));

  const submit = () => {
    if (form.name.trim().length < 2) { toast.error('Enter an outlet name'); return; }
    if (form.code.trim().length < 2) { toast.error('Enter an outlet code'); return; }
    save.mutate(
      {
        id: outlet?.id,
        name: form.name.trim(), code: form.code.trim().toUpperCase(),
        address: form.address || undefined, phone: form.phone || undefined,
        creditPeriodDays: form.creditPeriodDays,
        pricingMode: form.special ? 'SPECIAL' : 'GENERIC',
        gstBilling: form.gstBilling,
      },
      {
        onSuccess: (saved) => {
          toast.success(isEdit ? 'Outlet updated' : `Outlet "${saved.name}" created`);
          onOpenChange(false);
          // Jump straight to price-setting for special-pricing outlets.
          if (form.special) onManagePrices(saved);
        },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{isEdit ? `Edit ${outlet?.name}` : 'New Outlet'}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label required>Outlet name</Label><Input value={form.name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Piplod Outlet" /></div>
          <div className="space-y-1.5"><Label required>Code</Label><Input value={form.code} onChange={(e) => { setCodeTouched(true); setForm((f) => ({ ...f, code: e.target.value.toUpperCase() })); }} placeholder="OUT-PIPLOD" /></div>
          <div className="sm:col-span-2 space-y-1.5"><Label>Address</Label><Input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} placeholder="Optional" /></div>
          <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="Optional" /></div>
          <div className="space-y-1.5"><Label>Credit period (days)</Label><Input type="number" value={form.creditPeriodDays} onChange={(e) => setForm((f) => ({ ...f, creditPeriodDays: Number(e.target.value) }))} /></div>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-border bg-surface p-2.5 text-body">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.special} onChange={(e) => setForm((f) => ({ ...f, special: e.target.checked }))} />
          <span>
            <span className="flex items-center gap-1 font-medium"><Tag className="h-3.5 w-3.5 text-primary" /> Special price selling</span>
            <span className="block text-caption text-muted-foreground">This outlet gets its own negotiated prices instead of the standard catalog price. You&apos;ll set the actual prices right after saving.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 rounded-md border border-border bg-surface p-2.5 text-body">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.gstBilling} onChange={(e) => setForm((f) => ({ ...f, gstBilling: e.target.checked }))} />
          <span>
            <span className="flex items-center gap-1 font-medium"><ReceiptText className="h-3.5 w-3.5 text-primary" /> Bill this outlet with GST</span>
            <span className="block text-caption text-muted-foreground">
              Their orders are priced — and paid for — before you review them, so this decides whether GST is added to the amount they pay. Untick for a no-GST outlet.
            </span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending}>{isEdit ? 'Save' : 'Create Outlet'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
