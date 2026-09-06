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

// A collection scoped to <TYPE>Company</TYPE> iterates the companies TallyPrime
// has LOADED IN MEMORY — not the ones sitting on disk. That distinction is the
// whole game here: a company can exist and still not be selected, and only a
// selected company can receive a voucher.
const OPEN_COMPANIES_XML =
  '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MEACompanies</ID></HEADER>' +
  '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>' +
  '<TDL><TDLMESSAGE><COLLECTION NAME="MEACompanies" ISMODIFY="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">' +
  '<TYPE>Company</TYPE><NATIVEMETHOD>NAME</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL>' +
  '</DESC></BODY></ENVELOPE>';

/** Parse company names out of a Tally response, whatever shape it used. */
function parseCompanyNames(body) {
  const names = new Set();
  for (const m of body.matchAll(/<NAME>([\s\S]*?)<\/NAME>/gi)) if (m[1].trim()) names.add(m[1].trim());
  for (const m of body.matchAll(/<COMPANY\b[^>]*\bNAME\s*=\s*"([^"]+)"/gi)) if (m[1].trim()) names.add(m[1].trim());
  for (const m of body.matchAll(/<COMPANYNAME>([\s\S]*?)<\/COMPANYNAME>/gi)) if (m[1].trim()) names.add(m[1].trim());
  return [...names];
}

const isCompanyContextError = (body) =>
  /could not set[\s\S]{0,12}SVCurrentCompany/i.test(body) ||
  /no company[\s\S]{0,20}(loaded|open|selected)/i.test(body);

/**
 * The companies TallyPrime currently has open, exactly as Tally spells them.
 * null (not []) if the probe itself failed — callers must tell "none open"
 * apart from "couldn't ask".
 */
async function listOpenCompanies() {
  try {
    const { status, body } = await postXml(OPEN_COMPANIES_XML);
    if (status !== 200) return null;
    return parseCompanyNames(body);
  } catch {
    return null;
  }
}

/**
 * Is Tally reachable AND is the company we're supposed to post into actually
 * open under exactly the configured name?
 *
 * A green "reachable" light next to a company that isn't loaded is how every
 * voucher fails identically with "Could not set SVCurrentCompany". So this does
 * two things Tally itself doesn't make easy:
 *   1. lists the LOADED companies (a <TYPE>Company</TYPE> collection), and
 *   2. positively confirms the target by sending one scoped request AS that
 *      company and checking Tally doesn't reject the context.
 */
async function ping() {
  const c = config.get();
  const wanted = (c.tallyCompany || '').trim();
  try {
    const { status, body } = await postXml(OPEN_COMPANIES_XML);
    if (status !== 200) return { reachable: false, companyOpen: false, error: `Tally HTTP ${status}` };

    const openCompanies = parseCompanyNames(body);

    if (!wanted) {
      return {
        reachable: true, companyOpen: false, openCompanies,
        error: 'No Tally company name set — configure TALLY_COMPANY so vouchers cannot land in the wrong company.',
      };
    }

    // Positive confirmation: ask Tally for something trivial *as* this company.
    // If the company isn't loaded (or the name is off), Tally answers with the
    // very "Could not set SVCurrentCompany" error we're trying to pre-empt.
    const scoped =
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MEAPingCur</ID></HEADER>' +
      '<BODY><DESC><STATICVARIABLES>' +
      `<SVCURRENTCOMPANY>${wanted.replace(/[<&>]/g, ' ')}</SVCURRENTCOMPANY>` +
      '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>' +
      '<TDL><TDLMESSAGE><COLLECTION NAME="MEAPingCur" ISMODIFY="No"><TYPE>Currency</TYPE></COLLECTION></TDLMESSAGE></TDL>' +
      '</DESC></BODY></ENVELOPE>';
    let confirmed = false;
    let contextRejected = false;
    try {
      const r = await postXml(scoped);
      if (r.status === 200) {
        contextRejected = isCompanyContextError(r.body);
        confirmed = !contextRejected;
      }
    } catch { /* fall back to the list match below */ }

    const exactInList = openCompanies.some((n) => n === wanted);
    const looseInList = openCompanies.find((n) => n.toLowerCase() === wanted.toLowerCase());
    // Confirmed means Tally accepted SVCURRENTCOMPANY=<wanted> verbatim — nothing
    // else to check. Otherwise fall back to an exact hit in the loaded list.
    const companyOpen = confirmed || (!contextRejected && exactInList);

    let error = null;
    if (!companyOpen) {
      const list = openCompanies.length ? `open now: ${openCompanies.map((n) => `"${n}"`).join(', ')}` : 'no company is open';
      error = looseInList && looseInList !== wanted
        ? `Tally has "${looseInList}" open, but TALLY_COMPANY is "${wanted}". They must match exactly — case and spaces included. Set it to "${looseInList}".`
        : `"${wanted}" is not open in Tally — ${list}. In Tally: press F3 (Company) - Select Company, pick it, then sit at the Gateway of Tally screen.`;
    }

    return { reachable: true, companyOpen, exactMatch: companyOpen, openCompanies, error };
  } catch (err) {
    return { reachable: false, companyOpen: false, error: describeNetworkError(err, c) };
  }
}

/** A connection failure the operator can act on, not a raw Node error name. */
function describeNetworkError(err, c) {
  const code = err && (err.code || (Array.isArray(err.errors) && err.errors[0] && err.errors[0].code));
  if (code === 'ECONNREFUSED' || err instanceof AggregateError) {
    return `Nothing is listening on ${c.tallyHost}:${c.tallyPort}. Open TallyPrime, load the company, and turn on its HTTP server (F1 - Settings - Connectivity - "TallyPrime acts as": Both).`;
  }
  if (code === 'ETIMEDOUT' || /did not respond/.test(err && err.message)) {
    return `Tally at ${c.tallyHost}:${c.tallyPort} did not respond. It may be busy in a dialog — leave it at the Gateway of Tally screen.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Cannot resolve the Tally host "${c.tallyHost}". Use "localhost" if the agent runs on the Tally PC, or the Tally PC's LAN IP.`;
  }
  return (err && err.message) || String(err);
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
/** Tally XML entities + stray tags/control chars -> a plain readable string. */
function tidy(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The best error text Tally gave us. <LINEERROR> is the usual place; failing
 * that, voucher rejections land in <DESC> / <ERRMSG>, and a malformed request
 * comes back as a plain-text page with no tags at all. The looser sources are
 * only consulted once we already know this response failed.
 */
function extractErrors(body, opts) {
  const failed = opts && opts.failed;
  const collect = (re) => {
    const out = [];
    for (const m of body.matchAll(re)) {
      const t = tidy(m[1]);
      if (t && t.length > 1 && !out.includes(t)) out.push(t);
    }
    return out;
  };
  let msgs = collect(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi);
  if (!msgs.length && failed) msgs = collect(/<(?:DESC|ERRMSG)>([\s\S]*?)<\/(?:DESC|ERRMSG)>/gi);
  if (!msgs.length && failed && !/<ENVELOPE|<RESPONSE/i.test(body)) {
    const t = tidy(body).slice(0, 300);
    if (t) msgs = [t];
  }
  return msgs;
}

function interpret(body) {
  const num = (tag) => {
    const m = body.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, 'i'));
    return m ? Number(m[1]) : 0;
  };
  const counts = {
    created: num('CREATED'),
    altered: num('ALTERED'),
    deleted: num('DELETED'),
    ignored: num('IGNORED'),
    errors: num('ERRORS') + num('EXCEPTIONS'),
  };
  const changed = counts.created + counts.altered + counts.deleted;
  const lastVchId = (body.match(/<LASTVCHID>\s*(\d+)\s*<\/LASTVCHID>/i) || [])[1] || null;
  const messages = extractErrors(body, { failed: counts.errors > 0 || changed <= 0 });

  if (messages.length) return { ok: false, error: messages.join(' | '), counts, raw: body };
  if (counts.errors > 0) {
    return {
      ok: false,
      error: `Tally reported ${counts.errors} error(s) but gave no message. Open "Tally's reply" below for the raw response — usually a ledger name, a GST detail, or voucher totals that don't match.`,
      counts,
      raw: body,
    };
  }
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

module.exports = { postXml, ping, send, interpret, listOpenCompanies };
