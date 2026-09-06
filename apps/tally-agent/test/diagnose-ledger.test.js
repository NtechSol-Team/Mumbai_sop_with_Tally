'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tally = require('../src/tally-client');
const erp = require('../src/erp-client');
const { diagnose } = require('../src/diagnose-ledger');
const { importReply } = require('./helpers');
const c = Object.freeze({ erpUrl: 'https://example.test', agentToken: 'private-test-token', tallyCompany: ' A & B ' });

function setup(t, reply = importReply({CREATED:1}), readback = true) {
  const posts = []; let sent = false;
  t.mock.method(tally, 'ping', async () => ({companyOpen:true,company:c.tallyCompany}));
  t.mock.method(tally, 'listLedgerNames', async () => sent && readback ? ['Existing', 'Sales & Food'] : ['Existing']);
  t.mock.method(erp, 'ledgersPending', async () => [
    {id:'l1',name:'Existing',parentGroup:'Sales Accounts'},
    {id:'l2',name:'Sales & Food',parentGroup:'Sales Accounts'},
    {id:'l3',name:'Other',parentGroup:'Sales Accounts'},
  ]);
  t.mock.method(tally, 'postXml', async (xml, snapshot) => { assert.equal(snapshot,c); posts.push(xml); sent=true; return {status:200,body:reply}; });
  for (const fn of ['heartbeat','pullPending','reportResults','reportLedgerResults']) t.mock.method(erp,fn,async()=>{throw Error('Unexpected ERP write/dispatch: '+fn);});
  return posts;
}

test('ledger diagnostic previews a missing mapped ledger without sending an import or token', async (t) => {
  const posts = setup(t); const result = await diagnose({}, c);
  assert.equal(posts.length, 0); assert.equal(result.attempted, false);
  assert.equal(result.ledger, 'Sales & Food'); assert.ok(!JSON.stringify(result).includes(c.agentToken));
});

test('explicit diagnostic create sends only one mapped ledger and checks readback', async (t) => {
  const posts = setup(t); const result = await diagnose({create:true}, c);
  assert.equal(posts.length, 1); assert.equal(result.ok, true); assert.equal(result.existsAfter, true);
  assert.ok(posts[0].includes('<SVCURRENTCOMPANY> A &amp; B </SVCURRENTCOMPANY>'));
});

test('ledger diagnostic cannot succeed on unknown request or absent readback', async (t) => {
  const raw = '<RESPONSE>Unknown request, cannot be processed</RESPONSE>';
  const posts = setup(t, raw, false); const result = await diagnose({create:true}, c);
  assert.equal(posts.length, 1); assert.equal(result.ok, false); assert.equal(result.response, raw);
  assert.equal(result.httpStatus, 200); assert.equal(result.existsAfter, false);
});

test('successful count alone does not satisfy diagnostic readback', async (t) => {
  setup(t, importReply({CREATED:1}), false);
  const result = await diagnose({create:true}, c);
  assert.equal(result.importConfirmed, true); assert.equal(result.ok, false);
});

test('company mismatch stops diagnostic before any ledger request', async (t) => {
  const posts = setup(t);
  t.mock.method(tally,'ping',async()=>({companyOpen:false,error:'Company does not match'}));
  await assert.rejects(diagnose({create:true},c),/Company does not match/);
  assert.equal(posts.length,0);
});
