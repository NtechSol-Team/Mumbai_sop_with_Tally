# Mumbai ERP → Tally Prime — Sync Setup & Operations Guide

**Audience:** the main owner and their accountant / CA.
**What this covers:** getting the one-way accounting sync from Mumbai ERP into
TallyPrime 7.1 running, and how to operate it day to day.

---

## 1. What it is

Mumbai ERP pushes finished accounting vouchers into the client's TallyPrime.

- **One way only.** Data flows ERP → Tally. The system never reads business data
  out of Tally and never changes anything in Tally except by posting the vouchers
  the ERP built.
- **Tally stays the statutory book.** GST returns, P&L, balance sheet and party
  balances are all computed by Tally from these vouchers.
- **Nothing is lost.** If Tally is closed or the office PC is off, transactions
  queue in the ERP and post automatically once Tally is reachable again.

```
  Mumbai ERP (cloud)                Sync Agent (office PC)             TallyPrime 7.1
  ─────────────────                 ────────────────────              ──────────────
  a bill / payment / purchase
  happens in the ERP
        │  writes a queue entry (in the same DB transaction)
        ▼
  a background job builds a
  balanced double-entry voucher
        │
        ▼
     WAITING ───── agent pulls it (HTTPS, agent dials outward) ─────▶ turns it into
                                                                      Tally XML
                                                                          │
                                                                          ▼  POST to
                                                                      http://localhost:9000
                                                                      Tally accepts
                                                                      or rejects
        ◀──── agent reports: IN TALLY (+ Tally's voucher id)  ─────────────┘
                          or FAILED (+ Tally's own error message)
```

The **Sync Agent** is a small tray app that runs on the same Windows PC as Tally
(or another PC on the same office network). It only makes **outbound** calls, so
**no ports need to be opened on the office router or firewall.** Its only
requirement is that the PC can browse the internet.

---

## 2. Before you start — what you need

From the **accountant / CA**:

- [ ] Confirmed **company GSTIN** and that it is registered in **Maharashtra** (state code 27)
- [ ] Whether Tally is a **fresh company** or an **existing company** with a chart
      of accounts and opening balances already in it
- [ ] The exact **ledger names** already in Tally for: each bank account, cash,
      the GST ledgers (Output/Input CGST/SGST/IGST), sales, purchases, and the
      main expense heads
- [ ] Each **franchise outlet's GSTIN**
- [ ] Answers to the accounting choices in **Part 5**

From **whoever runs the office PC**:

- [ ] TallyPrime **7.1** installed, licensed, company created/loaded
- [ ] Admin access to that PC to install the agent

---

## 3. Part 1 — Turn on Tally's HTTP server (one time, on the Tally PC)

TallyPrime can accept vouchers over HTTP on the local machine, but this is off by
default.

1. Open **TallyPrime** and load the company.
2. Press **F1** (Help) → **Settings** → **Connectivity**.
3. Set **TallyPrime acts as** → **Both** (or at least *HTTP Server*).
4. Confirm the **Port** is **9000** (the default).
5. Leave TallyPrime running with the company open whenever the sync should work.

> If TallyPrime is closed, or no company is loaded, the sync simply pauses —
> vouchers wait in the ERP and post when Tally is back.

---

## 4. Part 2 — Install the Sync Agent (on the Tally PC)

### Build the installer

On any Windows machine with Node 20+ installed:

```
cd apps/tally-agent
npm install
npm run dist
```

This produces `apps/tally-agent/dist/Mumbai ERP Tally Sync Agent-Setup-1.0.0.exe`.

### Install it

Copy that `.exe` to the Tally PC and run it. It:

- installs to the user's profile (no admin prompt),
- starts automatically at every login,
- sits in the **system tray** (bottom-right, near the clock).

Right-click the tray icon for **Sync now**, **Settings…**, and **Quit**.

### Running without the tray (optional)

The agent can also run headless — useful for testing, or to run it as a Windows
service:

```
cd apps/tally-agent
npm install --omit=dev
set MUMBAI_ERP_URL=https://api.your-mumbai-erp-domain.com
set MUMBAI_ERP_TOKEN=mea_xxxxxxxx
set TALLY_COMPANY=Your Company Name As In Tally
node src/run-headless.js
```

---

## 5. Part 3 — Pair the agent

1. In **Mumbai ERP** → sidebar **Tally Sync** → **Settings** tab.
2. Click **Generate token**. A `mea_…` token appears **once** — copy it now.
3. Open the agent's tray icon → **Settings**, and fill in:

   | Field | Value |
   |---|---|
   | Mumbai ERP address | your API URL, e.g. `https://api.your-mumbai-erp-domain.com` |
   | Pairing token | the `mea_…` token from step 2 |
   | Tally host | `localhost` (or the LAN IP if Tally is on another PC) |
   | Tally port | `9000` |
   | Tally company name | **exactly** as it reads in Tally's title bar |

4. Click **Save**, then **Test Tally connection**.
   - *"Tally responded"* → good.
   - *"No response from Tally"* → Tally isn't running, the company isn't loaded,
     or the HTTP server from Part 1 isn't on.

Back in Mumbai ERP, the **Tally Sync** page now shows **"Sync agent online"**.

---

## 6. Part 4 — Map your ledgers

**Mumbai ERP → Tally Sync → Ledger Mapping.**

Every name here must match a ledger that **already exists in your Tally**. The
list is pre-filled with recommended names — the accountant edits each one to
match the client's actual chart of accounts.

| Group | One row per… | What it's for |
|---|---|---|
| **Franchise outlets (Sundry Debtors)** | each outlet | the outlet's own debtor ledger, so outstanding-per-outlet is traceable in Tally |
| **GST suppliers (Sundry Creditors)** | each GST-registered supplier | the supplier's own creditor ledger |
| **Sales ledgers** | franchise / counter / non-GST | where sales revenue is credited |
| **Purchase ledgers** | raw material / packing / traded goods | where purchases are debited |
| **GST ledgers** | Output & Input CGST / SGST / IGST | the tax ledgers under *Duties & Taxes* |
| **Bank & cash (by payment method)** | Cash, UPI, Card, Bank transfer, Razorpay | which ledger the money lands in / comes from |
| **Expense categories** | each ERP expense category | the P&L expense head (Direct vs Indirect) |
| **Other ledgers** | round-off, discount, freight recovered, partner accounts, etc. | supporting ledgers |

### Fresh Tally vs existing Tally

- **Fresh company:** create the ledgers in Tally first (the accountant does this
  in Tally, or imports a starter list), then enter those names here.
- **Existing company:** just type the names you already use. The sync **never
  creates a ledger itself** — a voucher that names an unknown ledger fails with
  Tally's own message and waits for you to fix the mapping and retry.

---

## 7. Part 5 — Set the accounting rules

**Mumbai ERP → Tally Sync → Settings.** These are the accountant's calls. The
defaults are the recommended treatment; the notes below flag what to confirm.

| Setting | Options | Recommended | Confirm with CA |
|---|---|---|---|
| **What Tally holds** | Accounting vouchers only / also mirror stock | **Accounting vouchers only** | Keeps stock in the ERP as the single source of truth |
| **Counter sales are** | Retail sale of goods (HSN, ITC) / restaurant service (SAC, no ITC) | Goods | **Ask the CA** — if the counter serves food to eat in, it may be a restaurant supply |
| **Razorpay receipts** | Gross → clearing ledger / gross → bank directly | Clearing | How does the client reconcile Razorpay's ~2% fee today? |
| **Unpaid (accrued) expenses** | Only when paid / journal now | Only when paid | Cash basis vs mercantile |
| **Closing-stock value basis** | GST-purchase stock only / total ERP stock | *CA must choose* | Non-GST purchases are off the books — how should Tally's closing stock reflect that? |
| **Per-module switches** | Sales / Receipts / Purchases / Expenses / Stock journal | all on except stock journal | — |
| **Block on GST rate mismatch** | on / off | on | a voucher whose item GST rate ≠ its configured rate is held, not posted |

### Two rules you cannot switch off (enforced in code)

1. **Non-GST purchases never reach Tally.** A purchase entered without a GST
   invoice (cash / unregistered vendor) is marked **Excluded** with a reason and
   shown on the *Excluded* tab — a clear audit trail that the system skipped it
   deliberately.
2. **Every voucher must balance.** A voucher whose debits ≠ credits never leaves
   the queue.

---

## 8. Part 6 — Go live

1. In **Tally Sync → Settings**, set the **Go-live cutover date**. Only
   transactions dated on or after this are synced. Everything before it —
   opening balances and history — stays the accountant's job directly in Tally.
2. Turn **Sync ON** (the master switch).
3. Create one test bill and one test payment dated after the cutover, watch them
   reach Tally, then check in Tally that the entries look right. Delete the test
   entries from Tally if needed.

---

## 9. Part 7 — Day to day: the Sync Dashboard

**Mumbai ERP → Tally Sync → Sync Dashboard.** Every synced transaction shows up
here with one of four states:

| State | Meaning | What to do |
|---|---|---|
| **In Tally** | posted; shows Tally's own voucher id | nothing |
| **Waiting** | queued; the agent will post it on its next pass (≈20s) | nothing — unless it's stuck (see below) |
| **Failed** | Tally rejected it, with Tally's exact message (e.g. *"Ledger 'Andheri Outlet' does not exist"*) | fix the cause (usually a ledger name in the mapping), then click **Retry** |
| **Excluded** | deliberately not synced (non-GST purchase, a branch's own cost) — on the *Excluded (non-GST)* tab | nothing — this is the audit trail |

**"Waiting" not clearing** usually means one of:
- the agent isn't online (check the banner at the top of the page),
- Tally isn't running / company not loaded,
- Sync is OFF, or the transaction is dated before the cutover.

---

## 10. What syncs, and what doesn't

| In the ERP | Tally voucher | Notes |
|---|---|---|
| Franchise bill (GST outlet) | **Sales** | Dr outlet · Cr sales + Output CGST/SGST (or IGST if the outlet is out of state) · bill-wise ref |
| Franchise bill (non-GST outlet) | **Sales** | Dr outlet · Cr *Sales – Non-GST* · no tax |
| Counter (POS) sale, main branch | **Sales** | Dr cash/card/UPI · Cr counter sales + Output CGST/SGST |
| Counter sale at a **franchise** | — | **excluded** — the franchise's own B2C revenue, not the company's books |
| Payment received | **Receipt** | Dr bank/cash · Cr outlet · against the bill for bill-wise allocation |
| GST raw-material purchase | **Purchase** | Cr supplier · Dr purchase ledger(s) + Input CGST/SGST/IGST · round-off |
| **Non-GST purchase** | — | **excluded, always** (audit trail on the Excluded tab) |
| Supplier payment (against a GST bill) | **Payment** | Dr supplier · Cr bank/cash |
| Expense / salary / advance | **Payment** (or **Journal** if unpaid) | Dr expense head · Cr bank/cash (or the partner's account if a partner paid) |
| A branch's own expense or purchase | — | **excluded** — the branch bears that cost |
| Godown ⇄ branch stock transfer | **Stock Journal** | only if "mirror stock" is turned on |
| Quick stock intake without a bill | — | **excluded** — no GST detail; use a purchase bill |

---

## 11. Duplicate protection

Every voucher carries the ERP's own reference number (`BL-2026-00001`,
`PB-2026-00001`, …) as its Tally `REMOTEID`. A retry with the same reference
**updates** the existing Tally voucher rather than creating a second one. An
edited transaction is sent as *delete-then-recreate* keyed on that reference.

---

## 12. Testing before real go-live

TallyPrime publishes no formal API spec, and GST field shapes have shifted
between releases. Before trusting the sync on the client's live company:

1. In Tally, **create a throwaway company** (same GST settings).
2. Point the agent's *Tally company name* at it.
3. Push **one of each voucher type** (a franchise bill, a payment, a GST
   purchase, an expense).
4. In that test company, confirm each voucher's **debit/credit and GST amounts
   are correct** and that the **bill-wise references** attach properly.
5. Re-send one (edit it in the ERP) and confirm Tally **updates** it rather than
   duplicating.
6. Then repoint the agent at the real company and set the cutover date.

---

## 13. Reference

**Ports (dev):** API `4100`, web `3100`, Postgres `5434`, Tally `9000` (on the client PC).

**Agent config file:**
`%APPDATA%\Mumbai ERP Tally Sync Agent\config.json` (Windows), or
`~/.mumbai-erp-tally-agent/config.json` when run headless.

**Where the code lives:**

| Piece | Path |
|---|---|
| Outbox + builder + API | `apps/api/src/modules/tally/` |
| Build worker | `apps/api/src/jobs/handlers/tallyBuildVouchers.ts` |
| Owner screen | `apps/web/app/(dashboard)/tally/page.tsx` |
| Sync agent | `apps/tally-agent/` |
| Voucher → Tally XML | `apps/tally-agent/src/xml.js` |

**Regenerate a clean database** (dev only, wipes everything):
`npm run -w @mumbai-erp/api prisma:reset`

---

*This guide tracks the implementation in the repo. If the two disagree, the code
is right — raise it so the guide gets fixed.*
