import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Our typography aliases are font sizes, not text colors. Without this,
// merging text-label after text-primary-foreground removes the button color.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['caption', 'body', 'label', 'card-title', 'page-heading', 'kpi'] }] } },
});

/** Merge conditional + Tailwind class names with conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** IST is a fixed +05:30 with no DST, so a plain offset is exact. */
const IST_OFFSET_MINUTES = 330;

/**
 * Re-express an instant so its *local* fields read as IST wall-clock time, letting
 * every `format(...)` call render the Indian calendar regardless of the device's
 * timezone. A tablet left on UTC, or an owner checking figures while travelling,
 * otherwise sees a bill dated 31 Jul as 30 Jul — and the API is IST-anchored
 * (see apps/api/src/config/timezone.ts), so the two would disagree.
 *
 * Display only. The returned Date is a deliberate lie about its own instant, so
 * never send it to the API, compare it against a real Date, or do arithmetic on it.
 */
export function ist(value?: string | number | Date | null): Date {
  const d = value == null ? new Date() : new Date(value);
  if (Number.isNaN(d.getTime())) return d;
  return new Date(d.getTime() + (IST_OFFSET_MINUTES + d.getTimezoneOffset()) * 60_000);
}

/**
 * Today's IST calendar date as "yyyy-MM-dd" — the right default for a date input,
 * and the right thing to POST. `new Date().toISOString().slice(0, 10)` is UTC, so
 * between midnight and 05:30 IST it hands back yesterday.
 */
export function todayIso(): string {
  return isoDate(ist());
}

/** yyyy-MM-dd from an already-IST-shifted Date. Internal to the two helpers below. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A stored timestamp as the IST calendar date, for pre-filling `<input type="date">`
 * and for date columns in exports.
 *
 * Never use `value.slice(0, 10)` for this. The API stores a bare date as IST
 * midnight — 6 Aug becomes 2026-08-05T18:30:00Z — so slicing the UTC string hands
 * back the 5th. Worse, saving that edited form stores the 5th as IST midnight and
 * the next edit reads the 4th, so the date walks backwards one day per round-trip.
 */
export function istDateInput(value: string | number | Date | null | undefined): string {
  if (value == null) return '';
  const d = ist(value);
  return Number.isNaN(d.getTime()) ? '' : isoDate(d);
}

// Cached formatters: toLocaleString with options builds a fresh Intl.NumberFormat
// per call, and the POS renders 100+ prices per interaction — profiling showed it
// as the single hottest app function on slow tills.
const INR_2DP = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INR_0DP = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Format a number as Indian Rupees. */
export function formatINR(value: number | string, opts: { decimals?: boolean } = {}): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return `₹${(opts.decimals === false ? INR_0DP : INR_2DP).format(Number.isFinite(n) ? n : 0)}`;
}

// Quantity formatters, cached per decimal-place setting for the same reason as the
// INR ones above — inventory/POS tables render hundreds of quantities per paint.
const QTY_FORMATTERS = new Map<number, Intl.NumberFormat>();

/**
 * Format a quantity to the precision its unit allows (Item Master → Unit.decimalPlaces).
 * A Piece unit (0 dp) renders "12", a Kg unit (3 dp) renders "12.500".
 */
export function formatQty(value: number | string, decimalPlaces = 2): string {
  const dp = Math.max(0, Math.min(4, decimalPlaces));
  let fmt = QTY_FORMATTERS.get(dp);
  if (!fmt) {
    fmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    QTY_FORMATTERS.set(dp, fmt);
  }
  const n = typeof value === 'string' ? Number(value) : value;
  return fmt.format(Number.isFinite(n) ? n : 0);
}

/** Quantity with its unit name appended, e.g. "12.500 Kg". */
export function formatQtyWithUnit(value: number | string, unit: { name: string; decimalPlaces: number }): string {
  return `${formatQty(value, unit.decimalPlaces)} ${unit.name}`;
}

/** Compact number (1.2k, 3.4L). */
export function formatCompact(value: number): string {
  if (value >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`;
  if (value >= 1e5) return `${(value / 1e5).toFixed(2)}L`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}
