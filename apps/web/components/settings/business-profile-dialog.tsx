'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Save, Building2, QrCode } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { apiErrorMessage } from '@/lib/api';
import { useCompanyProfile, useUpdateCompanyProfile, type CompanyProfile } from '@/hooks/useSettings';

const FIELDS: readonly (keyof CompanyProfile)[] = [
  'legalName', 'displayName', 'tagline', 'address', 'phone', 'email',
  'gstin', 'fssai', 'upiVpa', 'upiPayeeName', 'invoiceTerms',
];

const empty: CompanyProfile = {
  legalName: '', displayName: '', tagline: '', address: '', phone: '', email: '',
  gstin: '', fssai: '', upiVpa: '', upiPayeeName: '', invoiceTerms: '',
};

// name@bank — mirrors the API's UPI_VPA_RE (used only for the inline hint).
const UPI_VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,63}$/;

/**
 * Head-office business identity, edited by the main owner. These values feed the
 * invoice + payslip letterhead, the payment-checkout name, and — critically —
 * the franchise-payment UPI collection QR (a wrong VPA misroutes real money).
 */
export function BusinessProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useCompanyProfile();
  const update = useUpdateCompanyProfile();
  const [form, setForm] = useState<CompanyProfile>({ ...empty });

  useEffect(() => {
    if (data) setForm({ ...empty, ...data });
  }, [data, open]);

  const set = (k: keyof CompanyProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const gstin = form.gstin.trim().toUpperCase();
  const vpa = form.upiVpa.trim();
  const gstinBad = gstin !== '' && gstin.length !== 15;
  const vpaBad = vpa !== '' && !UPI_VPA_RE.test(vpa);

  const submit = () => {
    if (gstinBad) { toast.error('A GSTIN is 15 characters'); return; }
    if (vpaBad) { toast.error('UPI ID should look like name@bank'); return; }
    if (vpa && !form.upiPayeeName.trim()) { toast.error('Add the UPI payee name that matches this UPI ID'); return; }

    // Send every field so a cleared box actually clears server-side.
    const patch: Partial<CompanyProfile> = {};
    for (const k of FIELDS) patch[k] = k === 'gstin' ? gstin : form[k].trim();

    update.mutate(patch, {
      onSuccess: () => { toast.success('Business profile saved'); onClose(); },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Building2 className="h-4 w-4" /> Business Profile</DialogTitle>
          <DialogDescription>
            The head-office entity that raises franchise invoices and collects payment. Printed on invoices and
            payslips, shown as the payment name, and used for the franchise-payment UPI QR.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Registered (legal) name</Label>
            <Input value={form.legalName} onChange={set('legalName')} placeholder="Exactly as on the GST certificate" />
          </div>
          <div className="space-y-1.5">
            <Label>Display / trade name</Label>
            <Input value={form.displayName} onChange={set('displayName')} placeholder="Shown on receipts & checkout" />
          </div>
          <div className="space-y-1.5">
            <Label>Tagline</Label>
            <Input value={form.tagline} onChange={set('tagline')} placeholder="Optional — under the name on invoices" />
          </div>
          <div className="space-y-1.5">
            <Label>GSTIN</Label>
            <Input
              value={form.gstin}
              onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
              placeholder="27ABCDE1234F1Z5"
              maxLength={15}
              aria-invalid={gstinBad}
            />
            <p className="text-caption text-muted-foreground">
              {gstin ? `State code ${gstin.slice(0, 2)} · ` : ''}Leave blank if not GST-registered.
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Registered address</Label>
            <Input value={form.address} onChange={set('address')} placeholder="Registered place of business" />
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
            <Label>FSSAI licence no.</Label>
            <Input value={form.fssai} onChange={set('fssai')} placeholder="Optional" />
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="mb-2 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            <QrCode className="h-3.5 w-3.5" /> UPI collection (franchise payment QR)
          </p>
          <p className="mb-2.5 text-caption text-warning">
            This is the account every franchise UPI payment lands in. A wrong ID silently misroutes money and
            UPI cannot be reversed — double-check it.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>UPI ID (VPA)</Label>
              <Input
                value={form.upiVpa}
                onChange={set('upiVpa')}
                placeholder="business@hdfcbank"
                aria-invalid={vpaBad}
              />
            </div>
            <div className="space-y-1.5">
              <Label>UPI payee name</Label>
              <Input value={form.upiPayeeName} onChange={set('upiPayeeName')} placeholder="Name registered on the VPA" />
            </div>
          </div>
          <p className="mt-1.5 text-caption text-muted-foreground">Leave the UPI ID blank to hide the payment QR entirely.</p>
        </div>

        <div className="space-y-1.5">
          <Label>Invoice terms &amp; conditions</Label>
          <textarea
            value={form.invoiceTerms.split('|').join('\n')}
            onChange={(e) => setForm((f) => ({ ...f, invoiceTerms: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).join('|') }))}
            rows={4}
            placeholder={'One term per line — numbered automatically on the invoice'}
            className={cn(
              'flex w-full rounded-sm border border-input bg-background px-3 py-2 text-base text-foreground sm:text-body',
              'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          />
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={update.isPending}><Save className="h-4 w-4" /> Save profile</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
