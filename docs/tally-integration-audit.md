# Tally Integration — Engineering Audit

**Date:** 2026-09-05 · **Scope:** the whole ERP → TallyPrime sync (outbox, builder,
worker, API, agent, settings) · **Method:** code review against the running system,
plus what we have actually exercised against a live TallyPrime 7.1.

This is a self-audit of work in this repo. Findings are ranked by risk to the
**client's statutory books**, not by how hard they are to fix. Each says what is
wrong, why it matters, and what the fix is.

Legend — **verified** = confirmed by reading/running the code; **suspected** =
reasoned but not yet reproduced.

---

## Summary

| Severity | Count | Theme |
|---|---|---|
| 🔴 Critical | 3 (3 fixed) | Settings that silently do nothing; no GST rate validation; another client's names in the schema |
| 🟠 High | 4 (2 fixed) | False "healthy" signal; no retry ceiling; voucher ordering; Tally numbering conflict |
| 🟡 Medium | 7 | Lost ITC, untaxed charges, advance allocation, repost window, concurrency, company fallback, rate limits |
| ⚪ Low | 4 | Timezone dependency, unbounded queue growth, response retention, token lifecycle |

The single most serious issue is **#1** — not because it is hard, but because it
is the kind of failure that looks like success.

---

## 🔴 Critical

### 1. Nine settings do nothing at all — **verified · MITIGATED**

The Settings screen offers these, and the builder never reads any of them:

| Setting | What it claims | What actually happens |
|---|---|---|
| `posSupplyKind` | Counter sales are goods vs restaurant service | Always posts to the goods sales ledger |
| `razorpayReceiptMode` | Gross→clearing vs gross→bank | Always whatever `BANK_CASH:RAZORPAY` maps to |
| `discountMode` | Separate Discount Allowed ledger vs net off sales | Always netted into the sale |
| `billChargesTaxable` | Packing/freight taxable or not | Always posted untaxed |
| `blockOnRateMismatch` | Hold a voucher whose GST rate is wrong | No rate check exists at all |
| `blockOnMissingGstin` | Hold a voucher for a party with no GSTIN | No such check exists |
| `closingStockMode` | Don't / monthly / on demand | No closing-stock journal is ever posted |
| `closingStockBasis` | GST-purchase stock vs total ERP stock | Never consulted |
| `posVoucherGranularity` | Per bill vs daily summary | Always per bill |

**Why it matters.** An accountant sets *"Counter sales are a restaurant service"*,
sees it save, and reasonably concludes the GST treatment changed. It did not.
A setting that silently doesn't apply is worse than no setting — it converts an
open question into a false assurance, on statutory books.

**Fix.** Two honest options, in order of preference:
1. Implement them. `posSupplyKind`, `razorpayReceiptMode` and `discountMode` are
   each a small change in the builder. `blockOnRateMismatch` needs a real rate
   check (see #3). Closing stock and daily-summary POS are genuine features.
2. Until then, mark every unimplemented toggle in the UI as **not yet active**
   and make it non-interactive, so nobody can act on it.

Do (2) immediately regardless — it is minutes of work and removes the false
assurance today.

---

### 2. The previous client's partners are baked into the schema — **verified · FIXED**

`PaidBy` was `COMPANY | KALPESHBHAI | MAYURBHAI`, and `ensureTallyDefaults`
turns every non-COMPANY value into a real Tally ledger — so "Kalpeshbhai Current
A/c" and "Mayurbhai Current A/c" would have been created in the Mumbai client's
Tally, appeared in their Balance Sheet under Capital Account, and been visible to
their auditor. `PERSON_ACCOUNTS` in `accounting.service.ts` carried the same
names, as did `PAID_BY_LABEL` in the web app.

**Why it matters.** Another business's proprietor names inside this client's
statutory books. Beyond the obvious embarrassment, it is a data-provenance
problem in an audited system.

**Fix.** The real problem was not the two names — it was that *a person's name
was a database enum*. Businesses change partners; that must never require a
migration, and it must never carry one client's proprietors into another's
books.

The enum now holds opaque keys — `COMPANY | PARTNER_1 | PARTNER_2` — and the
names are configuration on the company profile (`partner1Name`, `partner2Name`),
edited in **Settings → Business Profile** alongside the GSTIN and UPI ID. Blank
falls back to "Partner 1" / "Partner 2", so an unconfigured business still reads
sensibly rather than showing a raw enum key.

`settingsService.getPaidByLabels()` is the single source of the display name, so
the expenses screen, the ledger account list and the Tally partner ledger cannot
drift apart on what a partner is called. In `getLedgerAccounts()` the names are
resolved *outside* the balance cache — that cache is tagged on payments/bills/
expenses, so a rename would otherwise not appear until one of those happened to
invalidate it.

Two migrations, both non-destructive:

- `20260905090000_partner_keys_not_names` — `ALTER TYPE ... RENAME VALUE` rather
  than Prisma's default drop-and-recreate, so existing expense rows keep pointing
  at the same partner; `tally_ledger_map.slot_key` follows the rename.
- `20260905091500_partner_ledger_names_placeholder` — scrubs the seeded ledger
  *names*, but only where the row still holds exactly the old default **and**
  `validated_at IS NULL`. A ledger already confirmed to exist in Tally is left
  alone and flagged in `notes` instead: silently repointing a map row whose
  ledger exists in Tally would strand every voucher already posted against it.

**Still on you.** Ledger seeding is insert-only by design, so renaming a partner
in the business profile does *not* rename a ledger that already exists in Tally —
that has to stay a deliberate act, in Settings → Tally and in Tally itself. If
the client's Tally already received "Kalpeshbhai Current A/c" or "Mayurbhai
Current A/c" from an earlier provisioning run, delete those two ledgers in Tally
(Alt+G → Chart of Accounts → Ledgers) once you have entered the real partner
names — they will have no vouchers against them.

---

### 3. No GST rate validation exists — **verified · FIXED**

The brief called for validating that "GST rate must match the configured rate for
that item" before pushing. `blockOnRateMismatch` exists as a setting and defaults
to on. **No such check was ever written.** The builder trusts whatever tax amount
the ERP row carries.

**Why it matters.** If a product's `taxPercent` is edited after a bill is raised,
or a bill is back-dated across a rate change (namkeen went 12% → 5% on 22 Sep
2025), a voucher can post with a rate that does not match the item — silently,
into a GST return.

**Fix.** In `buildSalesBill`/`buildPosSale`, recompute expected tax from the line
items and compare against the stored `taxTotal`; on mismatch beyond a paisa,
fail the voucher with a clear message when `blockOnRateMismatch` is on, and flag
it when off. `assertBalanced` already proves internal consistency — this proves
*correctness*, which is a different thing.

---

## 🟠 High

### 4. "Tally ok" does not mean the right company is open — **verified · FIXED**

`ping()` sends a *List of Companies* export and returns true on HTTP 200. That
proves Tally is running with its HTTP server on. It does **not** prove the
company named in `TALLY_COMPANY` is loaded.

**Why it matters.** With the wrong company open (or none), the dashboard shows a
healthy green agent while every single voucher fails. During a month-end that is
a long, confusing outage.

**Fix.** Parse the company list from the probe response and confirm the configured
name is in it. Report `Tally ok (company not loaded)` distinctly from `Tally ok`.
Cheap, and turns a silent failure into an obvious one.

---

### 5. No retry ceiling and no backoff — **verified · FIXED**

The Phase 3 architecture says "exponential backoff per voucher, capped; after N
attempts a voucher goes FAILED." **Neither exists.** `attempts` is incremented on
every pull and reset to 0, and nothing ever reads it. A row whose agent crashes
before reporting stays `PENDING` and is re-pulled every 20 seconds, forever.

**Why it matters.** A single poison voucher silently consumes a pull slot on
every cycle indefinitely, and `attempts` grows without bound while conveying
nothing. The documentation describes protection the code does not provide.

**Fix.** Read `attempts` in `agentPending`: skip rows past a threshold and mark
them `FAILED` with "gave up after N attempts", and stagger re-pulls using
`lastAttemptAt`.

---

### 6. A Receipt can post before the Sales voucher it allocates against — **verified · FIXED**

`buildReceipt` emits `Agst Ref <billNumber>`. Nothing guarantees that bill's
Sales voucher is already in Tally. The queue drains in `createdAt` order, which
*usually* puts the bill first — but if the bill fails (bad ledger) and the
payment succeeds, the receipt lands with an allocation pointing at a bill Tally
has never seen.

**Why it matters.** The allocation silently doesn't attach. The outlet's
bill-wise outstanding and ageing in Tally are then wrong, which is precisely the
number this integration exists to make trustworthy.

**Fix.** Add a dependency check: a `PAYMENT_IN` row with a `billId` is not
eligible to build/dispatch until that bill's queue row is `SYNCED`. Same for
`SUPPLIER_PAYMENT` against its `PURCHASE_BILL`.

---

### 7. Voucher numbering may fight Tally's own — **suspected**

We set `VOUCHERNUMBER` to the ERP's document number (`BL-2026-00001`). If the
corresponding Tally voucher type is left on **automatic** numbering, Tally may
renumber the voucher or reject the import.

**Why it matters.** The entire reconciliation story rests on the accountant being
able to search Tally for `BL-2026-00001`. If Tally renumbers, that breaks.

**Fix.** Document (and check at setup) that Sales/Receipt/Purchase/Payment
voucher types in the client's company must be set to **Manual** numbering. Add it
to the go-live checklist and ideally verify it from the agent.

---

## 🟡 Medium

### 8. Input tax credit is discarded on expenses — **verified**
`buildExpense` posts `amount + taxAmount` to the expense head with no Input GST
line. Any expense backed by a valid tax invoice loses its ITC. This was a
deliberate v1 simplification, but it is **real money** and should be revisited
with the CA rather than left as a silent default.

### 9. Bill charges post untaxed — **verified**
Packing/freight recovered goes to a single credit line with no GST, regardless of
the (dead) `billChargesTaxable` setting. If these form part of a composite supply,
output GST is under-declared. Needs the CA's ruling, then implementation.

### 10. Advance receipts never attach to the eventual bill — **verified**
An order-advance posts as a standalone `Advance` reference. When the bill is
raised later, nothing links the two in Tally, so the advance and the invoice sit
as separate open references on the debtor.

### 11. The repost window can lose a voucher — **verified**
An edited transaction is sent as Delete-then-Create. If the Delete succeeds and
the Create then fails, the entry is gone from Tally until someone retries, while
the ERP shows `FAILED`. Low probability, non-trivial consequence.

### 12. Two agents would both pull the same rows — **verified**
`agentPending` has no claim/lock. Running the agent on two machines double-pulls.
`REMOTEID` dedup prevents actual duplicate vouchers, but attempts double-count and
the design is fragile. Add a short claim window or a single-agent guard.

### 13. An empty company name silently targets whatever is open — **verified**
`SVCURRENTCOMPANY` falls back to `''`, which makes Tally use the active company.
Combined with #4, this can post a client's vouchers into the wrong company file.
`tallyCompany` should be required before sync can be enabled.

### 14. Agent endpoints have no rate limiting — **verified**
The admin routes use `writeRateLimiter`; `/tally/agent/*` does not. A leaked token
could be used to hammer the API.

---

## ⚪ Low / hygiene

### 15. Date formatting depends on the process timezone — **suspected**
`yyyymmdd()` uses local `getFullYear/getMonth/getDate`. `config/timezone.ts` pins
the process to IST, so this should be correct — but it is worth confirming on
Render, because a UTC process would file a 00:30 IST voucher under the previous
day, and in March/April that crosses a financial year.

### 16. `tally_sync_queue` grows forever — **verified**
No archival or retention. Every voucher ever synced stays, with its payload and
up to 8 KB of raw Tally response.

### 17. Raw Tally responses are retained — **verified**
`tallyResponse` holds up to 8 KB of Tally's XML, which can include party names and
GSTINs. Fine, but it deserves a retention decision rather than growing silently.

### 18. The agent token never expires — **verified**
No expiry, no rotation reminder, no last-used-IP record. Rotation exists but
nothing prompts it.

---

## What is solid

Worth stating plainly, because the above is a long list:

- **The transactional outbox is correct.** Queue rows are written inside the same
  transaction as the financial row, so a rollback cannot leave a ghost and a
  commit cannot be missed.
- **The two non-negotiable rules hold.** Non-GST purchases are excluded at enqueue
  time in code, and `assertBalanced` refuses any voucher whose debits ≠ credits.
  Both are enforced, not configurable, and both were exercised.
- **Double-entry output is right** for every voucher type built so far — verified
  line by line against sales, receipt, purchase and expense examples.
- **Nothing is lost when Tally is down.** Verified: agent online, Tally closed,
  vouchers stay `PENDING` and resume.
- **New suppliers now self-heal** (contact, link and ledger mapping) — verified
  against a deliberately wiped worst case.
- **GST split, place of supply and FY-based voucher numbering** are snapshotted at
  creation, which is the auditable choice.

---

## Progress

**Done**
- #1 mitigated — the eight still-unimplemented settings are disabled and badged
  "Not active yet", so none of them can be mistaken for a treatment that applies.
- #3 fixed — `assertGstConsistent()` validates sales and purchase documents, and
  `blockOnRateMismatch` is now a real, enabled setting.
- #4 fixed — `ping()` reports reachable and companyOpen separately; a missing
  company name is itself an error.
- #5 fixed — vouchers give up after `MAX_DISPATCH_ATTEMPTS` with a readable
  reason; Retry resets the counter.
- #6 fixed — `TallyDeferError` holds a payment until the invoice it allocates
  against has reached Tally, without marking it failed.
- #2 fixed — `PaidBy` holds opaque keys; partner names are configuration on the
  company profile, editable in Settings → Business Profile.

**Next**
1. Implement `posSupplyKind`, `razorpayReceiptMode`, `discountMode` (#1).
2. Take #8 (lost ITC), #9 (untaxed bill charges) and #10 (advance allocation) to
   the CA as accounting decisions before coding them.
3. Manual voucher numbering added to the go-live checklist (#7).
4. Housekeeping: agent-endpoint rate limits (#14), queue retention (#16).
