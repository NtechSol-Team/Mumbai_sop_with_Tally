import { Router } from 'express';
import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../shared/utils/asyncHandler';
import { validate } from '../../shared/middleware/validate';
import { authGuard } from '../../shared/guards/authGuard';
import { requireSuperAdmin } from '../../shared/guards/roleGuard';
import { writeRateLimiter } from '../../shared/middleware/rateLimit';
import { ok } from '../../shared/utils/apiResponse';
import { AppError } from '../../shared/utils/AppError';
import { tallyService } from './tally.service';
import {
  agentHeartbeatSchema, agentLedgerResultSchema, agentPullSchema, agentResultSchema,
  queueQuerySchema, updateLedgerMapSchema, updateTallyConfigSchema,
} from './tally.schema';

const user = (req: Request) => {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
};

// ── Agent router: bearer-token auth, scoped to /agent/* only ──────────────────
const agentRouter = Router();
const agentAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  await tallyService.assertAgentToken(token);
  next();
});
agentRouter.use(agentAuth);

agentRouter.post(
  '/heartbeat',
  validate({ body: agentHeartbeatSchema }),
  asyncHandler(async (req: Request, res: Response) => ok(res, await tallyService.agentHeartbeat(req.body))),
);
agentRouter.get(
  '/pending',
  validate({ query: agentPullSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, { vouchers: await tallyService.agentPending(Number(req.query.limit ?? 25)) }),
  ),
);
agentRouter.post(
  '/results',
  validate({ body: agentResultSchema }),
  asyncHandler(async (req: Request, res: Response) => ok(res, await tallyService.agentReportResults(req.body.results))),
);
agentRouter.get(
  '/ledgers-pending',
  asyncHandler(async (_req: Request, res: Response) => ok(res, { ledgers: await tallyService.agentLedgersPending() })),
);
agentRouter.post(
  '/ledgers-result',
  validate({ body: agentLedgerResultSchema }),
  asyncHandler(async (req: Request, res: Response) => ok(res, await tallyService.agentReportLedgerResults(req.body.results))),
);

// ── Admin router: SUPER_ADMIN only ───────────────────────────────────────────
const router = Router();
router.use('/agent', agentRouter);

router.use(authGuard, requireSuperAdmin);

router.get('/settings', asyncHandler(async (_req: Request, res: Response) => ok(res, await tallyService.getTallySettings())));

router.put(
  '/settings',
  writeRateLimiter,
  validate({ body: updateTallyConfigSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await tallyService.updateTallySettings(user(req), req.body as Record<string, unknown>), 'Tally settings saved'),
  ),
);

router.put(
  '/ledger-map',
  writeRateLimiter,
  validate({ body: updateLedgerMapSchema }),
  asyncHandler(async (req: Request, res: Response) => ok(res, await tallyService.updateLedgerMap(req.body.rows), 'Ledger mapping saved')),
);

router.get(
  '/queue',
  validate({ query: queueQuerySchema }),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await tallyService.listQueue(req.query as Record<string, never>)),
  ),
);

router.post(
  '/queue/:id/retry',
  writeRateLimiter,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req: Request, res: Response) => ok(res, await tallyService.retryQueueItem(req.params.id), 'Queued for another attempt')),
);

router.post(
  '/agent-token',
  writeRateLimiter,
  asyncHandler(async (req: Request, res: Response) => ok(res, await tallyService.rotateAgentToken(user(req)), 'New agent token generated — copy it now, it is shown only once')),
);

export const tallyRouter = router;
