'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import {
  BookUp, Lock, RefreshCw, KeyRound, Ban, CircleCheck, CircleAlert, Clock, Copy, Wifi, WifiOff,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { cn, formatINR, ist } from '@/lib/utils';
import { apiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/store/auth.store';
import {
  useTallySettings, useUpdateTallyConfig, useSaveLedgerMap, useRotateAgentToken,
  useTallyQueue, useRetryTallyItem,
  type TallyConfig, type LedgerMapRow, type TallySyncStatus, type QueueRow,
} from '@/hooks/useTally';

type Tab = 'dashboard' | 'excluded' | 'settings' | 'ledgers';

export default function TallyPage() {
  const role = useAuthStore((s) => s.user?.role);
  const [tab, setTab] = useState<Tab>('dashboard');

  if (role !== 'SUPER_ADMIN') {
    return (
      <Card className="flex flex-col items-center gap-3 py-16 text-center">
        <Lock className="h-8 w-8 text-muted-foreground" />
        <p className="text-body text-muted-foreground">Only the main owner can manage the Tally sync.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <AgentStatusBar />
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {([
          ['dashboard', 'Sync Dashboard'],
          ['excluded', 'Excluded (non-GST)'],
          ['settings', 'Settings'],
          ['ledgers', 'Ledger Mapping'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              'shrink-0 border-b-2 px-3 py-2 text-body font-medium transition-colors',
              tab === k ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <QueueView mode="active" />}
      {tab === 'excluded' && <QueueView mode="excluded" />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'ledgers' && <LedgerTab />}
    </div>
  );
}

/* ─────────────────────────── Agent status ─────────────────────────── */

function AgentStatusBar() {
  const { data } = useTallySettings();
  const online = data?.agentOnline;
  const enabled = data?.config.syncEnabled;

  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-md', online ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground')}>
        {online ? <Wifi className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">
          Sync agent {online ? 'online' : 'not connected'}
          {data?.config.agentLabel ? ` · ${data.config.agentLabel}` : ''}
        </p>
        <p className="text-caption text-muted-foreground">
          {data?.config.tallyCompanyName ? `Tally company: ${data.config.tallyCompanyName} · ` : ''}
          One-way push, ERP → Tally. {enabled ? 'Sync is ON.' : 'Sync is OFF — turn it on in Settings once mapping is done.'}
        </p>
      </div>
      <Badge variant={enabled ? 'success' : 'neutral'}>{enabled ? 'Sync ON' : 'Sync OFF'}</Badge>
    </Card>
  );
}

/* ─────────────────────────── Queue ─────────────────────────── */

const STATUS_META: Record<TallySyncStatus, { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral'; icon: typeof Clock }> = {
  SYNCED: { label: 'In Tally', variant: 'success', icon: CircleCheck },
  PENDING: { label: 'Waiting', variant: 'warning', icon: Clock },
  FAILED: { label: 'Failed', variant: 'danger', icon: CircleAlert },
  EXCLUDED: { label: 'Excluded', variant: 'neutral', icon: Ban },
};

const ENTITY_LABEL: Record<string, string> = {
  SALES_BILL: 'Franchise sale', POS_SALE: 'Counter sale', PAYMENT_IN: 'Payment received',
  PURCHASE_BILL: 'Purchase', SUPPLIER_PAYMENT: 'Supplier payment', EXPENSE: 'Expense',
  STOCK_TRANSFER: 'Stock transfer', RAW_INTAKE: 'Stock intake',
};

function QueueView({ mode }: { mode: 'active' | 'excluded' }) {
  const [status, setStatus] = useState<TallySyncStatus | ''>(mode === 'excluded' ? 'EXCLUDED' : '');
  const [page, setPage] = useState(1);
  const q = useTallyQueue({
    status: mode === 'excluded' ? 'EXCLUDED' : (status || undefined),
    page,
  });
  const retry = useRetryTallyItem();

  const doRetry = (id: string) =>
    retry.mutate(id, {
      onSuccess: () => toast.success('Queued for another attempt'),
      onError: (e) => toast.error(apiErrorMessage(e)),
    });

  const counts = q.data?.counts;

  return (
    <div className="space-y-4">
      {counts && mode === 'active' && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(['SYNCED', 'PENDING', 'FAILED', 'EXCLUDED'] as TallySyncStatus[]).map((s) => {
            const m = STATUS_META[s];
            return (
              <button
                key={s}
                onClick={() => { setStatus(status === s ? '' : s); setPage(1); }}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  status === s ? 'border-primary bg-primary/5' : 'border-border hover:bg-surface',
                )}
              >
                <p className="text-caption text-muted-foreground">{m.label}</p>
                <p className="text-page-heading font-bold tabular-nums">{counts[s] ?? 0}</p>
              </button>
            );
          })}
        </div>
      )}

      {mode === 'excluded' && (
        <Card className="border-warning/30 bg-warning/5 p-3 text-caption text-muted-foreground">
          These entries were <span className="font-medium text-foreground">deliberately not sent to Tally</span> — mostly non-GST
          purchases from unregistered vendors. They stay in the ERP for the owner&apos;s cost tracking. This is the audit trail
          proving the system skipped them on purpose.
        </Card>
      )}

      {q.isLoading ? (
        <Card className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</Card>
      ) : !q.data?.rows.length ? (
        <Card className="flex flex-col items-center gap-2 py-14 text-center">
          <BookUp className="h-7 w-7 text-muted-foreground" />
          <p className="text-body text-muted-foreground">Nothing here yet.</p>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Transaction</TH>
                <TH>Reference</TH>
                <TH className="text-right">Amount</TH>
                <TH>Date</TH>
                <TH>Status</TH>
                <TH>Detail</TH>
                <TH className="text-right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.rows.map((r) => <QueueRowView key={r.id} r={r} onRetry={doRetry} retrying={retry.isPending} />)}
            </TBody>
          </Table>
        </Card>
      )}

      {q.data && q.data.meta.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-caption">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
          <span className="text-muted-foreground">Page {page} / {q.data.meta.totalPages}</span>
          <Button size="sm" variant="secondary" disabled={page >= q.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}

function QueueRowView({ r, onRetry, retrying }: { r: QueueRow; onRetry: (id: string) => void; retrying: boolean }) {
  const m = STATUS_META[r.status];
  return (
    <TR>
      <TD>
        <p className="font-medium">{ENTITY_LABEL[r.entityType] ?? r.entityType}</p>
        <p className="text-caption text-muted-foreground">{r.voucherType} voucher{r.revision > 0 ? ` · rev ${r.revision}` : ''}</p>
      </TD>
      <TD className="whitespace-nowrap font-mono text-caption">{r.docNumber ?? '—'}<br /><span className="text-muted-foreground">{r.partyName ?? ''}</span></TD>
      <TD className="text-right tabular-nums">{formatINR(r.amount)}</TD>
      <TD className="whitespace-nowrap text-caption">{format(ist(r.entityDate), 'dd MMM yyyy')}</TD>
      <TD>
        <Badge variant={m.variant}><m.icon className="mr-1 -ml-0.5 inline h-3 w-3" />{m.label}</Badge>
        {r.status === 'PENDING' && !r.isReady && <p className="mt-0.5 text-caption text-muted-foreground">building…</p>}
      </TD>
      <TD className="max-w-[22rem]">
        {r.status === 'FAILED' && <p className="text-caption text-danger">{r.errorMessage}</p>}
        {r.status === 'EXCLUDED' && <p className="text-caption text-muted-foreground">{r.excludedReason}</p>}
        {r.status === 'SYNCED' && <p className="text-caption text-muted-foreground">Tally id {r.tallyVoucherId ?? '—'}</p>}
        {r.status === 'PENDING' && <p className="text-caption text-muted-foreground">{r.isReady ? 'Ready — agent will post it' : 'Preparing the voucher'}</p>}
      </TD>
      <TD className="text-right">
        {r.status === 'FAILED' && (
          <Button size="sm" variant="secondary" loading={retrying} onClick={() => onRetry(r.id)}>
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </Button>
        )}
      </TD>
    </TR>
  );
}

/* ─────────────────────────── Settings ─────────────────────────── */

const TOGGLE_GROUPS: Array<{ title: string; items: Array<{ key: keyof TallyConfig; label: string; hint?: string }> }> = [
  {
    title: 'Which modules sync',
    items: [
      { key: 'syncSales', label: 'Sales — franchise bills & counter sales' },
      { key: 'syncReceipts', label: 'Receipts — payments received' },
      { key: 'syncPurchases', label: 'Purchases — GST supplier bills & payments' },
      { key: 'syncExpenses', label: 'Expenses — including salaries & advances' },
      { key: 'syncStockJournal', label: 'Stock journal — godown ⇄ branch transfers', hint: 'Only when Tally also mirrors inventory' },
    ],
  },
  {
    title: 'Ledger provisioning',
    items: [
      {
        key: 'autoProvisionLedgers',
        label: 'Let the agent create missing ledgers in Tally itself',
        hint: 'Outlets, suppliers, sales/purchase/expense/bank ledgers only — never the 6 GST ledgers, create those yourself via Tally’s ledger wizard. Safe for a fresh/test company; leave OFF once real books are involved unless you want to review each one first.',
      },
    ],
  },
];

/**
 * `notYetActive` marks a setting the sync does not read yet. It stays visible so
 * the accounting decision is still recorded, but it is disabled and labelled —
 * a toggle that silently does nothing is worse than no toggle, because it turns
 * an open question into a false assurance about the client's statutory books.
 */
const CHOICE: Array<{ key: keyof TallyConfig; label: string; options: Array<[string, string]>; hint?: string; notYetActive?: boolean }> = [
  { key: 'inventoryMode', label: 'What Tally holds', options: [['ACCOUNTING_ONLY', 'Accounting vouchers only (recommended)'], ['WITH_STOCK_JOURNALS', 'Also mirror stock']], hint: 'Recommended: keep stock in the ERP only; Tally gets the books.' },
  { key: 'accruedExpenseMode', label: 'Unpaid (accrued) expenses', options: [['ON_PAYMENT', 'Only sync once actually paid'], ['JOURNAL_NOW', 'Journal now, payment later']] },
  { key: 'posSupplyKind', label: 'Counter sales are', options: [['GOODS', 'Retail sale of packaged goods (HSN, ITC)'], ['RESTAURANT', 'Restaurant service (SAC, no ITC)']], hint: 'Ask your CA which applies. Counter sales currently always post as goods.', notYetActive: true },
  { key: 'razorpayReceiptMode', label: 'Razorpay receipts', options: [['CLEARING', 'Gross → Razorpay clearing ledger'], ['DIRECT_BANK', 'Gross → bank directly']], hint: 'Razorpay currently always posts to whichever ledger the Razorpay payment method is mapped to.', notYetActive: true },
  { key: 'discountMode', label: 'POS discounts', options: [['SEPARATE_LEDGER', 'Separate Discount Allowed ledger'], ['NET_OFF_SALES', 'Net off sales']], hint: 'Discounts are currently always netted into the sale.', notYetActive: true },
  { key: 'closingStockBasis', label: 'Closing-stock value basis', options: [['GST_PURCHASE_STOCK', 'GST-purchase stock only'], ['TOTAL_ERP_STOCK', 'Total ERP stock']], hint: 'CA must confirm — non-GST purchases are off the books. No closing-stock journal is posted yet.', notYetActive: true },
  { key: 'closingStockMode', label: 'Post closing stock', options: [['MANUAL', 'Never — the CA does it in Tally'], ['MONTHLY', 'Monthly'], ['ON_DEMAND', 'On demand']], hint: 'Not implemented yet; closing stock stays a manual entry in Tally.', notYetActive: true },
  { key: 'posVoucherGranularity', label: 'POS voucher style', options: [['PER_BILL', 'One voucher per counter bill'], ['DAILY_SUMMARY', 'One summary per day per payment mode']], hint: 'Currently always one voucher per bill.', notYetActive: true },
];

function SettingsTab() {
  const { data } = useTallySettings();
  const update = useUpdateTallyConfig();
  const rotate = useRotateAgentToken();
  const [newToken, setNewToken] = useState<string | null>(null);
  const [cutover, setCutover] = useState('');

  const cfg = data?.config;
  useEffect(() => { if (cfg?.syncFromDate) setCutover(cfg.syncFromDate.slice(0, 10)); }, [cfg?.syncFromDate]);

  const set = (patch: Partial<TallyConfig>) =>
    update.mutate(patch, { onError: (e) => toast.error(apiErrorMessage(e)) });

  if (!cfg) return <Card className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</Card>;

  return (
    <div className="space-y-5">
      {/* Agent connection */}
      <Card className="space-y-3 p-4">
        <p className="text-body font-medium">Local sync agent</p>
        <p className="text-caption text-muted-foreground">
          Install the Mumbai ERP Sync Agent on the office PC that runs Tally. Pair it once with the token below — it connects
          outward to this server; no ports need opening on your router.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={cfg.agentPaired ? 'success' : 'neutral'}>{cfg.agentPaired ? 'Agent paired' : 'Not paired'}</Badge>
          {data?.agentOnline && <Badge variant="success">Online now</Badge>}
          <Button
            size="sm"
            variant="secondary"
            loading={rotate.isPending}
            onClick={() => rotate.mutate(undefined, {
              onSuccess: (d) => { setNewToken(d.token); toast.success('New token — copy it now'); },
              onError: (e) => toast.error(apiErrorMessage(e)),
            })}
          >
            <KeyRound className="h-3.5 w-3.5" /> {cfg.agentPaired ? 'Regenerate token' : 'Generate token'}
          </Button>
        </div>
        {newToken && (
          <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5">
            <code className="flex-1 break-all text-caption">{newToken}</code>
            <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(newToken); toast.success('Copied'); }}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1"><Label>Tally host</Label><Input defaultValue={cfg.tallyHost} onBlur={(e) => e.target.value !== cfg.tallyHost && set({ tallyHost: e.target.value })} /></div>
          <div className="space-y-1"><Label>Tally port</Label><Input type="number" defaultValue={cfg.tallyPort} onBlur={(e) => Number(e.target.value) !== cfg.tallyPort && set({ tallyPort: Number(e.target.value) })} /></div>
          <div className="space-y-1"><Label>Tally company name</Label><Input defaultValue={cfg.tallyCompanyName ?? ''} placeholder="Exactly as in Tally" onBlur={(e) => e.target.value !== (cfg.tallyCompanyName ?? '') && set({ tallyCompanyName: e.target.value || null })} /></div>
        </div>
      </Card>

      {/* Master switch */}
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium">Sync {cfg.syncEnabled ? 'is ON' : 'is OFF'}</p>
          <p className="text-caption text-muted-foreground">Turn this on once the ledger mapping is done and validated. Nothing is pushed while it is off.</p>
        </div>
        <Button variant={cfg.syncEnabled ? 'secondary' : 'primary'} onClick={() => set({ syncEnabled: !cfg.syncEnabled })}>
          {cfg.syncEnabled ? 'Turn sync off' : 'Turn sync on'}
        </Button>
      </Card>

      <Card className="space-y-3 p-4">
        <Label>Go-live cutover date</Label>
        <p className="text-caption text-muted-foreground">Only transactions on or after this date are synced. Opening balances and history stay your CA&apos;s job in Tally.</p>
        <div className="flex items-center gap-2">
          <Input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)} className="w-44" />
          <Button size="sm" onClick={() => set({ syncFromDate: cutover ? new Date(cutover).toISOString() : null })}>Save</Button>
        </div>
      </Card>

      {/* Module toggles */}
      {TOGGLE_GROUPS.map((g) => (
        <Card key={g.title} className="space-y-1 p-4">
          <p className="mb-2 text-body font-medium">{g.title}</p>
          {g.items.map((it) => (
            <label key={String(it.key)} className="flex items-start justify-between gap-3 border-b border-border py-2.5 last:border-0">
              <span>
                <span className="text-body">{it.label}</span>
                {it.hint && <span className="block text-caption text-muted-foreground">{it.hint}</span>}
              </span>
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0"
                checked={Boolean(cfg[it.key])}
                onChange={(e) => set({ [it.key]: e.target.checked } as Partial<TallyConfig>)}
              />
            </label>
          ))}
        </Card>
      ))}

      {/* Behaviour choices */}
      <Card className="space-y-4 p-4">
        <p className="text-body font-medium">Accounting treatment</p>
        {CHOICE.map((c) => (
          <div key={String(c.key)} className="grid gap-1.5 sm:grid-cols-[1fr,18rem] sm:items-center">
            <span>
              <span className="text-body">
                {c.label}
                {c.notYetActive && <Badge variant="warning" className="ml-2 align-middle">Not active yet</Badge>}
              </span>
              {c.hint && <span className="block text-caption text-muted-foreground">{c.hint}</span>}
            </span>
            <Select
              value={String(cfg[c.key])}
              disabled={c.notYetActive}
              onChange={(e) => set({ [c.key]: e.target.value } as Partial<TallyConfig>)}
            >
              {c.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
        ))}
        <label className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="text-body">
            Hold a voucher whose GST doesn&apos;t add up
            <span className="block text-caption text-muted-foreground">
              Checks each line&apos;s tax against its own quantity, rate and percentage, and the lines against the
              document total. Historical rates are respected — this catches mis-entry, not old rates.
            </span>
          </span>
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={cfg.blockOnRateMismatch}
            onChange={(e) => set({ blockOnRateMismatch: e.target.checked })}
          />
        </label>
      </Card>
    </div>
  );
}

/* ─────────────────────────── Ledger mapping ─────────────────────────── */

const SLOT_LABEL: Record<LedgerMapRow['slot'], string> = {
  GST: 'GST ledgers', SALES: 'Sales ledgers', PURCHASE: 'Purchase ledgers',
  BANK_CASH: 'Bank & cash (by payment method)', EXPENSE: 'Expense categories',
  PARTY_OUTLET: 'Franchise outlets (Sundry Debtors)', PARTY_SUPPLIER: 'GST suppliers (Sundry Creditors)',
  SPECIAL: 'Other ledgers',
};
const SLOT_ORDER: LedgerMapRow['slot'][] = ['PARTY_OUTLET', 'PARTY_SUPPLIER', 'SALES', 'PURCHASE', 'GST', 'BANK_CASH', 'EXPENSE', 'SPECIAL'];

function LedgerTab() {
  const { data } = useTallySettings();
  const save = useSaveLedgerMap();
  const [draft, setDraft] = useState<Record<string, string>>({});

  const rows = data?.ledgerMap ?? [];
  const grouped = useMemo(() => {
    const m = new Map<LedgerMapRow['slot'], LedgerMapRow[]>();
    for (const r of rows) { const a = m.get(r.slot) ?? []; a.push(r); m.set(r.slot, a); }
    return m;
  }, [rows]);

  const dirty = Object.keys(draft).length > 0;
  const onSave = () => {
    const payload = rows
      .filter((r) => draft[r.id] !== undefined && draft[r.id] !== r.tallyLedgerName)
      .map((r) => ({ id: r.id, tallyLedgerName: draft[r.id], tallyParentGroup: r.tallyParentGroup, notes: r.notes }));
    if (!payload.length) { setDraft({}); return; }
    save.mutate(payload, {
      onSuccess: () => { toast.success('Ledger mapping saved'); setDraft({}); },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  if (!data) return <Card className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</Card>;

  return (
    <div className="space-y-4">
      <Card className="p-3 text-caption text-muted-foreground">
        Every name below must match a ledger that <span className="font-medium text-foreground">already exists in your Tally</span>.
        We pre-filled the recommended names — correct them to your chart of accounts. A voucher that hits an unknown ledger
        fails with Tally&apos;s own message and waits for a Retry.
      </Card>

      {SLOT_ORDER.filter((s) => grouped.has(s)).map((slot) => (
        <Card key={slot} className="overflow-x-auto">
          <p className="border-b border-border px-4 py-2.5 text-body font-medium">{SLOT_LABEL[slot]}</p>
          <Table>
            <THead>
              <TR><TH>ERP item</TH><TH>Tally ledger name</TH><TH>Group</TH><TH>In Tally?</TH></TR>
            </THead>
            <TBody>
              {(grouped.get(slot) ?? []).map((r) => (
                <TR key={r.id}>
                  <TD className="align-middle">{r.slotLabel}</TD>
                  <TD>
                    <Input
                      value={draft[r.id] ?? r.tallyLedgerName}
                      onChange={(e) => setDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                      className="h-9"
                    />
                  </TD>
                  <TD className="align-middle text-caption text-muted-foreground">{r.tallyParentGroup ?? '—'}</TD>
                  <TD className="align-middle">
                    {r.validatedAt
                      ? <Badge variant="success">Confirmed</Badge>
                      : <Badge variant="neutral">Not yet</Badge>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ))}

      <div className="sticky bottom-4 flex justify-end">
        <Button disabled={!dirty} loading={save.isPending} onClick={onSave}>
          Save mapping{dirty ? ` (${Object.keys(draft).length})` : ''}
        </Button>
      </div>
    </div>
  );
}
