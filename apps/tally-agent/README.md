# Mumbai ERP — Tally Sync Agent (Windows)

A small tray app that runs on the client's Tally machine. It **connects outward** to
Mumbai ERP, pulls the accounting vouchers the ERP has already built and validated,
and posts them into **TallyPrime**'s local XML-over-HTTP interface (`localhost:9000`).

**One way only.** The agent reads only company/master names for validation; it never pulls financial transactions out of Tally and never listens
on a network port — so nothing needs opening on the office router or firewall. Its
network requirements are outbound access to the ERP API and access to the configured local/LAN Tally HTTP server.

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

An edited transaction retains the existing *delete-then-recreate* workflow, keyed
on the stable ERP entity identity (`REMOTEID`). This is not atomic or an
unconditional duplicate guarantee. Completed results are journalled locally
before ERP acknowledgement, so an acknowledgement outage does not immediately
repost them. See the [current review](../../docs/tally-agent-analysis-and-fix.md)
for remaining crash/retry limits.

## First-time setup

1. In Mumbai ERP: **Settings → Tally Sync → Generate token**. Copy it.
2. Install and open this agent. In its Settings window enter:
   - **Mumbai ERP address** — the API URL
   - **Pairing token** — from step 1
   - **Tally company name** — click **Find open companies**, explicitly select the intended name, then Save
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

## Company discovery and validation (current implementation)

```bat
node src\run-headless.js --list-companies
node src\run-headless.js --check
```

These commands only read Tally and do not need an ERP token. Discovery has no
company context. A normal sync requires an exact configured name in that list
and a successful scoped probe. No first-company, active-company, case-folded or
fuzzy spelling fallback is used. Names keep their original spaces and spelling.
The settings connection test uses the displayed draft; **Sync now** uses saved
settings.

`TALLY_COMPANY` overrides the local file, including an explicitly empty value.
The CLI and settings window identify the effective source. The ERP web page
shows the agent's reported host/port/company; configure those on the Tally PC.
Electron and headless have separate default config files; set
`MUMBAI_ERP_TALLY_CONFIG` explicitly to share one. Run only one agent per dataset.

## Upgrading and verifying

### v1.1.2: ERP timeout reporting

The operator confirmed that v1.1.1 created a ledger (`CREATED=1`, `ERRORS=0`)
and verified its existence in the intended company. A separate preview failure
revealed an ERP timeout-reporting bug: `AbortSignal.timeout` produces a
DOMException with a read-only `message`. The client now wraps errors with their
original cause instead of mutating them, and retains HTTP status information.
Timeouts report `ERP did not respond within 30s.`. The request deadline and
acknowledgement behavior are unchanged. All 78 agent regression tests pass.

To update from this directory, stop the running agent, pull `main`, run
`npm ci --omit=dev`, and check the package version. Use
`node src\run-headless.js --check` to validate the saved company, then
`node src\run-headless.js` to start normal syncing. The saved configuration is
outside this source directory; it does not need to be recreated for this update.
With ERP Sync enabled, normal syncing can create ledgers and post eligible
vouchers. Run only one agent instance. Ctrl+C stops the console agent.

### v1.1.1: ledger import compatibility and diagnostics

Ledger creation now follows the native `Import Data` example in
[Tally's sample XML](https://help.tallysolutions.com/sample-xml/): the header
contains `TALLYREQUEST` without the versioned protocol header, the master has a
direct `NAME`, and the response format is explicitly XML. This addresses the
request-format discrepancy found while investigating the user's HTTP-200
"Unknown request, cannot be processed" response. Acceptance on the installed
Tally build still needs the one-ledger check below; HTTP 200 is not success.

Stop the normal agent first. From this directory, preview a missing ledger from
the existing ERP mappings (requires pairing, Sync ON and auto-provision ON):

```bat
node src\diagnose-ledger.js
```

To attempt creation of **one** missing mapped ledger and print Tally's reply:

```bat
node src\diagnose-ledger.js --create
```

This diagnostic never pulls vouchers or acknowledges results to the ERP. A
successful creation check requires both an accepted import response and the
exact ledger name in a subsequent readback (`ok: true`, `existsAfter: true`).
The next normal sync can discover and acknowledge that existing ledger.
Unknown-request responses are now visible in the agent error; they abort the
current cycle before further ledger imports or voucher dispatch. Normal polling
will try again on its next cycle, so stop the agent while diagnosing a rejection.

### Protocol compatibility

This release uses **agent protocol 2**. Stop old agents, update the ERP API first,
then update this agent and run `npm ci --omit=dev`. No database migration is
required. The new agent refuses an old API before it posts vouchers. The new API
requires `X-Tally-Agent-Protocol: 2` on every agent request and stops older agents
with an update message before they receive work. Set pairing
credentials locally; the launcher no longer embeds a token or a company name.
Rotate any token previously committed to source control.

Both Sync ON and auto-provision ON are required for ledger creation. Ledger
existence is checked against names read from the selected company. GST identity
is never silently stripped after a failed create. The optional stock-journal
export is blocked pending verification of its source/destination XML contract;
keep **Accounting vouchers only** selected.

Claims for an interrupted batch expire after 30 minutes; completed results are
retried from `pending-results.json` before any further posting. Do not delete
that journal to work around a destination mismatch; restore the original
connection settings and acknowledge it first.

Run `npm test` here for agent regressions, and `npm run test:tally --workspace
@mumbai-erp/api` from the repository root for server regressions. Live Tally
acceptance, edits and cancellation still need testing on a throwaway company on
the installed Tally build.
