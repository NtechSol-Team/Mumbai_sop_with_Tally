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
    const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!saved || Array.isArray(saved) || typeof saved !== 'object') throw new Error('Expected a JSON object');
    return { ...DEFAULTS, ...saved };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS };
    throw new Error(`Cannot read agent configuration at ${storePath}. Check that it is valid JSON and readable.`);
  }
}

function get() {
  const f = readFile();
  const env = process.env;
  const c = {
    erpUrl: String(env.MUMBAI_ERP_URL ?? f.erpUrl ?? '').replace(/\/+$/, ''),
    agentToken: String(env.MUMBAI_ERP_TOKEN ?? f.agentToken ?? ''),
    tallyHost: String(env.TALLY_HOST ?? f.tallyHost ?? 'localhost'),
    tallyPort: Number(env.TALLY_PORT ?? f.tallyPort ?? 9000),
    tallyCompany: String(env.TALLY_COMPANY ?? f.tallyCompany ?? ''),
    pollSeconds: Number(env.POLL_SECONDS ?? f.pollSeconds ?? 20),
    label: String(env.AGENT_LABEL ?? f.label ?? 'Tally PC'),
  };
  validate(c);
  return Object.freeze(c);
}

function validate(c) {
  if (!Number.isInteger(c.tallyPort) || c.tallyPort < 1 || c.tallyPort > 65535) throw new Error('Tally port must be an integer from 1 to 65535.');
  if (!Number.isFinite(c.pollSeconds) || c.pollSeconds < 5 || c.pollSeconds > 3600) throw new Error('Poll interval must be from 5 to 3600 seconds.');
  if (!c.tallyHost || /[\s/]/u.test(c.tallyHost)) throw new Error('Tally host must be a hostname or IP address, without a URL scheme or path.');
  if (typeof c.tallyCompany !== 'string' || c.tallyCompany.length > 120 || /[\x00-\x1f\x7f]/u.test(c.tallyCompany)) throw new Error('Tally company must be at most 120 characters with no control characters.');
  if (typeof c.label !== 'string' || c.label.length > 80) throw new Error('Agent label must be at most 80 characters.');
  if (c.erpUrl) {
    let url;
    try { url = new URL(c.erpUrl); } catch { throw new Error('ERP address must be an http:// or https:// URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw new Error('ERP address must be the http:// or https:// API origin, without credentials, a path, or query parameters.');
    }
  }
}

function set(partial) {
  const allowed = Object.fromEntries(Object.entries(partial).filter(([key]) => Object.hasOwn(DEFAULTS, key)));
  const envKeys = { erpUrl: 'MUMBAI_ERP_URL', agentToken: 'MUMBAI_ERP_TOKEN', tallyHost: 'TALLY_HOST', tallyPort: 'TALLY_PORT', tallyCompany: 'TALLY_COMPANY', pollSeconds: 'POLL_SECONDS', label: 'AGENT_LABEL' };
  for (const [key, value] of Object.entries(allowed)) {
    if (process.env[envKeys[key]] !== undefined && String(value) !== String(get()[key])) {
      throw new Error(`${key} is overridden by ${envKeys[key]}. Change that environment variable in the launcher and restart the agent.`);
    }
  }
  const merged = { ...readFile(), ...allowed };
  validate(merged);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(merged, null, 2));
  return get();
}

function isConfigured() {
  const c = get();
  return Boolean(c.erpUrl && c.agentToken);
}

module.exports = { get, set, validate, isConfigured, setStorePath, get storePath() { return storePath; },
  companySource: () => process.env.TALLY_COMPANY !== undefined ? 'environment variable TALLY_COMPANY' : storePath };
