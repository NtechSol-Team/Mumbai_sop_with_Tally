'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Local config as a plain JSON file — no electron-store, so the sync loop also
 * runs headless (see run-headless.js) for testing without the tray.
 *
 * Path:
 *   • inside Electron → <userData>/config.json  (set via setStorePath from main.js)
 *   • headless        → $MUMBAI_ERP_TALLY_CONFIG, else ~/.mumbai-erp-tally-agent/config.json
 *
 * Env vars override the file for a given run (handy for a quick test):
 *   MUMBAI_ERP_URL  MUMBAI_ERP_TOKEN  TALLY_HOST  TALLY_PORT  TALLY_COMPANY  POLL_SECONDS  AGENT_LABEL
 */

const DEFAULTS = {
  erpUrl: '',
  agentToken: '',
  tallyHost: 'localhost',
  tallyPort: 9000,
  tallyCompany: '',
  pollSeconds: 20,
  label: 'Tally PC',
};

let storePath =
  process.env.MUMBAI_ERP_TALLY_CONFIG ||
  path.join(os.homedir(), '.mumbai-erp-tally-agent', 'config.json');

function setStorePath(p) {
  storePath = p;
}

function readFile() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(storePath, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function get() {
  const f = readFile();
  const env = process.env;
  return {
    erpUrl: String(env.MUMBAI_ERP_URL || f.erpUrl || '').replace(/\/+$/, ''),
    agentToken: String(env.MUMBAI_ERP_TOKEN || f.agentToken || ''),
    tallyHost: String(env.TALLY_HOST || f.tallyHost || 'localhost'),
    tallyPort: Number(env.TALLY_PORT || f.tallyPort || 9000),
    tallyCompany: String(env.TALLY_COMPANY || f.tallyCompany || ''),
    pollSeconds: Math.max(5, Number(env.POLL_SECONDS || f.pollSeconds || 20)),
    label: String(env.AGENT_LABEL || f.label || 'Tally PC'),
  };
}

function set(partial) {
  const merged = { ...readFile(), ...partial };
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(merged, null, 2));
  return get();
}

function isConfigured() {
  const c = get();
  return Boolean(c.erpUrl && c.agentToken);
}

module.exports = { get, set, isConfigured, setStorePath, get storePath() { return storePath; } };
