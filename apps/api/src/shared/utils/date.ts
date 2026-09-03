import { z } from 'zod';
import { IST_TZ } from '../../config/timezone';

/**
 * IST-anchored date handling.
 *
 * The process runs in IST (see config/timezone.ts), but that alone is not enough
 * for request input: JavaScript parses a bare "2026-07-31" as **UTC** midnight no
 * matter what TZ the process is in. Left alone, a from/to window sent by the UI
 * would be shifted 5h30m and clip the edges of every report.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** IST is a fixed +05:30 offset — no DST, so a literal suffix is exact. */
const IST_SUFFIX = 'T00:00:00+05:30';

/**
 * Parse a calendar date the way the person typing it means it: "2026-07-31" is
 * midnight *in India (IST)*, not in London. Anything that already carries a time (a full
 * ISO timestamp, a Date, an epoch) is passed straight through untouched.
 */
export const istDate = z.preprocess(
  (v) => (typeof v === 'string' && DATE_ONLY.test(v) ? new Date(v + IST_SUFFIX) : v),
  z.coerce.date(),
);

/** Optional variant, for query params. */
export const istDateOptional = istDate.optional();

/** Start of the IST day containing `d`. */
export function startOfIstDay(d: Date): Date {
  return new Date(istDayString(d) + IST_SUFFIX);
}

/**
 * Exclusive upper bound for the IST day containing `d` — i.e. the following IST
 * midnight. Ranges use this rather than `lte` on the day itself, because records
 * raised by purchases, payroll and the POS carry a real time-of-day and would
 * otherwise be dropped from the last day of every window.
 */
export function endOfIstDayExclusive(d: Date): Date {
  const next = new Date(startOfIstDay(d));
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** "YYYY-MM-DD" for the IST calendar day containing `d`. */
export function istDayString(d: Date): string {
  // en-CA renders ISO-shaped YYYY-MM-DD, which saves hand-assembling the parts.
  return d.toLocaleDateString('en-CA', { timeZone: IST_TZ });
}

/**
 * Half-open [gte, lt) window from an inclusive IST from/to pair, ready to spread
 * into a Prisma date filter. Returns undefined when neither bound is given.
 */
export function istRange(from?: Date, to?: Date): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: startOfIstDay(from) } : {}),
    ...(to ? { lt: endOfIstDayExclusive(to) } : {}),
  };
}

/** SQL fragment that reduces a timestamptz column to its IST wall-clock time. */
export const IST_AT = `AT TIME ZONE '${IST_TZ}'`;
