'use strict';

const config = require('./config');
const erp = require('./erp-client');
const tally = require('./tally-client');
const { messagesFor } = require('./xml');
const { buildLedgerMessages, isAlreadyExists } = require('./ledger-xml');

/**
 * The loop:
 *   1. heartbeat to the ERP (so the owner's dashboard shows the agent online)
 *   2. if Tally is reachable, pull a batch of built vouchers
 *   3. post each into Tally, collect SYNCED / FAILED with Tally's own message
 *   4. report the outcomes back to the ERP
 *
 * Nothing is lost: if Tally is closed we simply don't pull, and the vouchers
 * wait in the ERP queue until it's back. A voucher that fails stays FAILED in
 * the ERP with the reason, for the owner to fix the mapping and hit Retry.
 */

let timer = null;
let running = false;
const state = {
  erpOk: false, tallyOk: false, lastRun: null, lastError: null, pushed: 0, failed: 0,
  // Ledger auto-provisioning, reported every cycle (not just when something happened) —
  // so "toggle is off" / "nothing left to do" / "created 5" are all visible, not silent.
  ledgerCandidates: 0, ledgerCreated: 0, ledgerExists: 0, ledgerFailed: 0, ledgerFailures: [], provisioned: 0,
};
let onChange = () => {};

/**
 * Only does anything when the owner has turned "auto-provision ledgers" on —
 * erp.ledgersPending() returns an empty list otherwise, which is not an error,
 * just nothing to do. Creates whatever the ERP hands back (party ledgers,
 * sales/purchase/expense/bank — never the GST duty ledgers) directly in Tally,
 * and reports each outcome. "Already exists" counts as success, not a failure.
 */
async function provisionOne(ledger, company) {
  let lastError = null;
  for (const attempt of buildLedgerMessages(ledger, company)) {
    const result = await tally.send(attempt.xml);
    if (result.ok) return { id: ledger.id, status: 'CREATED' };
    // Provisioning is "ensure this ledger exists", so both of Tally's ways of
    // saying "it already does" are success: an explicit duplicate message, and
    // the silent no-op it returns when a Create targets an existing master.
    if (result.isNoOp || isAlreadyExists(result.error)) return { id: ledger.id, status: 'EXISTS' };
    lastError = result.error;
  }
  return { id: ledger.id, status: 'FAILED', error: lastError, ledgerName: ledger.name };
}

async function provisionLedgers(company) {
  const ledgers = await erp.ledgersPending();
  if (!ledgers.length) return { candidates: 0, created: 0, exists: 0, failed: 0, failures: [] };

  const results = [];
  for (const l of ledgers) results.push(await provisionOne(l, company));

  await erp.reportLedgerResults(results);
  const failures = results.filter((r) => r.status === 'FAILED');
  return {
    candidates: ledgers.length,
    created: results.filter((r) => r.status === 'CREATED').length,
    exists: results.filter((r) => r.status === 'EXISTS').length,
    failed: failures.length,
    // Carried up so the console can show WHY, not just how many.
    failures: failures.slice(0, 3).map((f) => `${f.ledgerName}: ${f.error}`),
  };
}

async function processItem(item, company) {
  const msgs = messagesFor(item, company);
  let lastResult = null;
  for (const msg of msgs) {
    const result = await tally.send(msg.xml);
    if (!result.ok) {
      // Re-posting an edited voucher deletes the old one first. Tally reporting
      // "nothing to delete" — either in words or as a silent no-op — is the
      // expected case when the original never made it in, so carry on to Create.
      if (msg.action === 'Delete' && msg.tolerateNotFound
        && (result.isNoOp || /not exist|no vouchers|could not find/i.test(result.error))) {
        continue;
      }
      return { id: item.id, status: 'FAILED', error: result.error, tallyResponse: result.raw?.slice(0, 4000) };
    }
    lastResult = result;
  }
  return {
    id: item.id,
    status: 'SYNCED',
    tallyVoucherId: lastResult?.tallyVoucherId || undefined,
    tallyResponse: lastResult?.raw?.slice(0, 4000),
  };
}

async function runOnce() {
  if (running || !config.isConfigured()) return;
  running = true;
  state.lastRun = new Date().toISOString();
  state.lastError = null;
  try {
    await erp.heartbeat();
    state.erpOk = true;

    // Reachable is not enough — posting into the wrong company is worse than not
    // posting at all, so both have to be true before anything is sent.
    const probe = await tally.ping();
    state.tallyOk = probe.reachable && probe.companyOpen;
    if (!probe.reachable) {
      state.lastError = probe.error || `Tally is not responding on ${config.get().tallyHost}:${config.get().tallyPort}`;
      return;
    }
    if (!probe.companyOpen) { state.lastError = probe.error; return; }

    const company = config.get().tallyCompany;

    const prov = await provisionLedgers(company);
    state.ledgerCandidates = prov.candidates;
    state.ledgerCreated = prov.created;
    state.ledgerExists = prov.exists;
    state.ledgerFailed = prov.failed;
    state.ledgerFailures = prov.failures;
    state.provisioned = prov.created + prov.exists;

    const batch = await erp.pullPending(25);
    if (!batch.length) { state.pushed = 0; state.failed = 0; return; }

    const results = [];
    for (const item of batch) {
      try {
        results.push(await processItem(item, company));
      } catch (err) {
        results.push({ id: item.id, status: 'FAILED', error: err.message || String(err) });
      }
    }
    await erp.reportResults(results);
    state.pushed = results.filter((r) => r.status === 'SYNCED').length;
    state.failed = results.filter((r) => r.status === 'FAILED').length;
  } catch (err) {
    state.erpOk = err.status === undefined ? false : true;
    state.lastError = err.message || String(err);
  } finally {
    running = false;
    onChange({ ...state });
  }
}

function start(changeCb) {
  onChange = changeCb || (() => {});
  stop();
  const tick = async () => {
    await runOnce();
    timer = setTimeout(tick, config.get().pollSeconds * 1000);
  };
  tick();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { start, stop, runOnce, getState: () => ({ ...state }) };
