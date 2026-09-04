# Mumbai ERP — Tally Sync Agent (Windows)

A small tray app that runs on the client's Tally machine. It **connects outward** to
Mumbai ERP, pulls the accounting vouchers the ERP has already built and validated,
and posts them into **TallyPrime**'s local XML-over-HTTP interface (`localhost:9000`).

**One way only.** The agent never reads business data out of Tally and never listens
on a network port — so nothing needs opening on the office router or firewall. Its
only requirement is that the PC can make outbound HTTPS calls (every PC can).

```
Mumbai ERP (cloud)  ──HTTPS, agent dials out──▶  this agent  ──HTTP localhost:9000──▶  TallyPrime 7.1
        outbox / queue                            JSON → Tally XML                     same PC / LAN
```

## What it does each cycle (default: every 20s)

1. Heartbeat to the ERP, so the owner's **Settings → Tally Sync** dashboard shows the
   agent online.
2. Ping Tally. If Tally is closed or the company isn't loaded, it does nothing this
   cycle — the vouchers wait safely in the ERP queue.
3. Pull a batch of built vouchers, translate each to Tally XML
   (`src/xml.js`), `POST` to Tally.
4. Report each outcome back: **SYNCED** (with Tally's own voucher id) or **FAILED**
   (with Tally's own error message, e.g. *"Ledger 'Andheri Outlet' does not exist"*).
   Failed vouchers stay FAILED in the ERP for the owner to fix the mapping and Retry.

An edited transaction is sent as *delete-then-recreate* keyed on the ERP reference
(`REMOTEID`), so a retry never leaves a duplicate in Tally.

## First-time setup

1. In Mumbai ERP: **Settings → Tally Sync → Generate token**. Copy it.
2. Install and open this agent. In its Settings window enter:
   - **Mumbai ERP address** — the API URL
   - **Pairing token** — from step 1
   - **Tally company name** — exactly as it reads in Tally
   - Tally host / port — usually `localhost` / `9000`
3. Click **Test Tally connection**. If it fails: open TallyPrime, load the company,
   and enable the HTTP server (F1 → Settings → Connectivity → *TallyPrime acts as* →
   **Both**, or at least *HTTP server*).
4. Back in Mumbai ERP, finish the **Ledger Mapping**, set the go-live cutover date,
   then turn **Sync ON**.

## Running it

### Option A — from source on the Tally PC (recommended, no installer)

Fastest and most reliable. On the Windows machine that has Tally (Node 20+ and Git installed):

```
git clone <repo>  (or copy the repo folder over)
cd apps/tally-agent
npm install --omit=dev
```

**Headless** (no window — best for a background service). Edit the four values at
the top of `start-agent.bat` and double-click it, or:

```
set MUMBAI_ERP_URL=https://api.your-domain.com
set MUMBAI_ERP_TOKEN=mea_xxxxxxxx
set TALLY_COMPANY=Your Company Name As In Tally
node src\run-headless.js
```

To run at login: put a shortcut to `start-agent.bat` in
`shell:startup`, or add it as a Task Scheduler task ("At log on", "Run whether
user is logged on or not").

**Tray app** instead of headless: `npm install` (with dev deps, pulls Electron)
then `npm start`.

### Option B — build the installer

The NSIS installer **must be built on Windows** (or a Windows CI runner) —
cross-building it from macOS produces a broken install (dangling Start-Menu
shortcut). On Windows:

```
cd apps/tally-agent
npm install
npm run dist        # → dist/Mumbai ERP Tally Sync Agent-Setup-<version>.exe
```

It auto-launches at login and pins to the system tray. Windows SmartScreen will
warn about the unsigned exe — *More info → Run anyway*, or sign it.

## Notes on TallyPrime compatibility

TallyPrime publishes no formal API compatibility spec, and GST field shapes have
shifted between releases. Before go-live, run each voucher type against a **throwaway
Tally company** and confirm the `ALLLEDGERENTRIES.LIST` sign convention
(debit = `ISDEEMEDPOSITIVE Yes` + negative `AMOUNT`) and the `REMOTEID`
delete/re-create behaviour on the client's exact TallyPrime 7.1 build.
