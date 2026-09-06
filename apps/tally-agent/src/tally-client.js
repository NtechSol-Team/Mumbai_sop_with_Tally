'use strict';

const http = require('node:http');
const { create } = require('xmlbuilder2');
const config = require('./config');
const { requireCompany, selectCompany } = require('./company');
const { parseXml, elements, responseError, parseCollection, namesFromCollections } = require('./xml-response');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function decodeBody(buffer, contentType = '') {
  // Tally installations can reply in UTF-16 even to a UTF-8 request.
  const bigEndian = /charset\s*=\s*["']?utf-16be/i.test(contentType) ||
    (buffer[0] === 0xfe && buffer[1] === 0xff) || (buffer[0] === 0 && buffer[1] === 0x3c);
  const encoding = bigEndian ? 'utf-16be' : /charset\s*=\s*["']?utf-16/i.test(contentType) ||
    (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0x3c && buffer[1] === 0)
    ? 'utf-16le' : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(buffer);
}

/** One immutable configuration is passed to every request in a sync cycle. */
function postXml(xml, c = config.get()) {
  return new Promise((resolve, reject) => {
    let deadline;
    const fail = (err) => {
      clearTimeout(deadline);
      err.source = 'TALLY';
      reject(err);
    };
    const req = http.request({
      host: c.tallyHost, port: c.tallyPort, method: 'POST', path: '/',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Accept-Charset': 'utf-8',
        'Content-Length': Buffer.byteLength(xml),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('Tally response exceeded 4 MB.'));
        else chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('Tally closed the connection before completing its response.')));
      res.on('end', () => {
        clearTimeout(deadline);
        try { resolve({ status: res.statusCode, body: decodeBody(Buffer.concat(chunks), res.headers['content-type']) }); }
        catch (err) { fail(err); }
      });
    });
    // A wall-clock deadline also covers DNS/connect hangs and slow trickles.
    deadline = setTimeout(() => req.destroy(new Error('Tally did not respond within 30s')), 30_000);
    req.on('error', fail);
    req.end(xml);
  });
}

function collectionXml(id, type, company) {
  return create({ ENVELOPE: {
    HEADER: { VERSION: '1', TALLYREQUEST: 'Export', TYPE: 'Collection', ID: id },
    BODY: { DESC: {
      STATICVARIABLES: {
        ...(company === undefined ? {} : { SVCURRENTCOMPANY: requireCompany(company) }),
        SVEXPORTFORMAT: '$$SysName:XML',
      },
      TDL: { TDLMESSAGE: { COLLECTION: { '@NAME': id, '@ISMODIFY': 'No', TYPE: type, NATIVEMETHOD: 'NAME' } } },
    } },
  } }).end({ prettyPrint: false });
}

const OPEN_COMPANIES_XML = collectionXml('MEACompanies', 'Company');
const isCompanyContextError = (message) => /SVCurrentCompany|current company|no company.*(?:loaded|open|selected)/i.test(message || '');

async function discoverCompanies(c = config.get()) {
  let raw;
  try {
    const result = await postXml(OPEN_COMPANIES_XML, c);
    raw = result.body;
    if (result.status !== 200) throw new Error(`Tally HTTP ${result.status}`);
    return { reachable: true, openCompanies: namesFromCollections(parseCollection(raw), 'COMPANY'), error: null };
  } catch (err) {
    return { reachable: raw !== undefined, openCompanies: null, error: describeNetworkError(err, c), raw };
  }
}

async function listOpenCompanies(c = config.get()) {
  return (await discoverCompanies(c)).openCompanies;
}

async function ping(c = config.get()) {
  const discovery = await discoverCompanies(c);
  const result = { ...discovery, requestedCompany: c.tallyCompany, company: null, companyOpen: false, exactMatch: false };
  if (discovery.error) return { ...result, code: 'DISCOVERY_FAILED' };
  const selection = selectCompany(c.tallyCompany, discovery.openCompanies);
  if (selection.error) return { ...result, ...selection };
  try {
    const response = await postXml(collectionXml('MEAPingCur', 'Currency', selection.company), c);
    if (response.status !== 200) throw new Error(`Tally HTTP ${response.status}`);
    // Membership AND a valid, error-free scoped response are required. No fallback
    // to the list when the scoped probe fails, and no HTTP-200-only success.
    parseCollection(response.body);
    return { ...result, company: selection.company, companyOpen: true, exactMatch: true, code: null, error: null };
  } catch (err) {
    return { ...result, code: 'COMPANY_PROBE_FAILED', error: `Could not verify ${JSON.stringify(selection.company)}: ${describeNetworkError(err, c)}` };
  }
}

async function listLedgerNames(company, c = config.get()) {
  const response = await postXml(collectionXml('MEALedgers', 'Ledger', company), c);
  if (response.status !== 200) throw new Error(`Tally HTTP ${response.status}`);
  return namesFromCollections(parseCollection(response.body), 'LEDGER');
}

function describeNetworkError(err, c) {
  const code = err && (err.code || err.errors?.[0]?.code);
  if (code === 'ECONNREFUSED') return `Nothing is listening on ${c.tallyHost}:${c.tallyPort}. Open TallyPrime and enable its HTTP server (F1 → Settings → Connectivity).`;
  if (code === 'ETIMEDOUT' || /did not respond/.test(err?.message)) return `Tally at ${c.tallyHost}:${c.tallyPort} did not respond. Check connectivity and leave Tally at the Gateway screen.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Cannot resolve Tally host ${JSON.stringify(c.tallyHost)}. Use localhost or the Tally PC's LAN IP.`;
  return err?.message || String(err);
}

/** HTTP 200 is transport success only. Verify XML status and operation counts. */
function interpret(body, action) {
  let root;
  try { root = parseXml(body); }
  catch (err) { return { ok: false, error: err.message, raw: body }; }
  const error = responseError(root);
  if (error) return { ok: false, error, contextError: isCompanyContextError(error), raw: body };
  const counts = {};
  let hasCounts = false;
  for (const tag of ['CREATED', 'ALTERED', 'DELETED', 'IGNORED', 'ERRORS', 'EXCEPTIONS', 'CANCELLED']) {
    const nodes = elements(root, tag);
    if (nodes.length > 1 || (nodes.length && !/^\d+$/.test(nodes[0].text.trim()))) {
      return { ok: false, error: `Invalid ${tag} count in Tally response.`, raw: body };
    }
    if (nodes.length) hasCounts = true;
    counts[tag.toLowerCase()] = nodes.length ? Number(nodes[0].text.trim()) : 0;
    if (!Number.isSafeInteger(counts[tag.toLowerCase()])) return { ok: false, error: `Invalid ${tag} count in Tally response.`, raw: body };
  }
  if (!hasCounts || !elements(root, 'ERRORS').length ||
      !['CREATED', 'ALTERED', 'DELETED'].some((tag) => elements(root, tag).length)) {
    return { ok: false, error: 'Tally returned no complete import result. No change has been confirmed.', raw: body };
  }
  const changed = counts.created + counts.altered + counts.deleted + counts.cancelled;
  if (!changed) {
    return { ok: false, isNoOp: true, error: 'Tally reported no changes. Verify whether the requested object exists.', counts, raw: body };
  }
  const expected = action === 'Delete' ? counts.deleted : action === 'Cancel' ? counts.cancelled
    : action === 'Create' || action === 'Alter' ? counts.created + counts.altered : changed;
  if (!expected) return { ok: false, error: `Tally did not confirm the requested ${action} operation.`, counts, raw: body };
  const id = elements(root, 'LASTVCHID')[0]?.text.trim();
  return { ok: true, tallyVoucherId: id && /^[1-9]\d*$/.test(id) ? id : null, counts, raw: body };
}

async function send(xml, c = config.get(), action) {
  const { status, body } = await postXml(xml, c);
  if (status !== 200) return { ok: false, error: `Tally HTTP ${status}`, raw: body };
  return interpret(body, action);
}

module.exports = { postXml, ping, send, interpret, discoverCompanies, listOpenCompanies, listLedgerNames,
  collectionXml, decodeBody, isCompanyContextError, describeNetworkError };
