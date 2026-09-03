'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Loader2, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatINR } from '@/lib/utils';

/**
 * The shop's UPI collection QR, rendered with the amount already filled in.
 *
 * ⚠️ PAYEE_VPA IS THE ACCOUNT THE MONEY LANDS IN. Do not change it, derive it
 * from settings, or make it configurable without the owner explicitly saying so
 * — a wrong character here silently sends every franchise payment to someone
 * else's account, and UPI transfers cannot be reversed.
 *
 * 🚧 PLACEHOLDER — these belong to the OLD client and have been blanked out for
 * Mumbai ERP. Replace both with the Mumbai ERP client's own registered UPI
 * collection VPA and payee name (from their Kotak virtual-account / UPI setup)
 * BEFORE this screen is used to collect any real payment.
 */
const PAYEE_VPA = 'REPLACE_ME@bank';
const PAYEE_NAME = 'MUMBAI ERP — SET REGISTERED PAYEE NAME';

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
function upiUri(amount: number, note: string): string {
  const q = [
    `pa=${PAYEE_VPA}`,
    `pn=${encodeURIComponent(PAYEE_NAME)}`,
    'cu=INR',
    `am=${amount.toFixed(2)}`,
    `tn=${encodeURIComponent(note)}`,
  ].join('&');
  return `upi://pay?${q}`;
}

export function UpiQr({ amount, reference, outletName }: { amount: number; reference: string; outletName?: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Outlet name first — that's what the owner recognises at a glance in the
  // bank SMS/passbook — then the order or bill number to match it precisely.
  // Most UPI apps only show the first ~50 chars of the note before truncating,
  // so this stays short rather than spelling out "Order"/"Bill".
  const note = outletName ? `${outletName} · ${reference}` : reference;
  const uri = upiUri(amount, note);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setError(null);
    QRCode.toDataURL(uri, { width: 480, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not build the QR code'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- uri is derived from amount/note, both already deps
  }, [amount, note]);

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-5 text-center">
      <div>
        <p className="text-caption text-muted-foreground">Pay to</p>
        <p className="text-label font-bold leading-tight">{PAYEE_NAME}</p>
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
        UPI ID <span className="font-semibold text-foreground">{PAYEE_VPA}</span>
      </p>
    </div>
  );
}
