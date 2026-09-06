'use strict';

const config = require('./config');

/**
 * Talks to Mumbai ERP over HTTPS — OUTBOUND ONLY. The agent never listens on a
 * port. All three endpoints are under /api/v1/tally/agent/* and accept only the
 * agent bearer token (they cannot reach anything else in the ERP).
 */

async function call(path, { method = 'GET', body } = {}, c = config.get()) {
  try {
    if (!c.erpUrl || !c.agentToken) throw new Error('Agent is not paired yet — open Settings.');
    const res = await fetch(`${c.erpUrl}/api/v1/tally/agent${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${c.agentToken}`,
        'X-Tally-Agent-Protocol': '2',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`ERP returned an invalid JSON response (HTTP ${res.status}). Check the API address.`); }
    if (!res.ok || json.success === false) {
      const msg = json?.error?.message || `ERP responded ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    if (json.success !== true || !json.data || typeof json.data !== 'object') throw new Error('ERP response is missing its success/data envelope.');
    return json.data;
  } catch (err) {
    // AbortSignal.timeout rejects with a DOMException whose message is a
    // getter. Wrap the failure instead of mutating that read-only exception.
    const failure = new Error(err?.name === 'TimeoutError'
      ? 'ERP did not respond within 30s.' : err?.message || String(err), { cause: err });
    failure.source = 'ERP';
    if (Number.isInteger(err?.status)) failure.status = err.status;
    throw failure;
  }
}

const heartbeat = (c = config.get()) =>
  call('/heartbeat', { method: 'POST', body: { label: c.label, tallyCompanyName: c.tallyCompany, tallyHost: c.tallyHost, tallyPort: c.tallyPort } }, c);

const pullPending = (limit = 25, c = config.get()) =>
  call(`/pending?limit=${limit}`, {}, c).then((d) => {
    if (!Array.isArray(d.vouchers)) throw Object.assign(new Error('ERP response has no vouchers array.'), { source: 'ERP' });
    return d.vouchers;
  });

const reportResults = (results, c = config.get()) =>
  call('/results', { method: 'POST', body: { results } }, c);

const ledgersPending = (c = config.get()) => call('/ledgers-pending', {}, c).then((d) => {
  if (!Array.isArray(d.ledgers)) throw Object.assign(new Error('ERP response has no ledgers array.'), { source: 'ERP' });
  return d.ledgers;
});

const reportLedgerResults = (results, c = config.get()) =>
  call('/ledgers-result', { method: 'POST', body: { results } }, c);

module.exports = { heartbeat, pullPending, reportResults, ledgersPending, reportLedgerResults };
