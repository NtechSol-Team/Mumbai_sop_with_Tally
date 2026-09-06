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

## 1a. The whole setup, in order

Each step links to its section. Do them top to bottom.

| # | Step | Where | One time? |
|---|---|---|---|
| 1 | Install TallyPrime, licence it | Office PC | yes — [Part 0.1–0.2](#2b-part-0--install-tallyprime-and-create-the-company) |
| 2 | Create the company, enable GST | Tally | yes — [Part 0.3–0.4](#2b-part-0--install-tallyprime-and-create-the-company) |
| 3 | Fill in Business Profile (name, GSTIN, **partner names**) | ERP → Settings | yes — [Part 0.5](#2b-part-0--install-tallyprime-and-create-the-company) |
| 4 | Turn on Tally's HTTP server (port 9000) | Tally | yes — [Part 1](#3-part-1--turn-on-tallys-http-server-one-time-on-the-tally-pc) |
| 5 | Install Node + Git, get the agent running | Office PC | yes — [Part 2](#4-part-2--run-the-sync-agent-on-the-tally-pc) |
| 6 | Generate a pairing token, connect the agent | ERP + agent | yes — [Part 3](#5-part-3--pair-the-agent) |
| 7 | Map every ledger to your Tally chart of accounts | ERP → Tally Sync | yes — [Part 4](#6-part-4--map-your-ledgers) |
| 8 | Create the 6 GST ledgers in Tally by hand | Tally | yes — [Part 6 / 8a](#create-the-6-gst-ledgers-by-hand-on-purpose) |
| 9 | Set the accounting rules | ERP → Tally Sync → Settings | yes — [Part 5](#7-part-5--set-the-accounting-rules) |
| 10 | Set the cutover date, push one test voucher, verify in Tally | ERP + Tally | yes — [Part 6](#8-part-6--go-live) |
| 11 | Turn Sync ON | ERP → Tally Sync | — |
| — | Watch the Sync Dashboard | ERP | daily — [Part 7](#9-part-7--day-to-day-the-sync-dashboard) |

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
- [ ] The **real names of any business partners** who pay company expenses from
      their own pocket (for the Business Profile — see Part 0.5)
- [ ] Answers to the accounting choices in **Part 5**

From **whoever runs the office PC**:

- [ ] A **Windows PC** (Windows 10 or 11) that stays on during business hours
- [ ] Admin access to that PC
- [ ] The PC can browse the internet

If TallyPrime isn't installed yet, **Part 0** below does it. If it is, skip to
Part 1.

---

## 2b. Part 0 — Install TallyPrime and create the company

Do this once, on the office PC that will run Tally. Skip any step already done.

### 0.1 — Download and install TallyPrime

1. On the office PC, open a browser and go to **`https://tallysolutions.com`** →
   **Download** (or search "TallyPrime download"). Download the latest
   **TallyPrime** installer (Release 6.x / 7.x — the sync targets the 7.x XML
   format and is backward-compatible with 6.x).
2. Run the downloaded `setup.exe`.
   - **Application path** — leave the default (`C:\Program Files\TallyPrime`).
   - **Data path** — leave the default, **or** point it at a folder you back up
     (e.g. `D:\TallyData`). Note this path; it's where the company lives.
3. Click **Install**, then **Start TallyPrime**.

### 0.2 — Licence

- **New licence:** on first launch pick **Activate New Licence**, enter the
  serial number and Tally.NET credentials from your TallyPrime purchase, and
  activate online.
- **Existing licence on another PC:** pick **Use Licence from Network** if that
  PC is on the same LAN, or **Reactivate Existing Licence** with the same
  account.
- **No licence yet / just testing:** pick **Continue in Educational Mode**. It
  works for testing the sync but **only lets you enter vouchers dated the 1st,
  2nd or last two days of a month** — fine for a smoke test, not for go-live.

### 0.3 — Create the company

From the TallyPrime start screen: **Create Company** (or **Alt+F3** →
*Create Company* later).

| Field | What to enter |
|---|---|
| **Company name** | The client's registered business name. **Write this down exactly** — the agent's `TALLY_COMPANY` value must match it character-for-character. |
| **Mailing name / address** | As on the GST certificate. State: **Maharashtra**. |
| **State** | **Maharashtra** |
| **PIN / phone / email** | The client's |
| **Financial year begins** | `1-Apr-2025` (or the correct FY start) |
| **Books begin** | Same as FY start, or the go-live date if this company only ever holds synced data |
| **Base currency** | `INR` (default) |

Press **Ctrl+A** to save.

### 0.4 — Enable GST in the company

1. From the **Gateway of Tally**, press **F11** (Company Features).
2. Set **Enable Goods and Services Tax (GST)** → **Yes**, press **Enter** into
   the GST details screen.
3. Fill in:
   - **State** — Maharashtra
   - **Registration type** — Regular
   - **GSTIN/UIN** — the client's 15-character GSTIN
   - **Applicable from** — the GST registration date (or FY start)
   - **Periodicity** — Monthly (or Quarterly if the client files QRMP)
4. **Ctrl+A** to save, **Ctrl+A** again to save Company Features.

> You do **not** need to set up tax rates, HSN codes or stock items in Tally.
> The ERP sends every voucher with its exact tax amounts already computed —
> Tally only records them.

### 0.5 — Fill in the ERP's Business Profile

In **Mumbai ERP → Settings → Business Profile → Edit**:

| Field | Why it matters for the sync |
|---|---|
| **Registered (legal) name** | Printed on invoices; should match the Tally company's mailing name |
| **GSTIN** | Must be the **same GSTIN** as in Tally (step 0.4). The sync decides CGST/SGST vs IGST by comparing this state code (27) to each outlet's. |
| **Partner 1 / Partner 2 name** | If a partner ever pays a business expense from their own pocket, that expense posts to a **"<name> Current A/c"** ledger in Tally. Enter the real partner names here **before** the first such expense syncs. Leave blank if the business has no partner accounts — the fallback labels "Partner 1 / Partner 2" are used. |
| UPI ID / payee name | Not used by the Tally sync (it's the franchise-payment QR), but set it while you're here. |

> **Partner names are configuration, not code.** Renaming a partner here later
> does **not** rename a ledger already created in Tally — if a wrong-named
> partner ledger ("Partner 1 Current A/c", or a name from an earlier test) has
> already reached Tally, delete that ledger in Tally once it has no vouchers
> against it (**Alt+G → Chart of Accounts → Ledgers →** select it **→ Alt+D**),
> then let the sync recreate it with the right name on its next run.

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

## 4. Part 2 — Run the Sync Agent (on the Tally PC)

The reliable way is to run it **from source on the Tally PC**. A packaged `.exe`
installer is possible too, but it must be built on Windows (see the end of this
section) — cross-building it from a Mac produces a broken install (a Start-Menu
shortcut that points at nothing).

### From source — headless (recommended for a background service)

On the Windows PC that runs Tally, with **Node 20+** and **Git** installed:

```
git clone <your repo url> mumbai-erp        (or copy the repo folder over)
cd mumbai-erp\apps\tally-agent
npm install --omit=dev
```

Then open **`start-agent.bat`**, fill in the four values at the top
(ERP URL, the `mea_…` token from Part 3, and your Tally company name), save, and
**double-click it**. A console window shows the agent's status every 20 seconds.

To start it automatically at login: put a shortcut to `start-agent.bat` in the
Startup folder (`Win+R` → `shell:startup`), or add it as a **Task Scheduler**
task ("At log on").

Equivalent without the `.bat`:

```
set MUMBAI_ERP_URL=https://api.your-mumbai-erp-domain.com
set MUMBAI_ERP_TOKEN=mea_xxxxxxxx
set TALLY_COMPANY=Your Company Name Exactly As In Tally
node src\run-headless.js
```

### From source — tray app

If you'd rather have a system-tray icon with a Settings window:

```
cd mumbai-erp\apps\tally-agent
npm install            (with dev deps — pulls Electron, ~150 MB)
npm start
```

### Building the `.exe` installer (optional, Windows only)

```
cd apps\tally-agent
npm install
npm run dist           →  dist\Mumbai ERP Tally Sync Agent-Setup-1.0.0.exe
```

Must run on Windows or a Windows CI runner. Windows SmartScreen will warn about
the unsigned installer — *More info → Run anyway*, or code-sign it.

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

- **Existing company:** just type the names you already use. The sync **never
  creates a ledger itself by default** — a voucher that names an unknown ledger
  fails with Tally's own message and waits for you to fix the mapping and retry.
- **Fresh company:** either create the ledgers by hand, or turn on
  **auto-provisioning** (below) so the agent does most of it for you.

### Auto-provisioning (fresh / test companies only)

**Tally Sync → Settings → "Let the agent create missing ledgers in Tally
itself."** OFF by default. Turn it **ON** for a fresh or throwaway company and
the agent will, on its next cycle, create every mapped ledger that doesn't
exist yet — every outlet's debtor, every supplier's creditor, and the sales /
purchase / expense / bank / round-off / discount ledgers — using the exact
pre-filled names, with GSTIN/address/state filled in for party ledgers where
known.

**It deliberately skips the 6 GST ledgers** (Output/Input CGST/SGST/IGST).
Their "Type of duty/tax" setup is the one place Tally's format varies enough
across versions that its own ledger wizard is the safer way to create them —
create those 6 yourself (two minutes, see the table above).

The **Ledger Mapping** table shows a **Confirmed / Not yet** column — flips to
Confirmed the moment the agent creates (or finds) that ledger in Tally.

Turn this **off** again once you're working with a real client's books, unless
you specifically want every new outlet/supplier to get its ledger created
automatically without review.

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

## 8a. Checking things inside Tally (step by step)

Everything below is done in **TallyPrime on the Tally PC**, with the company
loaded. `Alt+G` is "Go To" — it works from anywhere and is the fastest route.

### Confirm you're in the right company

Look at the top of the Tally window — the company name is shown there. It must
match the `TALLY_COMPANY` value in `start-agent.bat` **exactly**. If it doesn't:
`Alt+F3` → *Select Company* → pick the right one.

### See every ledger that exists

1. Press **Alt+G**.
2. Type **`Chart of Accounts`** and press **Enter**.
3. Choose **Ledgers**, press **Enter**.

You get the full list. Press **Enter** on any ledger to open it (Esc to back out
without changing anything).

To see them **organised by group** instead — which is what you want when
checking the sync's ledgers — pick **Groups** at step 3, then drill into
*Sundry Debtors*, *Sales Accounts*, and so on.

Other routes to the same place:
- **Gateway of Tally → Chart of Accounts → Ledgers**
- **Alt+G → `List of Ledgers`**
- To check one name quickly: **Gateway of Tally → Alter → Ledger** — the picker
  lists what exists, so if a name isn't in it, it wasn't created.

### What should be there after provisioning

| Group | Expected ledgers |
|---|---|
| Sundry Debtors | one per franchise outlet, plus `Counter Sales` |
| Sundry Creditors | one per GST supplier you've entered a purchase for |
| Sales Accounts | `Sales - Franchise`, `Sales - Counter`, `Sales - Non-GST` |
| Purchase Accounts | `Purchase - Raw Material`, `Purchase - Packing Material`, `Purchase - Traded Goods` |
| Bank Accounts | `Bank - Current A/c`, `Razorpay Clearing` |
| Cash-in-Hand | `Cash` |
| Indirect Expenses | `Round Off`, `Discount Allowed`, `Bank & PG Charges`, + your expense categories |
| Direct Expenses | your factory/godown expense categories |
| Fixed Assets | `Plant & Equipment` |
| Current Liabilities | `Outstanding Expenses` |

This check is worth doing rather than trusting the agent's "already existed"
count: that count comes from Tally silently accepting a create for a master it
already has, and in rare cases Tally goes quiet for a different reason. Anything
genuinely missing shows up later as a `ledger does not exist` failure on the
first voucher that needs it.

### Create the 6 GST ledgers (by hand, on purpose)

The agent never creates these — Tally's own wizard handles the duty/tax fields
more reliably than generated XML. Do each of the six:

1. **Alt+G** → type **`Create Ledger`** → **Enter** (or Gateway of Tally →
   *Create* → *Ledger*).
2. **Name**: `Output CGST` (then repeat for the other five).
3. **Under**: start typing `Dut` and pick **Duties & Taxes**.
4. **Type of duty/tax**: **GST**.
5. **Tax type**: `Central Tax` for CGST · `State Tax` for SGST ·
   `Integrated Tax` for IGST.
6. Leave *Percentage of calculation* / *Rounding method* at their defaults — the
   ERP sends the exact tax amount, it does not ask Tally to calculate it.
7. **Ctrl+A** to save.

The six: `Output CGST`, `Output SGST`, `Output IGST`, `Input CGST`,
`Input SGST`, `Input IGST`.

### See a voucher the sync actually posted

1. **Alt+G** → type **`Day Book`** → **Enter**. It opens on today.
2. **F2** changes the date; **Alt+F2** sets a date range.
3. **Enter** on a voucher opens it — check the debit and credit lines and the
   GST amounts against the bill in the ERP.

To see one party's activity instead: **Alt+G** → `Ledger Vouchers` → pick the
outlet's ledger. That shows every voucher hitting that outlet and its running
balance — the same figure the ERP shows as their outstanding.

### If a voucher is missing from Tally

Check the ERP's **Sync Dashboard** first — if it says *In Tally* but you can't
find it, you're almost certainly looking at the wrong company or the wrong date
in the Day Book. If it says *Failed*, the row carries Tally's own error text.

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

### Common failure messages

| Tally's message | What it means | Fix |
|---|---|---|
| **`Could not set 'SVCurrentCompany' to '<name>'`** | The voucher named a company Tally can't switch to — either it isn't open, or the name isn't an **exact** match (Tally is case- and space-sensitive: `Mumbai Erp` ≠ `Mumbai ERP`). | Open the company in Tally (**F3 → Select Company**). Get its exact stored name from **F3 → Alter →** the *Name* field, and set the agent's *Tally company name* / `TALLY_COMPANY` to exactly that, then restart the agent. The agent's console and the dashboard now print the names Tally actually has open. |
| **`Ledger '<name>' does not exist`** | A voucher line points at a ledger that isn't in this Tally company. | Fix that row in **Tally Sync → Ledger Mapping** to the name that exists, or create the ledger in Tally, then **Retry**. |
| **`Voucher totals do not match`** / accepted but *created nothing* | Rare — usually a GST rounding edge or a duplicate `REMOTEID` already present. | Check the voucher in the ERP; if it looks right, open the Failed row's detail for Tally's raw response. |

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
