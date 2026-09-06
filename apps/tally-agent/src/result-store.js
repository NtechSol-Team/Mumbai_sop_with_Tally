'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const filename = () => path.join(path.dirname(config.storePath), 'pending-results.json');
const destination = (c) => ({ erpUrl: c.erpUrl, tallyHost: c.tallyHost, tallyPort: c.tallyPort, company: c.tallyCompany });

function load(c) {
  let journal;
  try { journal = JSON.parse(fs.readFileSync(filename(), 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error('Cannot read pending-results.json. Restore the acknowledgement journal before syncing.');
  }
  if (JSON.stringify(journal.destination) !== JSON.stringify(destination(c))) {
    throw new Error('Unreported Tally results belong to the previous ERP/Tally connection. Restore those agent settings and sync once before changing the destination.');
  }
  if (!Array.isArray(journal.results)) throw new Error('Invalid pending-results.json journal.');
  return journal.results;
}

function save(c, results) {
  const file = filename();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ destination: destination(c), results }), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function clear() {
  try { fs.unlinkSync(filename()); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

module.exports = { load, save, clear };
