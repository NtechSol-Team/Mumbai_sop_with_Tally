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
 * Parse Tally's import response. Tally returns 200 even for a rejected voucher,
 * with the failure inside the XML — so success is CREATED/ALTERED > 0 AND no
 * LINEERROR / EXCEPTIONS.
 */
function interpret(body) {
  const num = (tag) => {
    const m = body.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, 'i'));
    return m ? Number(m[1]) : 0;
  };
  const lineError = (body.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i) || [])[1];
  const errorsCount = num('ERRORS') + num('EXCEPTIONS');
  const changed = num('CREATED') + num('ALTERED') + num('DELETED');
  const lastVchId = (body.match(/<LASTVCHID>\s*(\d+)\s*<\/LASTVCHID>/i) || [])[1] || null;

  if (lineError) return { ok: false, error: lineError.trim(), raw: body };
  if (errorsCount > 0) return { ok: false, error: `Tally reported ${errorsCount} error(s)`, raw: body };
  if (changed <= 0) return { ok: false, error: 'Tally accepted the request but created nothing', raw: body };
  return { ok: true, tallyVoucherId: lastVchId, raw: body };
}

async function send(xml) {
  const { status, body } = await postXml(xml);
  if (status !== 200) return { ok: false, error: `Tally HTTP ${status}`, raw: body };
  return interpret(body);
}

module.exports = { postXml, ping, send, interpret };
