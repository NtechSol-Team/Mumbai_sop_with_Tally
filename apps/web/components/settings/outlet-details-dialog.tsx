'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Save, Receipt } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiErrorMessage } from '@/lib/api';
import { useSaveOutletProfile, type Outlet } from '@/hooks/useOutlets';

const empty = { name: '', legalName: '', address: '', phone: '', email: '', gstin: '', fssaiNumber: '', receiptFooter: '' };

/**
 * The outlet's own business identity. These exact values print at the top of every
 * receipt that outlet's till issues — so the form shows a live preview of the
 * receipt header, which is the only way to be sure it reads correctly on paper.
 */
export function OutletDetailsDialog({ outlet, onClose }: { outlet: Outlet | null; onClose: () => void }) {
  const save = useSaveOutletProfile(outlet?.id ?? '');
  const [form, setForm] = useState({ ...empty });

  useEffect(() => {
    if (!outlet) return;
    setForm({
      name: outlet.name,
      legalName: outlet.legalName ?? '',
      address: outlet.address ?? '',
      phone: outlet.phone ?? '',
      email: outlet.email ?? '',
      gstin: outlet.gstin ?? '',
      fssaiNumber: outlet.fssaiNumber ?? '',
      receiptFooter: outlet.receiptFooter ?? '',
    });
  }, [outlet]);

  if (!outlet) return null;

  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    if (form.name.trim().length < 2) { toast.error('Enter the outlet name'); return; }
    const gstin = form.gstin.trim().toUpperCase();
    if (gstin && gstin.length !== 15) { toast.error('A GSTIN is 15 characters'); return; }

    save.mutate(
      {
        name: form.name.trim(),
        legalName: form.legalName.trim() || null,
        address: form.address.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        gstin: gstin || null,
        fssaiNumber: form.fssaiNumber.trim() || null,
        receiptFooter: form.receiptFooter.trim() || null,
      },
      {
        onSuccess: () => { toast.success(`${form.name.trim()} details saved`); onClose(); },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{outlet.name} — Business Details</DialogTitle>
          <DialogDescription>
            These print on this outlet&apos;s customer receipts, and appear as the buyer&apos;s details on the
            invoices you raise against it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label required>Outlet name</Label>
            <Input value={form.name} onChange={set('name')} placeholder="Adajan Outlet" />
          </div>
          <div className="space-y-1.5">
            <Label>Registered name</Label>
            <Input value={form.legalName} onChange={set('legalName')} placeholder="If different — printed on receipts" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Address</Label>
            <Input value={form.address} onChange={set('address')} placeholder="Shop 4, Linking Road, Bandra West, Mumbai 400050" />
          </div>
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input value={form.phone} onChange={set('phone')} placeholder="+91 98765 43210" />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={form.email} onChange={set('email')} placeholder="Optional" />
          </div>
          <div className="space-y-1.5">
            <Label>GSTIN</Label>
            <Input
              value={form.gstin}
              onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
              placeholder="24ABCDE1234F1Z5"
              maxLength={15}
            />
          </div>
          <div className="space-y-1.5">
            <Label>FSSAI licence no.</Label>
            <Input value={form.fssaiNumber} onChange={set('fssaiNumber')} placeholder="Required on food receipts" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Receipt footer</Label>
            <Input value={form.receiptFooter} onChange={set('receiptFooter')} placeholder="Thank you! Visit again 🙏" />
          </div>
        </div>

        {/* What the cashier's paper will actually say. */}
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="mb-2 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            <Receipt className="h-3.5 w-3.5" /> Receipt header preview
          </p>
          <div className="mx-auto w-[260px] rounded bg-card px-3 py-3 text-center font-mono text-[11px] leading-tight text-foreground shadow-sm">
            <div className="text-[14px] font-bold">{form.legalName.trim() || form.name.trim() || 'Outlet name'}</div>
            {form.address.trim() && <div>{form.address.trim()}</div>}
            {form.phone.trim() && <div>Ph: {form.phone.trim()}</div>}
            {form.gstin.trim() && <div>GSTIN: {form.gstin.trim()}</div>}
            {form.fssaiNumber.trim() && <div>FSSAI: {form.fssaiNumber.trim()}</div>}
            <div className="my-1 border-t border-dashed border-border" />
            <div className="text-muted-foreground">… items, totals …</div>
            <div className="my-1 border-t border-dashed border-border" />
            <div>{form.receiptFooter.trim() || 'Thank you! Visit again 🙏'}</div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending}><Save className="h-4 w-4" /> Save details</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
