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

const once = process.argv.includes('--once');
const c = config.get();

if (!config.isConfigured()) {
  console.error('Not configured. Set MUMBAI_ERP_URL and MUMBAI_ERP_TOKEN (env) or run the tray app once.');
  process.exit(1);
}

console.log(`Mumbai ERP Tally Sync Agent (headless)
  ERP:   ${c.erpUrl}
  Tally: ${c.tallyHost}:${c.tallyPort}${c.tallyCompany ? ` (${c.tallyCompany})` : ''}
  Poll:  every ${c.pollSeconds}s
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
  syncLoop.runOnce().then(() => { line(syncLoop.getState()); process.exit(0); });
} else {
  syncLoop.start(line);
  process.on('SIGINT', () => { syncLoop.stop(); process.exit(0); });
}
