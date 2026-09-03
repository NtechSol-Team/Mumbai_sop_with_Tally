import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import type { AuthUser } from '../../shared/types/api';

// Generic key/value settings live in one small table (see AppSetting).
const CALL_BUTTON_PHONE_KEY = 'CALL_BUTTON_PHONE';
const COMPANY_PROFILE_KEY = 'COMPANY_PROFILE';

/** The number a franchise owner's Call button dials. Null until the main owner sets one. */
export async function getCallButtonPhone(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: CALL_BUTTON_PHONE_KEY } });
  return row?.value || null;
}

export async function setCallButtonPhone(user: AuthUser, phone: string): Promise<string | null> {
  // Blank clears it — the Call button just disappears rather than dialling nothing.
  if (!phone.trim()) {
    await prisma.appSetting.deleteMany({ where: { key: CALL_BUTTON_PHONE_KEY } });
    return null;
  }
  const row = await prisma.appSetting.upsert({
    where: { key: CALL_BUTTON_PHONE_KEY },
    create: { key: CALL_BUTTON_PHONE_KEY, value: phone.trim(), updatedById: user.id },
    update: { value: phone.trim(), updatedById: user.id },
  });
  return row.value;
}

/**
 * The head-office business identity — the entity that raises franchise invoices,
 * collects payment, and (from Phase 4) is the party pushed to Tally.
 *
 * Stored as one JSON blob in `app_settings` rather than columns because it is a
 * single-row concept the main owner edits occasionally, and new fields (Tally
 * ledger names, bank details, …) will keep accreting. The `env.COMPANY_*` values
 * are only the first-run fallback — once saved here, the DB wins.
 *
 * `gstin` blank = not GST-registered / not yet entered (invoices then print
 * without a seller GSTIN). `upiVpa` blank = the UPI collection QR is hidden
 * rather than pointed at nothing.
 */
export interface CompanyProfile {
  /** Registered legal entity name, exactly as on the GST certificate. */
  legalName: string;
  /** Trade name shown on receipts and the payment checkout (often the same). */
  displayName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  /** 15-char GSTIN, validated (format + checksum) on save. '' if unregistered. */
  gstin: string;
  /** FSSAI food licence number. */
  fssai: string;
  /** UPI collection VPA the franchise-payment QR points at. '' hides the QR. */
  upiVpa: string;
  /** Payee name shown on that QR — must match the name registered against the VPA. */
  upiPayeeName: string;
  /** Invoice terms & conditions, pipe-separated (one term per segment). */
  invoiceTerms: string;
}

const COMPANY_PROFILE_KEYS: readonly (keyof CompanyProfile)[] = [
  'legalName', 'displayName', 'tagline', 'address', 'phone', 'email',
  'gstin', 'fssai', 'upiVpa', 'upiPayeeName', 'invoiceTerms',
];

function companyDefaults(): CompanyProfile {
  return {
    legalName: env.COMPANY_NAME,
    displayName: env.COMPANY_NAME,
    tagline: env.COMPANY_TAGLINE,
    address: env.COMPANY_ADDRESS,
    phone: env.COMPANY_PHONE,
    email: '',
    gstin: env.COMPANY_GSTIN,
    fssai: '',
    upiVpa: '',
    upiPayeeName: '',
    invoiceTerms: env.COMPANY_TERMS,
  };
}

/** Keep only keys that are actually part of the profile and were provided. */
function pickProfileFields(patch: Partial<CompanyProfile>): Partial<CompanyProfile> {
  const out: Partial<CompanyProfile> = {};
  for (const k of COMPANY_PROFILE_KEYS) {
    const v = patch[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export async function getCompanyProfile(): Promise<CompanyProfile> {
  const base = companyDefaults();
  const row = await prisma.appSetting.findUnique({ where: { key: COMPANY_PROFILE_KEY } });
  if (!row?.value) return base;
  try {
    const stored = JSON.parse(row.value) as Partial<CompanyProfile>;
    return { ...base, ...pickProfileFields(stored) };
  } catch {
    // Corrupt JSON must never break invoice rendering or the payment QR.
    return base;
  }
}

export async function setCompanyProfile(user: AuthUser, patch: Partial<CompanyProfile>): Promise<CompanyProfile> {
  const current = await getCompanyProfile();
  const next: CompanyProfile = { ...current, ...pickProfileFields(patch) };
  await prisma.appSetting.upsert({
    where: { key: COMPANY_PROFILE_KEY },
    create: { key: COMPANY_PROFILE_KEY, value: JSON.stringify(next), updatedById: user.id },
    update: { value: JSON.stringify(next), updatedById: user.id },
  });
  return next;
}

export const settingsService = {
  getCallButtonPhone,
  setCallButtonPhone,
  getCompanyProfile,
  setCompanyProfile,
};
