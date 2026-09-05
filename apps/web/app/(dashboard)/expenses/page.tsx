'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import {
  Trash2, TrendingUp, TrendingDown, Plus, Pencil, Tag, Wallet, Receipt,
  Filter, X, Lock, Check,
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { apiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/store/auth.store';
import { cn, formatINR, ist, istDateInput, todayIso } from '@/lib/utils';
import {
  useExpenseCategories, useCreateExpenseCategory, useUpdateExpenseCategory,
  useExpenseSummary, useExpenses, useSaveExpense, useDeleteExpense,
  PAID_BY_OPTIONS, usePaidByLabels,
  type ExpenseLocation, type Expense, type ExpenseFilters, type PaidBy,
} from '@/hooks/useExpenses';

const LOCATIONS: ExpenseLocation[] = ['GODOWN', 'MAIN_BRANCH', 'GENERAL'];
const LOCATION_LABEL: Record<ExpenseLocation, string> = {
  GODOWN: 'Warehouse', MAIN_BRANCH: 'Main Branch', GENERAL: 'General',
};
const METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'NET_BANKING', 'NOT_PAID'] as const;
const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash', UPI: 'UPI', BANK_TRANSFER: 'Bank Transfer', CARD: 'Card',
  NET_BANKING: 'Net Banking', RAZORPAY: 'Razorpay', NOT_PAID: 'Not Paid',
};

// Local calendar date, not toISOString() — in IST the latter shifts back 5h30m, so a
// month-end of 31 Jul would serialise as "2026-07-30" and quietly drop a day of spend.
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => todayIso();
/** "2026-07" → a local Date, so month labels don't slip a month either. */
const monthDate = (m: string) => new Date(`${m}-01T00:00:00`);

type PresetKey = 'this-month' | 'last-month' | 'last-3' | 'this-year' | 'all' | 'custom';

/**
 * Named windows, each paired with the equivalent preceding window so the period can
 * be compared against itself a month/quarter/year ago.
 */
function rangeFor(preset: PresetKey, custom: { from: string; to: string }): {
  from?: string; to?: string; prev?: { from: string; to: string }; label: string;
} {
  const n = ist();
  const y = n.getFullYear();
  const m = n.getMonth();
  const monthStart = (yy: number, mm: number) => new Date(yy, mm, 1);
  const monthEnd = (yy: number, mm: number) => new Date(yy, mm + 1, 0);

  switch (preset) {
    case 'this-month':
      return {
        from: iso(monthStart(y, m)), to: iso(monthEnd(y, m)),
        prev: { from: iso(monthStart(y, m - 1)), to: iso(monthEnd(y, m - 1)) },
        label: format(monthStart(y, m), 'MMMM yyyy'),
      };
    case 'last-month':
      return {
        from: iso(monthStart(y, m - 1)), to: iso(monthEnd(y, m - 1)),
        prev: { from: iso(monthStart(y, m - 2)), to: iso(monthEnd(y, m - 2)) },
        label: format(monthStart(y, m - 1), 'MMMM yyyy'),
      };
    case 'last-3':
      return {
        from: iso(monthStart(y, m - 2)), to: iso(monthEnd(y, m)),
        prev: { from: iso(monthStart(y, m - 5)), to: iso(monthEnd(y, m - 3)) },
        label: 'Last 3 months',
      };
    case 'this-year':
      return {
        from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)),
        prev: { from: iso(new Date(y - 1, 0, 1)), to: iso(new Date(y - 1, 11, 31)) },
        label: String(y),
      };
    case 'custom':
      return { from: custom.from, to: custom.to, label: `${custom.from} → ${custom.to}` };
    default:
      return { label: 'All time' };
  }
}

export default function ExpensesPage() {
  // A branch's expenses are all its own, so the Godown/Main Branch/General split —
  // which describes where the *company* spent — has nothing to say about them.
  const isBranch = useAuthStore((s) => s.user?.role) === 'FRANCHISE_OWNER';
  const [preset, setPreset] = useState<PresetKey>('this-month');
  const [custom, setCustom] = useState({ from: today(), to: today() });
  const [location, setLocation] = useState<ExpenseLocation | ''>('');
  const [categoryId, setCategoryId] = useState('');
  const [editing, setEditing] = useState<Expense | null>(null);
  const [creating, setCreating] = useState(false);
  const [managingCategories, setManagingCategories] = useState(false);

  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  const filters: ExpenseFilters = {
    ...(location ? { location } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
  };

  const { data: categories } = useExpenseCategories();
  const { data: summary, isLoading: sLoading } = useExpenseSummary(filters);
  // The same filters over the preceding window, purely to say whether spend is up or down.
  const { data: prevSummary } = useExpenseSummary(
    { ...filters, from: range.prev?.from, to: range.prev?.to },
    !!range.prev,
  );
  const { data: expenses, isLoading } = useExpenses(filters);

  const total = summary?.total ?? 0;
  const prevTotal = prevSummary?.total ?? 0;
  const delta = range.prev && prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null;
  const topCategory = summary?.byCategory[0];
  const count = summary?.count ?? 0;

  const activeFilters = [
    location ? { label: LOCATION_LABEL[location], clear: () => setLocation('') } : null,
    categoryId ? { label: categories?.find((c) => c.id === categoryId)?.name ?? 'Category', clear: () => setCategoryId('') } : null,
  ].filter((f): f is { label: string; clear: () => void } => f !== null);

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="text-card-title font-bold">Expenses</h1>
          <p className="text-caption text-muted-foreground">{range.label} · what {isBranch ? 'your outlet' : 'the business'} spent</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-40" value={preset} onChange={(e) => setPreset(e.target.value as PresetKey)}>
            <option value="this-month">This month</option>
            <option value="last-month">Last month</option>
            <option value="last-3">Last 3 months</option>
            <option value="this-year">This year</option>
            <option value="all">All time</option>
            <option value="custom">Custom range</option>
          </Select>
          <Select className="w-44" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {(categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {!isBranch && (
            <Select className="w-40" value={location} onChange={(e) => setLocation(e.target.value as ExpenseLocation | '')}>
              <option value="">All locations</option>
              {LOCATIONS.map((l) => <option key={l} value={l}>{LOCATION_LABEL[l]}</option>)}
            </Select>
          )}
          <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add Expense</Button>
        </div>
      </div>

      {preset === 'custom' && (
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1.5">
            <Label>From</Label>
            <Input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>To</Label>
            <Input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </div>
        </Card>
      )}

      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          {activeFilters.map((f) => (
            <button
              key={f.label}
              onClick={f.clear}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-caption hover:bg-accent"
            >
              {f.label} <X className="h-3 w-3" />
            </button>
          ))}
          <button
            onClick={() => { setLocation(''); setCategoryId(''); }}
            className="text-caption text-muted-foreground underline hover:text-foreground"
          >
            Clear all
          </button>
        </div>
      )}

      {/* ── Headline figures ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {sLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <StatCard
              label="Total spent"
              value={formatINR(total, { decimals: false })}
              icon={Wallet}
              foot={
                delta === null ? (
                  <span className="text-muted-foreground">No prior period to compare</span>
                ) : (
                  <span className={cn('inline-flex items-center gap-1', delta > 0 ? 'text-danger' : 'text-success')}>
                    {delta > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {Math.abs(delta).toFixed(1)}% vs previous
                  </span>
                )
              }
            />
            <StatCard
              label="Entries"
              value={String(count)}
              icon={Receipt}
              foot={<span className="text-muted-foreground">{count > 0 ? `${formatINR(total / count, { decimals: false })} average` : 'Nothing recorded'}</span>}
            />
            <StatCard
              label="Top category"
              value={topCategory?.category ?? '—'}
              icon={Tag}
              foot={
                topCategory && total > 0
                  ? <span className="text-muted-foreground">{formatINR(topCategory.total, { decimals: false })} · {((topCategory.total / total) * 100).toFixed(0)}% of spend</span>
                  : <span className="text-muted-foreground">No spend yet</span>
              }
            />
            <StatCard
              label="Previous period"
              value={range.prev ? formatINR(prevTotal, { decimals: false }) : '—'}
              icon={TrendingUp}
              foot={<span className="text-muted-foreground">{range.prev ? 'Same window, shifted back' : 'Not applicable'}</span>}
            />
          </>
        )}
      </div>

      {/* ── Breakdown + trend ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-label font-semibold">Where it went</h3>
            <span className="text-caption text-muted-foreground">Click a category to filter</span>
          </div>
          {sLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : !summary?.byCategory.length ? (
            <p className="py-10 text-center text-body text-muted-foreground">Nothing spent in this period.</p>
          ) : (
            <div className="space-y-2.5">
              {summary.byCategory.slice(0, 8).map((c) => {
                const share = total > 0 ? (c.total / total) * 100 : 0;
                const selected = categoryId === c.categoryId;
                return (
                  <button
                    key={c.categoryId}
                    onClick={() => setCategoryId(selected ? '' : c.categoryId)}
                    className="block w-full text-left"
                  >
                    <div className="flex items-baseline justify-between text-body">
                      <span className={cn('truncate', selected && 'font-semibold text-primary')}>{c.category}</span>
                      <span className="ml-2 shrink-0 tabular-nums">
                        {formatINR(c.total, { decimals: false })}
                        <span className="ml-1.5 text-caption text-muted-foreground">{share.toFixed(0)}%</span>
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface">
                      <div
                        className={cn('h-full rounded-full transition-all', selected ? 'bg-primary' : 'bg-primary/50')}
                        style={{ width: `${Math.max(share, 1.5)}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-label font-semibold">Last 6 months</h3>
          {sLoading || !summary?.monthly.length ? (
            <Skeleton className="h-56" />
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={summary.monthly} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
                <XAxis dataKey="month" tickFormatter={(m: string) => format(monthDate(m), 'MMM')} tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} tick={{ fontSize: 11 }} width={44} />
                <Tooltip
                  formatter={(v: number) => [formatINR(v), 'Spent']}
                  labelFormatter={(m: string) => format(monthDate(m), 'MMMM yyyy')}
                />
                <Line type="monotone" dataKey="total" stroke="#3730A3" strokeWidth={2.5} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* ── The ledger ─────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-label font-semibold">
            Expense records
            {expenses?.length ? <span className="ml-1.5 text-caption font-normal text-muted-foreground">{expenses.length} shown</span> : null}
          </h3>
          <Button variant="secondary" size="sm" onClick={() => setManagingCategories(true)}>
            <Tag className="h-4 w-4" /> Categories
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : !expenses?.length ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Receipt className="h-8 w-8 text-muted-foreground" />
            <p className="text-body text-muted-foreground">No expenses match these filters.</p>
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add an expense</Button>
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-32">Date</TH><TH>Category</TH><TH>Paid to</TH><TH>Paid by</TH>
                {!isBranch && <TH>Location</TH>}<TH>Method</TH><TH className="text-right">Amount</TH><TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {expenses.map((e) => <ExpenseRow key={e.id} expense={e} isBranch={isBranch} onEdit={() => setEditing(e)} />)}
            </TBody>
          </Table>
        )}
      </Card>

      <ExpenseFormDialog
        open={creating || !!editing}
        onOpenChange={(v) => { if (!v) { setCreating(false); setEditing(null); } }}
        expense={editing}
        isBranch={isBranch}
      />
      <CategoriesDialog open={managingCategories} onOpenChange={setManagingCategories} />
    </div>
  );
}

function StatCard({ label, value, icon: Icon, foot }: {
  label: string; value: string; icon: typeof Wallet; foot: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <p className="text-caption uppercase tracking-wide text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-1.5 truncate text-2xl font-extrabold leading-tight">{value}</p>
      <p className="mt-1 text-caption">{foot}</p>
    </Card>
  );
}

function ExpenseRow({ expense, isBranch, onEdit }: { expense: Expense; isBranch: boolean; onEdit: () => void }) {
  const paidByLabels = usePaidByLabels();
  const del = useDeleteExpense();
  const remove = () => {
    if (!window.confirm(`Delete this ${formatINR(expense.amount)} expense?`)) return;
    del.mutate(expense.id, {
      onSuccess: () => toast.success('Expense deleted'),
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };
  return (
    <TR>
      <TD className="whitespace-nowrap">{format(ist(expense.expenseDate), 'dd MMM yyyy')}</TD>
      <TD className="font-medium">{expense.category.name}</TD>
      <TD className="text-muted-foreground">{expense.paidTo || '—'}</TD>
      <TD><Badge variant={expense.paidBy === 'COMPANY' ? 'neutral' : 'info'}>{paidByLabels[expense.paidBy]}</Badge></TD>
      {!isBranch && <TD><Badge variant="neutral">{LOCATION_LABEL[expense.location]}</Badge></TD>}
      <TD>
        {expense.paymentMethod === 'NOT_PAID' ? (
          <Badge variant="danger">Not Paid</Badge>
        ) : (
          <span className="text-caption">{METHOD_LABEL[expense.paymentMethod] ?? expense.paymentMethod}</span>
        )}
      </TD>
      <TD className="text-right font-semibold tabular-nums">{formatINR(expense.amount)}</TD>
      <TD>
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" title="Edit" onClick={onEdit}><Pencil className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" title="Delete" onClick={remove}><Trash2 className="h-4 w-4 text-danger" /></Button>
        </div>
      </TD>
    </TR>
  );
}

const emptyExpense = {
  categoryId: '', amount: 0, expenseDate: today(),
  paymentMethod: 'CASH' as string, location: 'GENERAL' as ExpenseLocation,
  paidBy: 'COMPANY' as PaidBy, paidTo: '', note: '',
};

function ExpenseFormDialog({ open, onOpenChange, expense, isBranch }: {
  open: boolean; onOpenChange: (v: boolean) => void; expense: Expense | null; isBranch: boolean;
}) {
  const { data: categories } = useExpenseCategories();
  const paidByLabels = usePaidByLabels();
  const save = useSaveExpense();
  const [form, setForm] = useState({ ...emptyExpense });
  const set = <K extends keyof typeof emptyExpense>(k: K, v: (typeof emptyExpense)[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!open) return;
    setForm(
      expense
        ? {
            categoryId: expense.category.id,
            amount: Number(expense.amount),
            expenseDate: istDateInput(expense.expenseDate),
            paymentMethod: expense.paymentMethod,
            location: expense.location,
            paidBy: expense.paidBy,
            paidTo: expense.paidTo ?? '',
            note: expense.note ?? '',
          }
        : { ...emptyExpense, categoryId: categories?.[0]?.id ?? '' },
    );
  }, [open, expense, categories]);

  const submit = () => {
    if (!form.categoryId) { toast.error('Pick a category'); return; }
    if (form.amount <= 0) { toast.error('Enter an amount greater than zero'); return; }
    save.mutate(
      {
        id: expense?.id,
        categoryId: form.categoryId,
        amount: form.amount,
        expenseDate: form.expenseDate,
        paymentMethod: form.paymentMethod,
        location: form.location,
        paidBy: form.paidBy,
        paidTo: form.paidTo.trim() || undefined,
        note: form.note.trim() || undefined,
      },
      {
        onSuccess: () => { toast.success(expense ? 'Expense updated' : 'Expense added'); onOpenChange(false); },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{expense ? 'Edit expense' : 'Add expense'}</DialogTitle></DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2 space-y-1.5">
            <Label>Category</Label>
            <Select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              {!categories?.length && <option value="">No categories yet</option>}
              {(categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Amount (₹)</Label>
            <Input type="number" step="0.01" min={0} value={form.amount} onChange={(e) => set('amount', Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={form.expenseDate} onChange={(e) => set('expenseDate', e.target.value)} />
          </div>
          {!isBranch && (
            <div className="space-y-1.5">
              <Label>Location</Label>
              <Select value={form.location} onChange={(e) => set('location', e.target.value as ExpenseLocation)}>
                {LOCATIONS.map((l) => <option key={l} value={l}>{LOCATION_LABEL[l]}</option>)}
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Payment method</Label>
            <Select value={form.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)}>
              {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Paid by</Label>
            <Select value={form.paidBy} onChange={(e) => set('paidBy', e.target.value as PaidBy)}>
              {PAID_BY_OPTIONS.map((p) => <option key={p} value={p}>{paidByLabels[p]}</option>)}
            </Select>
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label>Paid to <span className="text-muted-foreground">(optional)</span></Label>
            <Input value={form.paidTo} onChange={(e) => set('paidTo', e.target.value)} placeholder="Supplier, landlord, staff…" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label>Note <span className="text-muted-foreground">(optional)</span></Label>
            <Input value={form.note} onChange={(e) => set('note', e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending}>{expense ? 'Save' : 'Add Expense'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CategoriesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: categories } = useExpenseCategories();
  const create = useCreateExpenseCategory();
  const update = useUpdateExpenseCategory();
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const add = () => {
    if (name.trim().length < 2) return;
    create.mutate(name.trim(), {
      onSuccess: () => { toast.success('Category added'); setName(''); },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  const saveEdit = (id: string) => {
    if (editName.trim().length < 2) return;
    update.mutate({ id, name: editName.trim() }, {
      onSuccess: () => { toast.success('Category renamed'); setEditingId(null); },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Expense categories</DialogTitle></DialogHeader>

        <div className="flex gap-2">
          <Input placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <Button onClick={add} loading={create.isPending}><Plus className="h-4 w-4" /> Add</Button>
        </div>

        <div className="max-h-[45vh] space-y-1.5 overflow-y-auto scrollbar-thin">
          {!categories?.length ? (
            <p className="py-6 text-center text-caption text-muted-foreground">No categories yet.</p>
          ) : (
            categories.map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                {editingId === c.id ? (
                  <>
                    <Input
                      className="h-8" value={editName} autoFocus
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(c.id); if (e.key === 'Escape') setEditingId(null); }}
                    />
                    <Button size="icon" className="h-8 w-8 shrink-0" loading={update.isPending} onClick={() => saveEdit(c.id)}><Check className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => setEditingId(null)}><X className="h-4 w-4" /></Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-body">{c.name}</span>
                    {c.isSystem ? (
                      // Built-in categories are targets of automatic postings (payroll,
                      // purchases), so renaming them is refused server-side too.
                      <Badge variant="neutral"><Lock className="mr-1 h-3 w-3" />System</Badge>
                    ) : (
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setEditingId(c.id); setEditName(c.name); }}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
