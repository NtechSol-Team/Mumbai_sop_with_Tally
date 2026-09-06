'use strict';

/**
 * Run the sync loop without Electron — for testing the ERP ↔ agent side on any
 * machine, and for running the agent as a plain Windows service if a tray isn't
 * wanted.
 *
 *   MUMBAI_ERP_URL=http://localhost:4100 \
 *   MUMBAI_ERP_TOKEN=mea_xxxxxxxx \
 *   TALLY_HOST=localhost TALLY_PORT=9000 TALLY_COMPANY="Your Company" \
 *   node src/run-headless.js            # loops
 *   node src/run-headless.js --once     # one pass, then exit
 */

const config = require('./config');
const syncLoop = require('./sync-loop');
const tally = require('./tally-client');
const { version } = require('../package.json');

async function main() {
  const once = process.argv.includes('--once');
  const c = config.get();

  if (process.argv.includes('--list-companies')) {
    const result = await tally.discoverCompanies(c);
    if (result.error) throw new Error(result.error);
    console.log(JSON.stringify(result.openCompanies, null, 2));
    return;
  }
  if (process.argv.includes('--check')) {
    const result = await tally.ping(c);
    console.log(JSON.stringify({ ...result, agentVersion: version, companySource: config.companySource() }, null, 2));
    process.exitCode = result.companyOpen ? 0 : 1;
    return;
  }

  if (!config.isConfigured()) {
    console.error(`Not configured. Set MUMBAI_ERP_URL and MUMBAI_ERP_TOKEN, or configure ${config.storePath}. Headless and Electron use separate files by default.`);
    process.exit(1);
  }

  console.log(`Mumbai ERP Tally Sync Agent v${version} (headless, protocol 2)
    ERP:   ${c.erpUrl}
    Tally: ${c.tallyHost}:${c.tallyPort}${c.tallyCompany ? ` (${c.tallyCompany})` : ''}
    Poll:  every ${c.pollSeconds}s
    Company source: ${config.companySource()}
  `);

  function ledgerBit(s) {
    // Always say SOMETHING about ledger provisioning, never stay silent about it —
    // "0 candidates" almost always means the toggle is off, which is easy to miss
    // if this line just disappears.
    if (!s.tallyOk) return null;
    if (s.ledgerCandidates === 0) return 'ledgers: none pending (auto-provision off, or nothing left to create)';
    const bits = [];
    if (s.ledgerCreated) bits.push(`${s.ledgerCreated} created`);
    if (s.ledgerExists) bits.push(`${s.ledgerExists} already existed`);
    if (s.ledgerFailed) bits.push(`${s.ledgerFailed} FAILED`);
    return `ledgers: ${bits.join(', ')} (of ${s.ledgerCandidates} pending)`;
  }

  function line(s) {
    const t = new Date().toLocaleTimeString();
    const bits = [
      `ERP ${s.erpOk ? 'ok' : 'DOWN'}`,
      `Tally ${s.tallyOk ? 'ok' : s.tallyReachable ? 'reachable, company not matched' : 'not responding'}`,
      ledgerBit(s),
      s.pushed ? `pushed ${s.pushed}` : null,
      s.failed ? `failed ${s.failed}` : null,
      s.lastError ? `— ${s.lastError}` : null,
    ].filter(Boolean).join(' · ');
    console.log(`[${t}] ${bits}`);
    // Tally's own words for the first few failures — without these you are just
    // staring at a count, which is not debuggable.
    for (const f of s.ledgerFailures || []) console.log(`           ledger failed -> ${f}`);
  }

  if (once) {
    await syncLoop.runOnce();
    const state = syncLoop.getState();
    line(state);
    process.exitCode = state.erpOk && state.tallyOk && !state.failed && !state.ledgerFailed ? 0 : 1;
  } else {
    syncLoop.start(line);
    process.on('SIGINT', () => { syncLoop.stop(); process.exit(0); });
  }
}

main().catch((err) => { console.error(err.message || String(err)); process.exitCode = 1; });
