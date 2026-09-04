'use strict';

const http = require('node:http');
const config = require('./config');

/**
 * Posts XML to TallyPrime's local HTTP server (default localhost:9000). Plain
 * HTTP because that is all Tally offers; it is a loopback / LAN call and never
 * leaves the client's machine.
 */
function postXml(xml) {
  const c = config.get();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: c.tallyHost,
        port: c.tallyPort,
        method: 'POST',
        path: '',
        headers: { 'Content-Type': 'text/xml;charset=utf-8', 'Content-Length': Buffer.byteLength(xml) },
        timeout: 30_000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Tally did not respond within 30s')));
    req.on('error', reject);
    req.write(xml);
    req.end();
  });
}

/** Is Tally reachable and answering on its HTTP port right now? */
async function ping() {
  try {
    const probe = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC></DESC></BODY></ENVELOPE>';
    const { status } = await postXml(probe);
    return status === 200;
  } catch {
    return false;
  }
}

/**
 * Parse Tally's import response. Tally answers 200 even when it rejects the
 * payload — the outcome is inside the XML, as counts plus an optional
 * <LINEERROR>.
 *
 * Returns the raw counts as well as a verdict, because "nothing changed" means
 * different things for the two callers:
 *   • a VOUCHER that created nothing genuinely did not post — that's a failure;
 *   • a LEDGER that created nothing is almost always one that already exists
 *     (Tally silently ignores a Create for an existing master), which is
 *     exactly what we want — see isNoOp below.
 */
function interpret(body) {
  const num = (tag) => {
    const m = body.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, 'i'));
    return m ? Number(m[1]) : 0;
  };
  const lineError = (body.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i) || [])[1];
  const counts = {
    created: num('CREATED'),
    altered: num('ALTERED'),
    deleted: num('DELETED'),
    ignored: num('IGNORED'),
    errors: num('ERRORS') + num('EXCEPTIONS'),
  };
  const changed = counts.created + counts.altered + counts.deleted;
  const lastVchId = (body.match(/<LASTVCHID>\s*(\d+)\s*<\/LASTVCHID>/i) || [])[1] || null;

  if (lineError) return { ok: false, error: lineError.trim(), counts, raw: body };
  if (counts.errors > 0) return { ok: false, error: `Tally reported ${counts.errors} error(s)`, counts, raw: body };
  if (changed <= 0) {
    return {
      ok: false,
      // Flagged so a ledger "ensure exists" can accept this while a voucher push
      // still treats it as a real failure.
      isNoOp: true,
      error: 'Tally accepted the request but created nothing (the master most likely already exists)',
      counts,
      raw: body,
    };
  }
  return { ok: true, tallyVoucherId: lastVchId, counts, raw: body };
}

async function send(xml) {
  const { status, body } = await postXml(xml);
  if (status !== 200) return { ok: false, error: `Tally HTTP ${status}`, raw: body };
  return interpret(body);
}

module.exports = { postXml, ping, send, interpret };
