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

function line(s) {
  const t = new Date().toLocaleTimeString();
  const bits = [
    `ERP ${s.erpOk ? 'ok' : 'DOWN'}`,
    `Tally ${s.tallyOk ? 'ok' : 'not responding'}`,
    s.provisioned ? `ledgers created ${s.provisioned}` : null,
    s.pushed ? `pushed ${s.pushed}` : null,
    s.failed ? `failed ${s.failed}` : null,
    s.lastError ? `— ${s.lastError}` : null,
  ].filter(Boolean).join(' · ');
  console.log(`[${t}] ${bits}`);
}

if (once) {
  syncLoop.runOnce().then(() => { line(syncLoop.getState()); process.exit(0); });
} else {
  syncLoop.start(line);
  process.on('SIGINT', () => { syncLoop.stop(); process.exit(0); });
}
