'use strict';

const Store = require('electron-store');

/**
 * Local, per-machine configuration. Lives in
 * %APPDATA%/Mumbai ERP Tally Sync Agent/config.json on Windows.
 */
const store = new Store({
  name: 'config',
  defaults: {
    erpUrl: '',          // e.g. https://api.your-mumbai-erp-domain.com
    agentToken: '',      // the pairing token from Settings → Tally Sync
    tallyHost: 'localhost',
    tallyPort: 9000,
    tallyCompany: '',    // SVCURRENTCOMPANY — exactly as it reads in Tally
    pollSeconds: 20,
    label: 'Tally PC',
  },
});

function get() {
  return {
    erpUrl: String(store.get('erpUrl') || '').replace(/\/+$/, ''),
    agentToken: String(store.get('agentToken') || ''),
    tallyHost: String(store.get('tallyHost') || 'localhost'),
    tallyPort: Number(store.get('tallyPort') || 9000),
    tallyCompany: String(store.get('tallyCompany') || ''),
    pollSeconds: Math.max(5, Number(store.get('pollSeconds') || 20)),
    label: String(store.get('label') || 'Tally PC'),
  };
}

function set(partial) {
  for (const [k, v] of Object.entries(partial)) store.set(k, v);
  return get();
}

function isConfigured() {
  const c = get();
  return Boolean(c.erpUrl && c.agentToken);
}

module.exports = { get, set, isConfigured, _store: store };
