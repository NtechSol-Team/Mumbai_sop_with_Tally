'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const loop = require('../src/sync-loop');
const tally = require('../src/tally-client');
const erp = require('../src/erp-client');
const journal = require('../src/result-store');
const { server, collection, importReply, item } = require('./helpers');
const { parseXml, elements } = require('../src/xml-response');

async function setup(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-sync-test-'));
  config.setStorePath(path.join(folder, 'config.json'));
  t.after(() => { loop.stop(); fs.rmSync(folder, {recursive:true,force:true}); });
  const reports = [], ledgerReports = [], imports = [];
  let acked = false, rejectReports = options.rejectReports || false;
  const tallyServer = await server(t, (_req, res, xml) => {
    if (xml.includes('<TALLYREQUEST>Import Data</TALLYREQUEST>')) {
      imports.push(xml);
      return options.onImport ? options.onImport(res, xml, imports) : res.end(importReply({ CREATED:1, LASTVCHID:123 }));
    }
    if (xml.includes('MEACompanies')) return res.end(collection('COMPANY', options.open || ['A & Co', 'Other Company']));
    if (xml.includes('MEALedgers')) return res.end(collection('LEDGER', options.existing || []));
    options.onProbe?.();
    res.end(collection('CURRENCY', []));
  });
  const apiServer = await server(t, (req, res, body) => {
    assert.equal(req.headers['x-tally-agent-protocol'], '2');
    res.setHeader('Content-Type','application/json');
    const ok = (data) => res.end(JSON.stringify({ success:true, data }));
    if (req.url.endsWith('/heartbeat')) {
      if(options.unauthorised) {res.statusCode=401; return res.end(JSON.stringify({success:false,error:{message:'Invalid agent token'}}));}
      return ok({ok:true,protocolVersion:2,syncEnabled:options.enabled !== false});
    }
    if (req.url.endsWith('/ledgers-pending')) return ok({ledgers:options.ledgers || []});
    if (req.url.endsWith('/ledgers-result')) {ledgerReports.push(...JSON.parse(body).results); return ok({created:1,failed:0});}
    if (req.url.includes('/pending?')) return ok({vouchers:acked ? [] : options.items || [item()]});
    if (req.url.endsWith('/results')) {
      if(rejectReports) {res.statusCode=503; return res.end(JSON.stringify({success:false,error:{message:'Temporarily unavailable'}}));}
      reports.push(...JSON.parse(body).results); acked=true; return ok({synced:1,failed:0,ignored:0});
    }
    res.writeHead(404).end('{}');
  });
  let current = Object.freeze({erpUrl:`http://127.0.0.1:${apiServer.port}`,agentToken:'test-only-token',tallyHost:'127.0.0.1',tallyPort:tallyServer.port,tallyCompany:options.company || 'A & Co',pollSeconds:20,label:'test'});
  t.mock.method(config,'get',() => current);
  return {reports,ledgerReports,imports,apiServer,tallyServer,folder, setRejectReports:(value) => {rejectReports=value;}, setConfig:(patch) => {current=Object.freeze({...current,...patch});}, c:current};
}

test('ERP → agent → Tally → ERP preserves selected company and revision', async (t) => {
  const s = await setup(t); await loop.runOnce();
  assert.equal(s.imports.length,1); assert.match(s.imports[0], /<SVCURRENTCOMPANY>A &amp; Co<\/SVCURRENTCOMPANY>/);
  assert.equal(s.reports[0].status,'SYNCED'); assert.equal(s.reports[0].revision,0);
  assert.equal(loop.getState().company,'A & Co'); assert.equal(loop.getState().pushed,1);
  assert.ok(!fs.existsSync(path.join(s.folder,'pending-results.json')));
});

test('company mismatch leaves vouchers unpulled and provisioning untouched', async (t) => {
  const s = await setup(t,{company:'Food Company',open:['Food Compnay','Nakrani LLP']}); await loop.runOnce();
  assert.equal(s.imports.length,0); assert.ok(!s.apiServer.requests.some((r) => /pending/.test(r.path)));
  assert.equal(loop.getState().tallyReachable,true); assert.match(loop.getState().lastError,/Food Compnay/);
});

test('Sync OFF makes no import or dispatch requests', async (t) => {
  const s = await setup(t,{enabled:false}); await loop.runOnce();
  assert.equal(s.imports.length,0); assert.ok(!s.apiServer.requests.some((r) => /pending/.test(r.path)));
});

test('configuration changes during probe cannot redirect the validated cycle', async (t) => {
  let s;
  s = await setup(t,{onProbe:() => s.setConfig({tallyCompany:'Other Company',tallyPort:1,erpUrl:'http://127.0.0.1:1'})});
  await loop.runOnce(); assert.equal(s.imports.length,1); assert.ok(s.imports[0].includes('A &amp; Co')); assert.equal(s.reports[0].status,'SYNCED');
});

test('failed acknowledgement persists and retries without a duplicate Tally write', async (t) => {
  const s = await setup(t,{rejectReports:true}); await loop.runOnce();
  assert.equal(s.imports.length,1); assert.equal(loop.getState().erpOk,false); assert.equal(journal.load(s.c).length,1);
  s.setRejectReports(false); await loop.runOnce();
  assert.equal(s.imports.length,1); assert.equal(s.reports.length,1); assert.deepEqual(journal.load(s.c),[]);
});

test('pending acknowledgements cannot be replayed into another destination', async (t) => {
  const s = await setup(t,{rejectReports:true}); await loop.runOnce();
  assert.throws(() => journal.load({...s.c,tallyCompany:'Other Company'}),/previous ERP\/Tally/);
});

test('company rejection stops the batch and preserves raw XML', async (t) => {
  const raw='<RESPONSE><LINEERROR>Could not set &apos;SVCurrentCompany&apos; to &apos;A &amp; Co&apos;</LINEERROR></RESPONSE>';
  const s = await setup(t,{items:[item(),{...item(),id:'22222222-2222-4222-8222-222222222222'}],onImport:(res) => res.end(raw)});
  await loop.runOnce(); assert.equal(s.imports.length,1); assert.equal(s.reports.length,1);
  assert.equal(s.reports[0].tallyResponse,raw); assert.equal(s.reports[0].status,'FAILED');
  assert.match(s.reports[0].error,/Other Company/); assert.equal(loop.getState().tallyOk,false);
});

test('401 marks ERP down and prevents Tally requests', async (t) => {
  const s=await setup(t,{unauthorised:true}); await loop.runOnce();
  assert.equal(loop.getState().erpOk,false); assert.equal(s.tallyServer.requests.length,0);
});

test('existing ledgers require an actual matching name and need no import', async (t) => {
  const s=await setup(t,{items:[],existing:['Cash'],ledgers:[{id:'ledger1',name:'Cash',parentGroup:'Cash-in-Hand'}]});
  await loop.runOnce(); assert.equal(s.imports.length,0); assert.equal(s.ledgerReports[0].status,'EXISTS');
});

for (const [label,reply] of [['empty response','<RESPONSE/>'], ['unverified no-op',importReply()]]) test(`ledger ${label} is never confirmed`, async (t) => {
  const s=await setup(t,{items:[],ledgers:[{id:'ledger1',name:'Missing',parentGroup:'Sales Accounts'}],onImport:(res) => res.end(reply)});
  await loop.runOnce(); assert.equal(s.ledgerReports[0].status,'FAILED'); assert.equal(loop.getState().ledgerExists,0);
});

test('GST errors are reported without stripping tax identity', async (t) => {
  const s=await setup(t,{items:[],ledgers:[{id:'ledger1',name:'Party',parentGroup:'Sundry Debtors',isParty:true,gstin:'27TEST'}],onImport:(res) => res.end('<RESPONSE><LINEERROR>GST details invalid</LINEERROR></RESPONSE>')});
  await loop.runOnce(); assert.equal(s.imports.length,1); assert.equal(s.ledgerReports[0].status,'FAILED');
});

test('unknown ledger request stops before other ledgers or voucher dispatch', async (t) => {
  const s = await setup(t, { ledgers: [
    {id:'l1',name:'Sales A',parentGroup:'Sales Accounts'},
    {id:'l2',name:'Sales B',parentGroup:'Sales Accounts'},
  ], onImport: (res) => res.end('<RESPONSE>Unknown request, cannot be processed</RESPONSE>') });
  await loop.runOnce();
  assert.equal(s.imports.length, 1);
  assert.equal(s.ledgerReports.length, 0);
  assert.ok(!s.apiServer.requests.some((r) => r.path.includes('/pending?')));
  assert.match(loop.getState().lastError, /Unknown request/);
});

test('unknown voucher request stops the batch and preserves its raw reply', async (t) => {
  const raw = 'Unknown request, cannot be processed';
  const s = await setup(t, { items: [item(), {...item(),id:'22222222-2222-4222-8222-222222222222'}], onImport: (res) => res.end(raw) });
  await loop.runOnce();
  assert.equal(s.imports.length, 1); assert.equal(s.reports.length, 1);
  assert.equal(s.reports[0].status, 'FAILED'); assert.equal(s.reports[0].tallyResponse, raw);
});

test('cancellation of absent voucher is idempotent for a valid no-op', async (t) => {
  const s=await setup(t,{items:[item(1,'CANCEL')],onImport:(res) => res.end(importReply())});
  await loop.runOnce(); assert.equal(s.reports[0].status,'SYNCED'); assert.equal(s.imports.length,1);
});

test('delete success then create rejection identifies missing voucher', async (t) => {
  const s=await setup(t,{items:[item(1)],onImport:(res,xml) => res.end(xml.includes('ACTION="Delete"') ? importReply({DELETED:1}) : '<RESPONSE><LINEERROR>Ledger is missing</LINEERROR></RESPONSE>')});
  await loop.runOnce(); assert.equal(s.imports.length,2); assert.equal(s.reports[0].status,'FAILED'); assert.match(s.reports[0].error,/previous voucher was deleted/);
});

test('counters reset when next cycle cannot select a company', async (t) => {
  const s=await setup(t); await loop.runOnce(); assert.equal(loop.getState().pushed,1);
  s.setConfig({tallyCompany:'Closed'}); await loop.runOnce(); assert.equal(loop.getState().pushed,0);
});

test('stop during an in-flight tick cannot resurrect polling', async (t) => {
  let release;
  const waiting = new Promise((resolve) => {release=resolve;});
  const s=await setup(t);
  t.mock.method(erp,'heartbeat', async () => {await waiting; return {protocolVersion:2,syncEnabled:false};});
  t.mock.method(tally,'ping', async () => ({reachable:true,companyOpen:true,company:s.c.tallyCompany}));
  let scheduled=0; t.mock.method(global,'setTimeout', () => {scheduled+=1; return {};});
  loop.start(); loop.stop(); release(); await new Promise(setImmediate); assert.equal(scheduled,0);
});

for (const type of ['SALES','RECEIPT','PURCHASE','PAYMENT','JOURNAL']) test(`existing ${type} accounting workflow keeps ledger signs and amounts`,async(t)=>{
  const s=await setup(t,{items:[item(0,'CREATE',type)]}); await loop.runOnce();
  assert.equal(s.reports[0].status,'SYNCED');
  const entries = elements(parseXml(s.imports[0]), 'ALLLEDGERENTRIES.LIST');
  assert.deepEqual(entries.map((entry) => [elements(entry, 'ISDEEMEDPOSITIVE')[0].text, elements(entry, 'AMOUNT')[0].text]),
    [['Yes', '-100.00'], ['No', '100.00']]);
});

test('unsupported stock transfer cannot silently post only its destination',async(t)=>{
  const stock=item(0,'CREATE','STOCK_JOURNAL');
  stock.payload.inventory=[{item:'Product',quantity:1,rate:100,amount:100,godownFrom:'Source',godownTo:'Destination'}];
  const s=await setup(t,{items:[stock]}); await loop.runOnce();
  assert.equal(s.imports.length,0); assert.equal(s.reports[0].status,'FAILED'); assert.match(s.reports[0].error,/Stock journal sync is paused/);
});
