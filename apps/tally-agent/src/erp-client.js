'use strict';

const config = require('./config');

/**
 * Talks to Mumbai ERP over HTTPS — OUTBOUND ONLY. The agent never listens on a
 * port. All three endpoints are under /api/v1/tally/agent/* and accept only the
 * agent bearer token (they cannot reach anything else in the ERP).
 */

async function call(path, { method = 'GET', body } = {}) {
  const c = config.get();
  if (!c.erpUrl || !c.agentToken) throw new Error('Agent is not paired yet — open Settings.');
  const res = await fetch(`${c.erpUrl}/api/v1/tally/agent${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.agentToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok || json.success === false) {
    const msg = json?.error?.message || `ERP responded ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

const heartbeat = () =>
  call('/heartbeat', { method: 'POST', body: { label: config.get().label, tallyCompanyName: config.get().tallyCompany || undefined } });

const pullPending = (limit = 25) =>
  call(`/pending?limit=${limit}`).then((d) => d.vouchers || []);

const reportResults = (results) =>
  call('/results', { method: 'POST', body: { results } });

module.exports = { heartbeat, pullPending, reportResults };
