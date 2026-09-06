'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectCompany } = require('../src/company');
const { parseXml, parseCollection, namesFromCollections } = require('../src/xml-response');
const tally = require('../src/tally-client');
const { buildEnvelope, messagesFor } = require('../src/xml');
const { buildLedgerEnvelope } = require('../src/ledger-xml');
const { collection, importReply, item, server } = require('./helpers');

for (const [label, requested, open, code, company] of [
  ['exact with multiple open', 'Nakrani LLP', ['Food Compnay', 'Nakrani LLP'], null, 'Nakrani LLP'],
  ['typo with multiple open', 'Food Company', ['Food Compnay', 'Nakrani LLP'], 'COMPANY_NOT_OPEN', null],
  ['typo with only one open', 'Food Company', ['Food Compnay'], 'COMPANY_NOT_OPEN', null],
  ['unconfigured with one open', '', ['Nakrani LLP'], 'COMPANY_REQUIRED', null],
  ['unconfigured with multiple open', '', ['A', 'B'], 'COMPANY_REQUIRED', null],
  ['no company open', 'A', [], 'NO_COMPANY_OPEN', null],
  ['unrequested company only', 'B', ['A'], 'COMPANY_NOT_OPEN', null],
  ['case difference', 'food company', ['Food Company'], 'COMPANY_NAME_MISMATCH', null],
  ['space difference', 'Food Company', ['Food  Company'], 'COMPANY_NAME_MISMATCH', null],
  ['ambiguous normalisation', 'food company', ['Food Company', 'FOOD COMPANY'], 'COMPANY_NAME_MISMATCH', null],
  ['exact whitespace preserved', ' A  & B ', [' A  & B '], null, ' A  & B '],
]) test(`selection: ${label}`, () => {
  const result = selectCompany(requested, open);
  assert.equal(result.code, code); assert.equal(result.company, company);
  if (code && open.length) open.forEach((name) => assert.ok(result.error.includes(JSON.stringify(name))));
});

test('parses names as XML, retaining entities, Unicode, CDATA, quotes and spaces', () => {
  const xml = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME=' A &amp; B '><NAME>alias must not be selected</NAME></COMPANY>
  <COMPANY><NAME><![CDATA[Food <Company>]]></NAME></COMPANY>
  <COMPANY><NAME>O&apos;Brien &#38; &#x1F34E; मुंबई</NAME></COMPANY>
  <LEDGER NAME="unrelated"><NAME>not a company</NAME></LEDGER>
  </COLLECTION></DATA></BODY></ENVELOPE>`;
  assert.deepEqual(namesFromCollections(parseCollection(xml), 'COMPANY'), [' A & B ', 'Food <Company>', "O'Brien & 🍎 मुंबई"]);
});

for (const body of ['', 'Tally is running', '<RESPONSE/>', '<ENVELOPE>', '<ENVELOPE></RESPONSE>', '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER><BODY><DATA><COLLECTION/></DATA></BODY></ENVELOPE>', '<RESPONSE><LINEERROR>Access denied</LINEERROR></RESPONSE>']) {
  test(`discovery rejects failed/unknown body ${JSON.stringify(body).slice(0, 55)}`, () => assert.throws(() => parseCollection(body)));
}

test('empty verified collection means no companies, not discovery failure', () => {
  assert.deepEqual(namesFromCollections(parseCollection(collection('COMPANY', [])), 'COMPANY'), []);
});

test('identically named company objects remain ambiguous, not silently deduplicated', () => {
  const names = namesFromCollections(parseCollection(collection('COMPANY', ['Same', 'Same'])), 'COMPANY');
  assert.equal(names.length, 2);
  assert.equal(selectCompany('Same', names).code, 'COMPANY_AMBIGUOUS');
});

test('all company-scoped XML builders preserve identical exact company text', () => {
  const name = '  A & B <Foods> "मुंबई"  ';
  const p = item().payload;
  const requests = [tally.collectionXml('Probe', 'Currency', name), buildEnvelope(p, name, 'Create'), buildLedgerEnvelope({name:'Cash', parentGroup:'Cash-in-Hand'}, name)];
  const { elements } = require('../src/xml-response');
  for (const xml of requests) assert.equal(elements(parseXml(xml), 'SVCURRENTCOMPANY')[0].text, name);
  assert.throws(() => buildEnvelope(p, '', 'Create'), /Select a Tally company/);
  assert.throws(() => buildLedgerEnvelope({name:'A'}, ' '), /Select a Tally company/);
});

test('ping will not send a scoped request for the mismatched company', async (t) => {
  const s = await server(t, (_req, res) => res.end(collection('COMPANY', ['Food Compnay', 'Nakrani LLP'])));
  const result = await tally.ping({ tallyHost:'127.0.0.1', tallyPort:s.port, tallyCompany:'Food Company' });
  assert.equal(result.companyOpen, false); assert.equal(result.code, 'COMPANY_NOT_OPEN'); assert.equal(s.requests.length, 1);
  assert.ok(!s.requests[0].body.includes('SVCURRENTCOMPANY'));
});

test('ping validates the selected second company, not the first company', async (t) => {
  const s = await server(t, (_req, res, xml) => res.end(collection(xml.includes('MEACompanies') ? 'COMPANY' : 'CURRENCY', xml.includes('MEACompanies') ? ['A', 'B & Co'] : [])));
  const result = await tally.ping({tallyHost:'127.0.0.1', tallyPort:s.port, tallyCompany:'B & Co'});
  assert.equal(result.company, 'B & Co'); assert.equal(result.companyOpen, true);
  assert.ok(s.requests[1].body.includes('<SVCURRENTCOMPANY>B &amp; Co</SVCURRENTCOMPANY>'));
});

for (const body of ['<RESPONSE/>', '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER></ENVELOPE>', '<RESPONSE><LINEERROR>Could not set &apos;SVCurrentCompany&apos;</LINEERROR></RESPONSE>']) test('scoped probe fails closed: '+body.slice(0,50), async (t) => {
  const s = await server(t, (_req, res, xml) => res.end(xml.includes('MEACompanies') ? collection('COMPANY', ['A']) : body));
  const result = await tally.ping({tallyHost:'127.0.0.1', tallyPort:s.port, tallyCompany:'A'});
  assert.equal(result.companyOpen, false); assert.equal(result.company, null);
});

test('UTF-16 Tally responses decode without losing exact names', async (t) => {
  const xml = collection('COMPANY', ['मुंबई & Co']);
  const s = await server(t, (_req, res) => { res.setHeader('Content-Type', 'text/xml; charset=utf-16'); res.end(Buffer.from('\ufeff'+xml, 'utf16le')); });
  assert.deepEqual((await tally.discoverCompanies({tallyHost:'127.0.0.1', tallyPort:s.port})).openCompanies, ['मुंबई & Co']);
});

test('truncated HTTP responses reject instead of hanging', async (t) => {
  const s = await server(t, (_req, res) => { res.writeHead(200, {'Content-Length':'10000'}); res.write('<RESPONSE>'); setImmediate(() => res.destroy()); });
  await assert.rejects(tally.postXml('<ENVELOPE/>', {tallyHost:'127.0.0.1', tallyPort:s.port}));
});

for (const body of ['', '<RESPONSE/>', '<RESPONSE><CREATED>1</CREATED>', '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER></ENVELOPE>', '<html>ok</html>', '<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS><LINEERROR>Rejected</LINEERROR></RESPONSE>']) test('import never accepts unknown/error response: '+body.slice(0,45), () => {
  const r = tally.interpret(body, 'Create'); assert.equal(r.ok, false); assert.ok(!r.isNoOp);
});

test('operation-aware counts and explicit no-op', () => {
  assert.equal(tally.interpret(importReply({CREATED:1,LASTVCHID:42}), 'Create').tallyVoucherId, '42');
  assert.equal(tally.interpret(importReply({DELETED:1}), 'Create').ok, false);
  assert.equal(tally.interpret(importReply({DELETED:1}), 'Delete').ok, true);
  assert.equal(tally.interpret(importReply(), 'Delete').isNoOp, true);
  assert.equal(tally.interpret(importReply({ERRORS:1}), 'Create').isNoOp, undefined);
});

test('ledger creation uses the documented native Import Data format and direct master name', () => {
  // https://help.tallysolutions.com/sample-xml/ — Accounting Masters / Ledger.
  const { elements } = require('../src/xml-response');
  const root = parseXml(buildLedgerEnvelope({ name: 'Sales & Food', parentGroup: 'Sales Accounts' }, ' A & B '));
  const header = elements(root, 'HEADER')[0];
  assert.deepEqual(header.children.map((n) => [n.name, n.text]), [['TALLYREQUEST', 'Import Data']]);
  assert.equal(elements(root, 'REPORTNAME')[0].text, 'All Masters');
  const ledger = elements(root, 'LEDGER')[0];
  assert.equal(ledger.children.find((n) => n.name === 'NAME').text, 'Sales & Food');
  assert.equal(elements(root, 'SVCURRENTCOMPANY')[0].text, ' A & B ');
});

for (const raw of ['Unknown request, cannot be processed', '<RESPONSE>Unknown Request, cannot be processed</RESPONSE>']) {
  test('generic request rejection retains the real error: ' + raw, () => {
    const result = tally.interpret(raw, 'Create');
    assert.equal(result.ok, false); assert.equal(result.requestRejected, true);
    assert.equal(result.raw, raw); assert.match(result.error, /Unknown request, cannot be processed/);
    assert.ok(!result.isNoOp);
  });
}

test('incomplete import diagnostics retain the response content', () => {
  const raw = '<RESPONSE><DESCRIPTION>Custom import reply</DESCRIPTION></RESPONSE>';
  const result = tally.interpret(raw, 'Create');
  assert.equal(result.ok, false); assert.match(result.error, /Custom import reply/);
});

test('unsupported contracts and invalid amounts cannot reach XML posting', () => {
  const p = item(); p.payload.contractVersion = 2;
  assert.throws(() => messagesFor(p, 'A'), /Unsupported/);
  p.payload.contractVersion=1; p.payload.lines[0].amount = NaN;
  assert.throws(() => messagesFor(p, 'A'), /amount/);
  p.payload.lines[0].amount = 50;
  assert.throws(() => messagesFor(p, 'A'), /balance/);
});
