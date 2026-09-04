'use strict';

const config = require('./config');
const erp = require('./erp-client');
const tally = require('./tally-client');
const { messagesFor } = require('./xml');
const { buildLedgerEnvelope, isAlreadyExists } = require('./ledger-xml');

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
const state = { erpOk: false, tallyOk: false, lastRun: null, lastError: null, pushed: 0, failed: 0, provisioned: 0 };
let onChange = () => {};

/**
 * Only runs when the owner has turned "auto-provision ledgers" on. Creates
 * whatever the ERP hands back (party ledgers, sales/purchase/expense/bank —
 * never the GST duty ledgers) directly in Tally, and reports each outcome.
 * "Already exists" counts as success, not a failure.
 */
async function provisionLedgers(company) {
  const ledgers = await erp.ledgersPending();
  if (!ledgers.length) return { provisioned: 0 };

  const results = [];
  for (const l of ledgers) {
    const xml = buildLedgerEnvelope(l, company);
    const result = await tally.send(xml);
    if (result.ok) results.push({ id: l.id, status: 'CREATED' });
    else if (isAlreadyExists(result.error)) results.push({ id: l.id, status: 'EXISTS' });
    else results.push({ id: l.id, status: 'FAILED', error: result.error });
  }
  await erp.reportLedgerResults(results);
  return { provisioned: results.filter((r) => r.status !== 'FAILED').length };
}

async function processItem(item, company) {
  const msgs = messagesFor(item, company);
  let lastResult = null;
  for (const msg of msgs) {
    const result = await tally.send(msg.xml);
    if (!result.ok) {
      if (msg.action === 'Delete' && msg.tolerateNotFound && /not exist|no vouchers|could not find/i.test(result.error)) {
        continue; // nothing to delete — fine, carry on to Create
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

    state.tallyOk = await tally.ping();
    if (!state.tallyOk) { state.lastError = 'Tally is not responding on ' + `${config.get().tallyHost}:${config.get().tallyPort}`; return; }

    const company = config.get().tallyCompany;

    const prov = await provisionLedgers(company);
    state.provisioned = prov.provisioned;

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
