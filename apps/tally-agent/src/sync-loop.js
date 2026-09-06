'use strict';

const config = require('./config');
const erp = require('./erp-client');
const tally = require('./tally-client');
const journal = require('./result-store');
const { messagesFor } = require('./xml');
const { buildLedgerMessages, isAlreadyExists } = require('./ledger-xml');

let timer = null;
let running = false;
let generation = 0;
let onChange = () => {};
const state = {
  erpOk: false, tallyOk: false, tallyReachable: false, company: null, openCompanies: [],
  lastRun: null, lastError: null, pushed: 0, failed: 0,
  ledgerCandidates: 0, ledgerCreated: 0, ledgerExists: 0, ledgerFailed: 0, ledgerFailures: [], provisioned: 0,
};

async function provisionOne(ledger, company, c, existing) {
  const identity = { id: ledger.id, ledgerName: ledger.name, parentGroup: ledger.parentGroup };
  if (existing.has(ledger.name)) return { ...identity, status: 'EXISTS' };
  let lastError;
  for (const attempt of buildLedgerMessages(ledger, company)) {
    const result = await tally.send(attempt.xml, c, 'Create');
    if (result.contextError) throw Object.assign(new Error(result.error), { source: 'TALLY' });
    if (result.ok) {
      existing.add(ledger.name);
      return { ...identity, status: 'CREATED' };
    }
    if (result.isNoOp || isAlreadyExists(result.error)) {
      // A silent import, a duplicate GROUP name or an unrelated error does not
      // prove this ledger exists. Read its actual name from this company.
      const names = await tally.listLedgerNames(company, c);
      for (const name of names) existing.add(name);
      if (existing.has(ledger.name)) return { ...identity, status: 'EXISTS' };
    }
    lastError = result.error;
  }
  return { ...identity, status: 'FAILED', error: (lastError || 'Tally did not confirm ledger creation.').slice(0, 2000) };
}

async function provisionLedgers(company, c) {
  const ledgers = await erp.ledgersPending(c);
  state.ledgerCandidates = ledgers.length;
  if (!ledgers.length) return;
  const existing = new Set(await tally.listLedgerNames(company, c));
  const results = [];
  for (const ledger of ledgers) {
    results.push(await provisionOne(ledger, company, c, existing));
    // Match the API's 200-result limit, including large initial mappings.
    if (results.length === 200) {
      await erp.reportLedgerResults(results, c);
      recordLedgerCounts(results);
      results.length = 0;
    }
  }
  if (results.length) {
    await erp.reportLedgerResults(results, c);
    recordLedgerCounts(results);
  }
}

function recordLedgerCounts(results) {
  state.ledgerCreated += results.filter((r) => r.status === 'CREATED').length;
  state.ledgerExists += results.filter((r) => r.status === 'EXISTS').length;
  state.ledgerFailed += results.filter((r) => r.status === 'FAILED').length;
  state.ledgerFailures = [...state.ledgerFailures, ...results.filter((r) => r.status === 'FAILED').map((r) => `${r.ledgerName}: ${r.error}`)].slice(0, 3);
  state.provisioned = state.ledgerCreated + state.ledgerExists;
}

async function explainError(error, company, c) {
  if (!tally.isCompanyContextError(error)) return error;
  const discovery = await tally.discoverCompanies(c);
  if (discovery.error) return `${error} — selected company ${JSON.stringify(company)}. Could not refresh the company list: ${discovery.error}`;
  return `${error} — selected company ${JSON.stringify(company)}. Open companies: ${discovery.openCompanies.map((n) => JSON.stringify(n)).join(', ') || 'none'}. Open the intended company or select its exact name in the agent. Sync is paused.`;
}

async function processItem(item, company, c) {
  const messages = messagesFor(item, company);
  let lastResult = null;
  let deleted = false;
  for (const message of messages) {
    const result = await tally.send(message.xml, c, message.action);
    lastResult = result;
    if (!result.ok) {
      // Only a structurally valid zero-count response is tolerated. A broad
      // "not exist" regex also matched missing ledgers and other real failures.
      if (message.action === 'Delete' && message.tolerateNotFound && result.isNoOp) continue;
      const detail = await explainError(result.error, company, c);
      return {
        id: item.id, revision: item.revision, status: 'FAILED',
        error: `${detail}${deleted ? ' The previous voucher was deleted; recreate failed. Correct the cause and Retry to restore it.' : ''}`.slice(0, 2000),
        tallyResponse: result.raw?.slice(0, 7500), stopBatch: result.contextError === true,
      };
    }
    if (message.action === 'Delete') deleted = true;
  }
  return { id: item.id, revision: item.revision, status: 'SYNCED', tallyVoucherId: lastResult?.tallyVoucherId || undefined, tallyResponse: lastResult?.raw?.slice(0, 7500) };
}

async function runOnce() {
  if (running) return;
  running = true;
  Object.assign(state, {
    lastRun: new Date().toISOString(), lastError: null, pushed: 0, failed: 0,
    erpOk: false, tallyOk: false, tallyReachable: false, company: null, openCompanies: [],
    ledgerCandidates: 0, ledgerCreated: 0, ledgerExists: 0, ledgerFailed: 0, ledgerFailures: [], provisioned: 0,
  });
  let stage = 'CONFIG';
  try {
    const c = config.get();
    if (!c.erpUrl || !c.agentToken) { state.lastError = 'Agent is not paired. Configure the ERP address and token.'; return; }
    stage = 'ERP';
    const heartbeat = await erp.heartbeat(c);
    state.erpOk = true;
    if (heartbeat.protocolVersion !== 2) throw new Error('Update the ERP API before running this agent; revision-safe acknowledgements require agent protocol 2.');
    // Retry acknowledgements before pulling or writing anything else, even when
    // sync is now OFF or Tally has been closed since the previous successful post.
    const unreported = journal.load(c);
    if (unreported.length) { await erp.reportResults(unreported, c); journal.clear(); }

    stage = 'TALLY';
    const probe = await tally.ping(c);
    state.tallyReachable = probe.reachable;
    state.tallyOk = probe.companyOpen && !probe.error;
    state.openCompanies = probe.openCompanies || [];
    state.company = probe.company;
    if (!state.tallyOk) { state.lastError = probe.error; return; }
    if (!heartbeat.syncEnabled) { state.lastError = 'Sync is OFF in the ERP. Vouchers and ledger provisioning are paused.'; return; }
    const company = probe.company;
    await provisionLedgers(company, c);

    stage = 'ERP';
    const batch = await erp.pullPending(25, c);
    const results = [];
    for (const item of batch) {
      stage = 'TALLY';
      let result;
      try { result = await processItem(item, company, c); }
      catch (err) {
        result = { id: item.id, revision: item.revision, status: 'FAILED', error: (err.message || String(err)).slice(0, 2000), stopBatch: err.source === 'TALLY' };
      }
      const { stopBatch, ...reported } = result;
      results.push(reported);
      journal.save(c, results);
      if (stopBatch) {
        state.tallyOk = false;
        state.lastError = result.error;
        break; // untouched items stay PENDING; do not fail the entire batch
      }
    }
    if (results.length) {
      stage = 'ERP';
      await erp.reportResults(results, c);
      journal.clear();
      state.pushed = results.filter((r) => r.status === 'SYNCED').length;
      state.failed = results.filter((r) => r.status === 'FAILED').length;
      if (state.failed && !state.lastError) state.lastError = results.find((r) => r.status === 'FAILED').error;
    }
  } catch (err) {
    const source = err.source || stage;
    if (source === 'ERP') state.erpOk = false;
    if (source === 'TALLY') state.tallyOk = false;
    state.lastError = err.message || String(err);
  } finally {
    running = false;
    onChange({ ...state });
  }
}

function start(changeCb) {
  stop();
  onChange = changeCb || (() => {});
  const current = generation;
  const tick = async () => {
    await runOnce();
    if (current !== generation) return;
    let seconds = 20;
    try { seconds = config.get().pollSeconds; } catch { /* runOnce already reports invalid config */ }
    timer = setTimeout(tick, seconds * 1000);
  };
  void tick();
}

function stop() {
  generation += 1; // an in-flight tick cannot resurrect a stopped loop
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { start, stop, runOnce, getState: () => ({ ...state }), provisionOne, processItem };
