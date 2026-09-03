'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Loader2, Smartphone, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatINR } from '@/lib/utils';
import { useCompanyProfile } from '@/hooks/useSettings';

/**
 * The business's UPI collection QR, rendered with the amount already filled in.
 *
 * ⚠️ The payee VPA is THE ACCOUNT THE MONEY LANDS IN. It is not hard-coded — the
 * main owner sets it once in Settings → Business Profile (UPI collection ID +
 * payee name), the API validates the `name@bank` format, and it is delivered
 * here over an authenticated request. Until it is set, this component shows a
 * "not configured" notice rather than a QR that points at nothing — a wrong or
 * empty VPA would silently misroute every franchise payment, and UPI transfers
 * cannot be reversed.
 */

/**
 * Build a UPI intent URI. Amount and note are encoded so the payer's app opens
 * pre-filled — they can't fat-finger the figure, and the note carries the order
 * or bill number so the owner can match the credit against it afterwards.
 *
 * Built by hand rather than with URLSearchParams: that encodes spaces as "+"
 * and "@" as "%40", and some UPI apps parse these deep links strictly enough to
 * choke on either. Real-world UPI QRs keep the VPA literal and percent-encode
 * the rest, so that's what this matches.
 */
function upiUri(vpa: string, payeeName: string, amount: number, note: string): string {
  const q = [
    `pa=${vpa}`,
    `pn=${encodeURIComponent(payeeName)}`,
    'cu=INR',
    `am=${amount.toFixed(2)}`,
    `tn=${encodeURIComponent(note)}`,
  ].join('&');
  return `upi://pay?${q}`;
}

export function UpiQr({ amount, reference, outletName }: { amount: number; reference: string; outletName?: string }) {
  const { data: company, isLoading: loadingProfile } = useCompanyProfile();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const vpa = company?.upiVpa?.trim() ?? '';
  const payeeName = company?.upiPayeeName?.trim() || company?.displayName?.trim() || company?.legalName?.trim() || '';

  // Outlet name first — that's what the owner recognises at a glance in the
  // bank SMS/passbook — then the order or bill number to match it precisely.
  const note = outletName ? `${outletName} · ${reference}` : reference;
  const uri = vpa ? upiUri(vpa, payeeName, amount, note) : '';

  useEffect(() => {
    if (!uri) { setDataUrl(null); return; }
    let cancelled = false;
    setDataUrl(null);
    setError(null);
    QRCode.toDataURL(uri, { width: 480, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not build the QR code'); });
    return () => { cancelled = true; };
  }, [uri]);

  if (loadingProfile) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-card p-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!vpa) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 p-4 text-caption">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div>
          <p className="font-medium text-foreground">UPI collection not set up yet</p>
          <p className="text-muted-foreground">
            The main owner needs to add the business&apos;s UPI collection ID in
            Settings → Business Profile before the payment QR can be shown. Cash and
            bank-transfer entry still work below.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-5 text-center">
      <div>
        <p className="text-caption text-muted-foreground">Pay to</p>
        <p className="text-label font-bold leading-tight">{payeeName || vpa}</p>
        <p className="mt-1 text-2xl font-extrabold leading-none">{formatINR(amount)}</p>
      </div>

      {/* upi://pay is a real URI scheme — on a phone with a UPI app installed,
          this hands off straight to it (GPay/PhonePe/Paytm/BHIM, whichever the
          OS picks or asks about), amount and note already filled in. On a
          device with no UPI app — most likely a desktop browser — it simply
          does nothing useful, which is why the QR below always stays visible
          as the way to pay from a different device. */}
      <Button asChild className="w-full">
        <a href={uri}>
          <Smartphone className="h-4 w-4" /> Pay in UPI App
        </a>
      </Button>

      <div className="flex items-center gap-3 self-stretch text-caption text-muted-foreground">
        <span className="h-px flex-1 bg-border" /> or scan from another device <span className="h-px flex-1 bg-border" />
      </div>

      <div className="flex h-[200px] w-[200px] items-center justify-center rounded-lg bg-white p-2">
        {error ? (
          <p className="px-2 text-caption text-danger">{error}</p>
        ) : dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data: URI, nothing for next/image to optimise
          <img src={dataUrl} alt={`UPI QR to pay ${formatINR(amount)}`} className="h-full w-full" />
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        )}
      </div>

      <p className="text-caption text-muted-foreground">
        UPI ID <span className="font-semibold text-foreground">{vpa}</span>
      </p>
    </div>
  );
}
