'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, format } from 'date-fns';
import toast from 'react-hot-toast';
import { Plus, Trash2, Boxes, Tag, Sparkles, Package, Search, ReceiptText, FileX, Check, X } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { cn, formatINR, istDateInput, todayIso } from '@/lib/utils';
import { apiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/store/auth.store';
import { useRawMaterials, useProducts } from '@/hooks/useProducts';
import { useExpenseCategories, useCreateExpenseCategory } from '@/hooks/useExpenses';
import { useRecordPurchase, useUpdatePurchase, type PurchaseItemInput, type PurchaseBillDetail } from '@/hooks/useProduction';
import { useContacts } from '@/hooks/useContacts';
import { useGstLookup } from '@/hooks/useGst';

const METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD'];
const HOME_STATE = '24'; // Gujarat
const GST_RATES = [0, 5, 12, 18, 28];
const CREDIT_DAY_OPTIONS = [7, 15, 30, 45, 60];
const today = () => todayIso();

type Line =
  | { kind: 'RAW_MATERIAL'; rawMaterialId: string; quantity: number; costPerUnit: number; taxRate: number; hsnCode: string; isAsset: boolean }
  | { kind: 'FINISHED_GOOD'; productId: string; quantity: number; costPerUnit: number; taxRate: number; hsnCode: string; isAsset: boolean }
  | { kind: 'OTHER'; categoryId: string; description: string; amount: number; taxRate: number; hsnCode: string; isAsset: boolean };

const KIND_META: Record<Line['kind'], { label: string; icon: typeof Boxes }> = {
  RAW_MATERIAL: { label: 'Raw material', icon: Boxes },
  FINISHED_GOOD: { label: 'Finished good', icon: Package },
  OTHER: { label: 'Other', icon: Tag },
};

export function PurchaseDialog({ open, onOpenChange, editBill }: { open: boolean; onOpenChange: (v: boolean) => void; editBill?: PurchaseBillDetail | null }) {
  // A branch buys its own supplies; it never receives goods into the company's
  // godown and does not keep the asset register. So it gets expense lines only —
  // the API refuses anything else (see assertBranchLinesAllowed). The godown-only
  // reference lists below would 403 for them, so those queries stay switched off.
  const isBranch = useAuthStore((st) => st.user?.role) === 'FRANCHISE_OWNER';
  const { data: materials } = useRawMaterials({}, !isBranch);
  const { data: productsData } = useProducts({ isPosEnabled: false }, !isBranch);
  const { data: categories } = useExpenseCategories();
  const createCategory = useCreateExpenseCategory();
  const { data: suppliers } = useContacts({ type: 'SUPPLIER' }, !isBranch);
  const record = useRecordPurchase();
  const updateMutation = useUpdatePurchase();
  const lookup = useGstLookup();
  const isEdit = !!editBill;

  const [isGstBill, setIsGstBill] = useState(true);
  const [supplierName, setSupplier] = useState('');
  const [supplierGstin, setGstin] = useState('');
  const [supplierState, setSupplierState] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [invoiceNumber, setInvoice] = useState('');
  const [billDate, setBillDate] = useState(today());
  const [paymentMethod, setMethod] = useState('CASH');
  const [payMode, setPayMode] = useState<'full' | 'credit' | 'partial'>('full');
  const [customPaid, setCustomPaid] = useState(0);
  const [creditDays, setCreditDays] = useState(30);
  const [roundOff, setRoundOff] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  // Which "Other" line (by index) is currently typing a brand-new category, and
  // the name being typed. -1 = none.
  const [newCatLine, setNewCatLine] = useState(-1);
  const [newCatName, setNewCatName] = useState('');
  const supplierBoxRef = useRef<HTMLDivElement>(null);

  const rmList = materials?.rows ?? [];
  const prodList = productsData?.rows ?? [];
  const catList = categories ?? [];
  const supplierList = suppliers ?? [];
  const newRawLine = (): Line => { const f = rmList[0]; return { kind: 'RAW_MATERIAL', rawMaterialId: f?.id ?? '', quantity: 1, costPerUnit: Number(f?.costPerUnit ?? 0), taxRate: 5, hsnCode: '', isAsset: false }; };
  const newFgLine = (): Line => { const f = prodList[0]; return { kind: 'FINISHED_GOOD', productId: f?.id ?? '', quantity: 1, costPerUnit: Number(f?.basePrice ?? 0), taxRate: Number(f?.taxPercent ?? 5), hsnCode: '', isAsset: false }; };
  const newOtherLine = (): Line => ({ kind: 'OTHER', categoryId: catList[0]?.id ?? '', description: '', amount: 0, taxRate: 18, hsnCode: '', isAsset: false });

  // Initialise the form exactly ONCE per open, not on every reference-data
  // change. Creating a category inline invalidates the categories query mid-
  // edit; without this guard the effect below would re-fire on that change and
  // wipe the in-progress bill. For a new bill we wait until the reference data
  // has resolved so the seeded first line points at a real material/category.
  const initedRef = useRef(false);
  useEffect(() => {
    if (!open) { initedRef.current = false; return; }
    if (initedRef.current) return;

    if (editBill) {
      initedRef.current = true;
      setIsGstBill(editBill.isGstBill);
      setSupplier(editBill.supplierName ?? ''); setGstin(editBill.supplierGstin ?? '');
      setSupplierState(''); setShowSuggestions(false);
      setInvoice(editBill.invoiceNumber ?? ''); setBillDate(istDateInput(editBill.billDate));
      setMethod(editBill.paymentMethod ?? 'CASH');
      const paid = Number(editBill.amountPaid);
      const total = Number(editBill.totalAmount);
      setPayMode(paid <= 0 ? 'credit' : paid >= total ? 'full' : 'partial');
      setCustomPaid(paid);
      setCreditDays(editBill.creditDays ?? 30);
      setRoundOff(Number(editBill.roundOff ?? 0));
      setNewCatLine(-1); setNewCatName('');
      setLines(
        editBill.items.map((it): Line => {
          if (it.kind === 'RAW_MATERIAL') return { kind: 'RAW_MATERIAL', rawMaterialId: it.refId ?? '', quantity: Number(it.quantity ?? 0), costPerUnit: Number(it.unitCost ?? 0), taxRate: Number(it.taxRate), hsnCode: it.hsnCode ?? '', isAsset: !!it.isAsset };
          if (it.kind === 'FINISHED_GOOD') return { kind: 'FINISHED_GOOD', productId: it.refId ?? '', quantity: Number(it.quantity ?? 0), costPerUnit: Number(it.unitCost ?? 0), taxRate: Number(it.taxRate), hsnCode: it.hsnCode ?? '', isAsset: !!it.isAsset };
          return { kind: 'OTHER', categoryId: it.refId ?? '', description: '', amount: Number(it.taxableAmount), taxRate: Number(it.taxRate), hsnCode: it.hsnCode ?? '', isAsset: !!it.isAsset };
        }),
      );
      return;
    }

    // New bill: hold off until both reference queries have resolved (even to an
    // empty list) so the first seeded line isn't stuck with a blank id.
    if ((!isBranch && materials === undefined) || categories === undefined) return;
    initedRef.current = true;
    setIsGstBill(true);
    setSupplier(''); setGstin(''); setSupplierState(''); setShowSuggestions(false);
    setInvoice(''); setBillDate(today()); setMethod('CASH'); setPayMode('full'); setCustomPaid(0); setCreditDays(30); setRoundOff(0);
    setNewCatLine(-1); setNewCatName('');
    setLines(isBranch || !rmList.length ? (catList.length ? [newOtherLine()] : []) : [newRawLine()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editBill, materials, categories]);

  // Close the supplier suggestion list on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (supplierBoxRef.current && !supplierBoxRef.current.contains(e.target as Node)) setShowSuggestions(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const update = (i: number, patch: Partial<Line>) => setLines((l) => l.map((row, idx) => (idx === i ? ({ ...row, ...patch } as Line) : row)));
  const setKind = (i: number, kind: Line['kind']) =>
    setLines((l) => l.map((row, idx) => {
      if (idx !== i) return row;
      const fresh = kind === 'RAW_MATERIAL' ? newRawLine() : kind === 'FINISHED_GOOD' ? newFgLine() : newOtherLine();
      // The factory resets the row, so preserve the asset tick the user already made.
      return { ...fresh, isAsset: row.isAsset };
    }));
  const onMaterial = (i: number, id: string) => { const m = rmList.find((r) => r.id === id); update(i, { rawMaterialId: id, costPerUnit: Number(m?.costPerUnit ?? 0) } as Partial<Line>); };
  const onProduct = (i: number, id: string) => { const p = prodList.find((x) => x.id === id); update(i, { productId: id, costPerUnit: Number(p?.basePrice ?? 0), taxRate: Number(p?.taxPercent ?? 5) } as Partial<Line>); };
  const remove = (i: number) => setLines((l) => l.filter((_, idx) => idx !== i));

  const startNewCategory = (i: number) => { setNewCatLine(i); setNewCatName(''); };
  const cancelNewCategory = () => { setNewCatLine(-1); setNewCatName(''); };
  const saveNewCategory = (i: number) => {
    const name = newCatName.trim();
    if (name.length < 2) { toast.error('Enter a category name'); return; }
    createCategory.mutate(name, {
      onSuccess: (c) => { update(i, { categoryId: c.id } as Partial<Line>); cancelNewCategory(); toast.success(`Category "${c.name}" added`); },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  const lineBase = (l: Line) => (l.kind === 'OTHER' ? l.amount : l.quantity * l.costPerUnit);
  const lineTax = (l: Line) => (isGstBill ? Math.round(lineBase(l) * l.taxRate) / 100 : 0);
  const taxable = lines.reduce((s, l) => s + lineBase(l), 0);
  const taxTotal = lines.reduce((s, l) => s + lineTax(l), 0);
  const subtotal = taxable + taxTotal;
  const grand = Math.max(0, subtotal + roundOff);
  const intraState = !supplierGstin || supplierGstin.slice(0, 2) === HOME_STATE;
  const cgst = intraState ? taxTotal / 2 : 0;
  const igst = intraState ? 0 : taxTotal;
  const paidNow = payMode === 'full' ? grand : payMode === 'credit' ? 0 : Math.min(Math.max(0, customPaid), grand);
  const balance = Math.max(0, grand - paidNow);
  const dueDatePreview = balance > 0 && creditDays > 0 ? addDays(new Date(billDate), creditDays) : null;

  const supplierSuggestions = useMemo(() => {
    const q = supplierName.trim().toLowerCase();
    if (!q) return [];
    return supplierList.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 6);
  }, [supplierList, supplierName]);

  const pickSupplier = (id: string) => {
    const s = supplierList.find((x) => x.id === id);
    if (!s) return;
    setSupplier(s.name);
    setGstin(s.gstin ?? '');
    setSupplierState(s.stateName ?? '');
    setShowSuggestions(false);
  };

  const fetchGstin = () => {
    const g = supplierGstin.trim().toUpperCase();
    if (g.length !== 15) { toast.error('Enter a 15-character GSTIN'); return; }
    lookup.mutate(g, {
      onSuccess: (r) => {
        setGstin(r.gstin); setSupplierState(r.stateName ?? '');
        if (!supplierName && (r.tradeName || r.legalName)) setSupplier(r.tradeName || r.legalName || '');
        toast.success(r.source === 'gstzen' ? `Fetched · ${r.stateName ?? ''}` : `Valid GSTIN · ${r.stateName ?? ''}`);
      },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  const submit = () => {
    if (!lines.length) { toast.error('Add at least one line'); return; }
    for (const l of lines) {
      if (l.kind === 'RAW_MATERIAL' && (!l.rawMaterialId || l.quantity <= 0)) { toast.error('Fill all raw-material lines'); return; }
      if (l.kind === 'FINISHED_GOOD' && (!l.productId || l.quantity <= 0)) { toast.error('Fill all finished-good lines'); return; }
      if (l.kind === 'OTHER' && (!l.categoryId || l.amount <= 0)) { toast.error('Fill all other lines'); return; }
    }
    const items: PurchaseItemInput[] = lines.map((l) =>
      l.kind === 'RAW_MATERIAL'
        ? { kind: 'RAW_MATERIAL', rawMaterialId: l.rawMaterialId, quantity: l.quantity, costPerUnit: l.costPerUnit, taxRate: l.taxRate, hsnCode: l.hsnCode || undefined, isAsset: l.isAsset }
        : l.kind === 'FINISHED_GOOD'
          ? { kind: 'FINISHED_GOOD', productId: l.productId, quantity: l.quantity, costPerUnit: l.costPerUnit, taxRate: l.taxRate, hsnCode: l.hsnCode || undefined, isAsset: l.isAsset }
          : { kind: 'OTHER', categoryId: l.categoryId, description: l.description || undefined, amount: l.amount, taxRate: l.taxRate, hsnCode: l.hsnCode || undefined, isAsset: l.isAsset },
    );
    const payload = {
      supplierName: supplierName || undefined, supplierGstin: supplierGstin || undefined, supplierStateName: supplierState || undefined,
      invoiceNumber: invoiceNumber || undefined,
      intakeDate: billDate, paymentMethod, amountPaidNow: paidNow, isGstBill, roundOff,
      creditDays: balance > 0 ? creditDays : undefined,
      items,
    };
    const onSettled = {
      onSuccess: (r: { billNumber: string; totalCost: string; status: string }) => {
        toast.success(`Purchase ${r.billNumber} · ${formatINR(r.totalCost)} · ${r.status.replace('_', ' ').toLowerCase()}`);
        onOpenChange(false);
      },
      onError: (e: unknown) => toast.error(apiErrorMessage(e)),
    };
    if (isEdit && editBill) updateMutation.mutate({ id: editBill.id, ...payload }, onSettled);
    else record.mutate(payload, onSettled);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit Purchase Bill ${editBill?.billNumber ?? ''}` : 'Record Purchase Bill'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Saving replaces the old lines — stock/cost are reversed and reapplied under the same bill number.'
              : 'Raw materials go to inventory (cost ex-GST); GST is captured as input tax credit. Other items book as expenses.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <span className="text-caption font-medium text-muted-foreground">Bill type</span>
          <div className="flex overflow-hidden rounded-md border border-border">
            <button type="button" onClick={() => setIsGstBill(true)} className={cn('flex items-center gap-1.5 px-3 py-1.5 text-caption font-medium', isGstBill ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground')}>
              <ReceiptText className="h-3.5 w-3.5" /> With GST
            </button>
            <button type="button" onClick={() => setIsGstBill(false)} className={cn('flex items-center gap-1.5 px-3 py-1.5 text-caption font-medium', !isGstBill ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground')}>
              <FileX className="h-3.5 w-3.5" /> Without GST
            </button>
          </div>
          {!isGstBill && <span className="text-caption text-muted-foreground">Unregistered / composition supplier — no tax, no input tax credit.</span>}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div ref={supplierBoxRef} className="relative space-y-1.5 sm:col-span-1">
            <Label>Supplier name</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                value={supplierName}
                onChange={(e) => { setSupplier(e.target.value); setShowSuggestions(true); }}
                onFocus={() => setShowSuggestions(true)}
                placeholder="e.g. APMC Vashi"
                autoComplete="off"
              />
            </div>
            {showSuggestions && supplierSuggestions.length > 0 && (
              <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-card shadow-lg">
                {supplierSuggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onMouseDown={() => pickSupplier(s.id)}
                    className="flex w-full flex-col items-start px-3 py-1.5 text-left text-body hover:bg-accent"
                  >
                    <span className="font-medium">{s.name}</span>
                    {(s.gstin || s.phone) && <span className="text-caption text-muted-foreground">{[s.gstin, s.phone].filter(Boolean).join(' · ')}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5 sm:col-span-1">
            <Label>Supplier GSTIN</Label>
            <div className="flex gap-2">
              <Input value={supplierGstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="24ABCDE1234F1Z5" maxLength={15} />
              <Button type="button" variant="secondary" loading={lookup.isPending} onClick={fetchGstin}><Sparkles className="h-4 w-4" /></Button>
            </div>
            {supplierState && <p className="text-caption text-muted-foreground">{supplierState}{isGstBill ? ` · ${intraState ? 'CGST+SGST' : 'IGST'}` : ''}</p>}
          </div>
          <div className="space-y-1.5"><Label>Bill date</Label><Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} max={today()} /></div>
          <div className="space-y-1.5"><Label>Invoice No.</Label><Input value={invoiceNumber} onChange={(e) => setInvoice(e.target.value)} placeholder="e.g. INV-1042" /></div>
        </div>

        <div className="max-h-[38vh] overflow-y-auto rounded-md border border-border scrollbar-thin">
          <Table>
            <THead>
              <TR>
                <TH className="w-[104px]">Type</TH>
                <TH className="min-w-[180px]">Item</TH>
                <TH className="w-[90px]">HSN</TH>
                <TH className="w-[96px] text-right">Qty</TH>
                <TH className="w-[128px] text-right">Rate / Amount</TH>
                <TH className="w-[100px] text-right">Taxable</TH>
                <TH className="w-[110px] text-right">GST</TH>
                <TH className="w-[100px] text-right">Total</TH>
                <TH className="w-8" />
              </TR>
            </THead>
            <TBody>
              {lines.map((line, i) => {
                return (
                  <TR key={i}>
                    <TD className="px-1.5 py-1.5">
                      <div className={cn('flex overflow-hidden rounded-md border border-border', isBranch && 'hidden')}>
                        {(Object.keys(KIND_META) as Line['kind'][]).map((k) => {
                          const Icon = KIND_META[k].icon;
                          return (
                            <button
                              key={k}
                              type="button"
                              title={KIND_META[k].label}
                              onClick={() => setKind(i, k)}
                              className={cn('flex h-8 w-8 items-center justify-center', line.kind === k ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-accent')}
                            >
                              <Icon className="h-3.5 w-3.5" />
                            </button>
                          );
                        })}
                      </div>
                    </TD>

                    <TD className="px-1.5 py-1.5">
                      <div className="space-y-1">
                      {line.kind === 'RAW_MATERIAL' ? (
                        <Select className="h-8" value={line.rawMaterialId} onChange={(e) => onMaterial(i, e.target.value)}>
                          {rmList.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit.name})</option>)}
                        </Select>
                      ) : line.kind === 'FINISHED_GOOD' ? (
                        <Select className="h-8" value={line.productId} onChange={(e) => onProduct(i, e.target.value)}>
                          {prodList.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit.name})</option>)}
                        </Select>
                      ) : (
                        <div className="space-y-1">
                          {newCatLine === i ? (
                            <div className="flex gap-1">
                              <Input
                                autoFocus
                                className="h-8 text-caption"
                                placeholder="New category name"
                                value={newCatName}
                                onChange={(e) => setNewCatName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveNewCategory(i); } if (e.key === 'Escape') cancelNewCategory(); }}
                              />
                              <Button type="button" size="icon" className="h-8 w-8 shrink-0" loading={createCategory.isPending} onClick={() => saveNewCategory(i)}><Check className="h-4 w-4" /></Button>
                              <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={cancelNewCategory}><X className="h-4 w-4" /></Button>
                            </div>
                          ) : (
                            <div className="flex gap-1">
                              <Select className="h-8" value={line.categoryId} onChange={(e) => update(i, { categoryId: e.target.value } as Partial<Line>)}>
                                {catList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                              </Select>
                              <Button type="button" size="icon" variant="secondary" className="h-8 w-8 shrink-0" title="New category" onClick={() => startNewCategory(i)}><Plus className="h-4 w-4" /></Button>
                            </div>
                          )}
                          <Input className="h-7 text-caption" placeholder="Description (optional)" value={line.description} onChange={(e) => update(i, { description: e.target.value } as Partial<Line>)} />
                        </div>
                      )}
                      {/* Ticking this sends the line to the asset register instead of
                          stock/expense — a capital buy shouldn't hit this month's P&L. */}
                      {!isBranch && (
                        <label className="flex cursor-pointer items-center gap-1.5 text-caption text-muted-foreground">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={line.isAsset}
                            onChange={(e) => update(i, { isAsset: e.target.checked } as Partial<Line>)}
                          />
                          Is Asset?
                        </label>
                      )}
                      </div>
                    </TD>

                    <TD className="px-1.5 py-1.5"><Input className="h-8" placeholder="HSN" value={line.hsnCode} onChange={(e) => update(i, { hsnCode: e.target.value } as Partial<Line>)} /></TD>

                    <TD className="px-1.5 py-1.5">
                      {line.kind === 'OTHER' ? (
                        <p className="text-right text-muted-foreground">—</p>
                      ) : (
                        <Input type="number" step="0.01" className="h-8 text-right" value={line.quantity} onChange={(e) => update(i, { quantity: Number(e.target.value) } as Partial<Line>)} />
                      )}
                    </TD>

                    <TD className="px-1.5 py-1.5">
                      {line.kind === 'OTHER' ? (
                        <Input type="number" step="0.01" className="h-8 text-right" value={line.amount} onChange={(e) => update(i, { amount: Number(e.target.value) } as Partial<Line>)} />
                      ) : (
                        <Input type="number" step="0.01" className="h-8 text-right" value={line.costPerUnit} onChange={(e) => update(i, { costPerUnit: Number(e.target.value) } as Partial<Line>)} />
                      )}
                    </TD>

                    <TD className="px-1.5 py-1.5 text-right font-medium">{formatINR(lineBase(line))}</TD>

                    <TD className="px-1.5 py-1.5">
                      {isGstBill ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <Select className="h-8 w-16" value={line.taxRate} onChange={(e) => update(i, { taxRate: Number(e.target.value) } as Partial<Line>)}>
                            {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                          </Select>
                          <span className="w-14 shrink-0 text-right text-caption text-muted-foreground">{formatINR(lineTax(line))}</span>
                        </div>
                      ) : (
                        <p className="text-right text-muted-foreground">—</p>
                      )}
                    </TD>

                    <TD className="px-1.5 py-1.5 text-right font-semibold">{formatINR(lineBase(line) + lineTax(line))}</TD>

                    <TD className="px-1 py-1.5"><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(i)}><Trash2 className="h-4 w-4 text-danger" /></Button></TD>
                  </TR>
                );
              })}
              {lines.length === 0 && (
                <TR><TD colSpan={9} className="py-8 text-center text-muted-foreground">No lines yet — add one below.</TD></TR>
              )}
            </TBody>
          </Table>
        </div>

        <div className="flex flex-wrap gap-2">
          {!isBranch && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setLines((l) => [...l, newRawLine()])} disabled={rmList.length === 0}><Plus className="h-4 w-4" /> Raw material</Button>
              <Button variant="secondary" size="sm" onClick={() => setLines((l) => [...l, newFgLine()])} disabled={prodList.length === 0}><Plus className="h-4 w-4" /> Finished good</Button>
            </>
          )}
          <Button variant="secondary" size="sm" onClick={() => setLines((l) => [...l, newOtherLine()])} disabled={catList.length === 0}><Plus className="h-4 w-4" /> {isBranch ? 'Add item' : 'Other item'}</Button>
        </div>

        {/* GST + round-off summary */}
        <div className="space-y-1 rounded-md border border-border bg-surface p-3 text-body">
          {isGstBill ? (
            <>
              <Row label="Taxable value" value={formatINR(taxable)} />
              {intraState ? (
                <>
                  <Row label="CGST" value={formatINR(cgst)} muted />
                  <Row label="SGST" value={formatINR(taxTotal - cgst)} muted />
                </>
              ) : (
                <Row label="IGST" value={formatINR(igst)} muted />
              )}
            </>
          ) : (
            <Row label="Subtotal (no GST)" value={formatINR(taxable)} muted />
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Round off (+/-)</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                title="Round the total to the nearest rupee"
                onClick={() => setRoundOff(Math.round((Math.round(subtotal) - subtotal) * 100) / 100)}
                className="rounded-md border border-border px-2 py-1 text-caption font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Auto
              </button>
              <Input
                type="number"
                step="0.01"
                className="h-8 w-24 text-right"
                value={roundOff}
                onChange={(e) => setRoundOff(Number(e.target.value))}
              />
            </div>
          </div>

          <Row label={isGstBill ? 'Grand total' : 'Grand total (no GST)'} value={formatINR(grand)} bold />
        </div>

        {/* Payment */}
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-border">
              {([['full', 'Pay full'], ['credit', 'On credit'], ['partial', 'Partial']] as const).map(([m, l]) => (
                <button key={m} type="button" onClick={() => setPayMode(m)} className={cn('px-3 py-1.5 text-caption font-medium', payMode === m ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground')}>{l}</button>
              ))}
            </div>
            {payMode === 'partial' && <Input type="number" step="0.01" className="h-9 w-32" placeholder="Paid now" value={customPaid} onChange={(e) => setCustomPaid(Number(e.target.value))} />}
            <Select className="h-9 w-40" value={paymentMethod} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}</Select>
            <div className="ml-auto text-right text-caption"><span className="text-success">Paying {formatINR(paidNow)}</span>{balance > 0 && <span className="ml-2 text-danger">Balance {formatINR(balance)}</span>}</div>
          </div>

          {balance > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <span className="text-caption font-medium text-muted-foreground">Credit days</span>
              {CREDIT_DAY_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setCreditDays(d)}
                  className={cn('rounded-md border px-2.5 py-1 text-caption font-semibold', creditDays === d ? 'border-primary bg-accent text-primary' : 'border-border text-muted-foreground')}
                >
                  {d}
                </button>
              ))}
              <Input type="number" className="h-8 w-20" value={creditDays} onChange={(e) => setCreditDays(Math.max(0, Number(e.target.value)))} />
              {dueDatePreview && <span className="ml-auto text-caption text-muted-foreground">Due <b className="text-foreground">{format(dueDatePreview, 'dd MMM yyyy')}</b> · reminders 10 &amp; 5 days before</span>}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} loading={record.isPending || updateMutation.isPending}>{isEdit ? 'Save Changes' : 'Record Purchase'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, bold, muted }: { label: string; value: string; bold?: boolean; muted?: boolean }) {
  return <div className={cn('flex justify-between', bold && 'border-t border-border pt-1 font-semibold', muted && 'text-muted-foreground')}><span>{label}</span><span>{value}</span></div>;
}
