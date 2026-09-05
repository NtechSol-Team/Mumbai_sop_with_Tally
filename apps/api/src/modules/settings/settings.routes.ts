import { Router } from 'express';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { asyncHandler } from '../../shared/utils/asyncHandler';
import { validate } from '../../shared/middleware/validate';
import { authGuard } from '../../shared/guards/authGuard';
import { requireSuperAdmin } from '../../shared/guards/roleGuard';
import { writeRateLimiter } from '../../shared/middleware/rateLimit';
import { ok } from '../../shared/utils/apiResponse';
import { AppError } from '../../shared/utils/AppError';
import { isValidGstin } from '../../shared/utils/gst';
import { settingsService } from './settings.service';

const router = Router();
router.use(authGuard);

const user = (req: Request) => {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
};

// Every authenticated role can read it — a franchise owner's Call button needs to
// know the number just as much as the main owner editing it does.
router.get(
  '/call-number',
  asyncHandler(async (_req: Request, res: Response) => ok(res, { phone: await settingsService.getCallButtonPhone() })),
);

router.put(
  '/call-number',
  requireSuperAdmin,
  writeRateLimiter,
  validate({ body: z.object({ phone: z.string().trim().max(20) }) }),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, { phone: await settingsService.setCallButtonPhone(user(req), (req.body as { phone: string }).phone) }, 'Contact number saved'),
  ),
);

// A UPI VPA: `identifier@handle` (e.g. mumbaierp@hdfcbank, 98765xxxxx@ybl).
const UPI_VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,63}$/;

// Every field optional — the form sends a partial patch; the service merges it
// over the current profile. Blank string = clear that field.
const companyProfileSchema = z
  .object({
    legalName: z.string().trim().max(200),
    displayName: z.string().trim().max(200),
    tagline: z.string().trim().max(200),
    address: z.string().trim().max(400),
    phone: z.string().trim().max(40),
    email: z.union([z.literal(''), z.string().trim().email('Enter a valid email').max(160)]),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .max(15)
      .refine((v) => v === '' || isValidGstin(v), 'Invalid GSTIN (format or checksum failed)'),
    fssai: z.string().trim().max(30),
    upiVpa: z
      .string()
      .trim()
      .max(120)
      .refine((v) => v === '' || UPI_VPA_RE.test(v), 'Invalid UPI ID — expected something like name@bank'),
    upiPayeeName: z.string().trim().max(120),
    invoiceTerms: z.string().trim().max(3000),
    // Blank is meaningful: it falls back to the generic "Partner 1" label.
    partner1Name: z.string().trim().max(120),
    partner2Name: z.string().trim().max(120),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

// Readable by any authenticated user: the franchise-payment UPI QR and the
// invoice letterhead both need it, and those are seen by outlet owners too.
router.get(
  '/company',
  asyncHandler(async (_req: Request, res: Response) => ok(res, await settingsService.getCompanyProfile())),
);

router.put(
  '/company',
  requireSuperAdmin,
  writeRateLimiter,
  validate({ body: companyProfileSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await settingsService.setCompanyProfile(user(req), req.body as Record<string, string>), 'Business profile saved'),
  ),
);

export const settingsRouter = router;
