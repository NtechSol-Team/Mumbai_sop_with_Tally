'use strict';

const config = require('./config');
const tally = require('./tally-client');
const erp = require('./erp-client');
const { buildLedgerEnvelope } = require('./ledger-xml');
const { version } = require('../package.json');

// A preview is read-only. --create attempts at most one missing mapped ledger;
// it never pulls vouchers or acknowledges ERP results. Normal sync subsequently
// verifies the ledger's existence before acknowledging its mapping.
async function diagnose({ create = false } = {}, c = config.get()) {
  if (!c.erpUrl || !c.agentToken) throw new Error('Configure the ERP address and pairing token first.');
  const probe = await tally.ping(c);
  if (!probe.companyOpen || probe.error) throw new Error(probe.error || 'Company could not be verified.');
  const existing = new Set(await tally.listLedgerNames(probe.company, c));
  const pending = await erp.ledgersPending(c);
  const ledger = pending.find((entry) => !existing.has(entry.name));
  const result = { agentVersion: version, company: probe.company, pendingCount: pending.length };
  if (!ledger) return { ...result, ok: true, attempted: false, message: 'No missing pending ledger was returned. Check ERP Sync and auto-provision settings if you expected one.' };
  const request = buildLedgerEnvelope(ledger, probe.company);
  Object.assign(result, { ledger: ledger.name, parentGroup: ledger.parentGroup });
  if (!create) return { ...result, ok: true, attempted: false, request, message: 'Preview only. Run with --create to attempt this one ledger.' };
  const response = await tally.postXml(request, c);
  const interpreted = response.status === 200 ? tally.interpret(response.body, 'Create')
    : { ok: false, error: `Tally HTTP ${response.status}` };
  let existsAfter = false, readbackError;
  try { existsAfter = (await tally.listLedgerNames(probe.company, c)).includes(ledger.name); }
  catch (err) { readbackError = err.message; }
  return {
    ...result, attempted: true, ok: interpreted.ok && existsAfter,
    httpStatus: response.status, importConfirmed: interpreted.ok, existsAfter,
    error: interpreted.error || (existsAfter ? null : 'Ledger existence could not be confirmed after import.'),
    readbackError, response: response.body.slice(0, 8000), responseTruncated: response.body.length > 8000,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--create')) {
    console.error('Usage: node src/diagnose-ledger.js [--create]');
    process.exitCode = 1;
  } else {
    diagnose({ create: args.includes('--create') }).then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    }).catch((err) => { console.error(err.message); process.exitCode = 1; });
  }
}

module.exports = { diagnose };
