'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { messagesFor } = require('../src/xml');
const { parseXml, elements } = require('../src/xml-response');
const tally = require('../src/tally-client');
const { item, importReply } = require('./helpers');
const value = (node, tag) => node.children.find((c) => c.name === tag)?.text;

for (const type of ['PURCHASE', 'SALES', 'PAYMENT', 'RECEIPT', 'JOURNAL']) {
  test(`${type} imports accounting lines in an explicit, consistent voucher mode`, () => {
    const q = item(0, 'CREATE', type);
    q.payload.partyLedger = ' Supplier & कंपनी ';
    q.payload.reference = '000459';
    q.payload.lines = [
      { ledger: q.payload.partyLedger, drCr: 'CR', amount: 1180,
        billAllocations: [{ name: '000459', kind: 'NEW', amount: 1180 }] },
      { ledger: 'Purchases', drCr: 'DR', amount: 1000 },
      { ledger: 'Input CGST', drCr: 'DR', amount: 90 },
      { ledger: 'Input SGST', drCr: 'DR', amount: 90 },
    ];
    const root = parseXml(messagesFor(q, ' Food Compnay ')[0].xml);
    const v = elements(root, 'VOUCHER')[0];
    assert.equal(v.attributes.OBJVIEW, 'Accounting Voucher View');
    assert.equal(value(v, 'PERSISTEDVIEW'), 'Accounting Voucher View');
    assert.equal(value(v, 'ISINVOICE'), 'No');
    assert.equal(value(v, 'VOUCHERTYPENAME'), {PURCHASE:'Purchase',SALES:'Sales',PAYMENT:'Payment',RECEIPT:'Receipt',JOURNAL:'Journal'}[type]);
    assert.equal(value(v, 'REFERENCE'), '000459');
    assert.equal(elements(root, 'SVCURRENTCOMPANY')[0].text, ' Food Compnay ');
    const ledgers = v.children.filter((c) => c.name === 'ALLLEDGERENTRIES.LIST');
    assert.equal(ledgers.length, 4);
    assert.deepEqual(ledgers.map((l) => value(l, 'AMOUNT')), ['1180.00','-1000.00','-90.00','-90.00']);
    assert.equal(ledgers.reduce((n,l) => n + Number(value(l,'AMOUNT')), 0), 0);
    assert.equal(value(ledgers[0], 'LEDGERNAME'), q.payload.partyLedger);
    assert.equal(value(ledgers[0], 'ISPARTYLEDGER'), 'Yes');
    assert.ok(ledgers.slice(1).every((l) => value(l, 'ISPARTYLEDGER') === 'No'));
    assert.equal(elements(ledgers[0], 'BILLTYPE')[0].text, 'New Ref');
    assert.equal(elements(ledgers[0], 'AMOUNT')[1].text, '1180.00');
  });
}

test('cancellation keeps voucher identity without adding accounting entries', () => {
  const q = item(2, 'CANCEL', 'PURCHASE');
  const messages = messagesFor(q, 'Selected');
  assert.equal(messages.length, 1);
  const v = elements(parseXml(messages[0].xml), 'VOUCHER')[0];
  assert.equal(v.attributes.ACTION, 'Delete');
  assert.equal(v.attributes.REMOTEID, q.dedupKey);
  assert.equal(elements(v, 'ALLLEDGERENTRIES.LIST').length, 0);
});

test('retained import exceptions are failures with actionable report instructions', () => {
  const result = tally.interpret(importReply({ EXCEPTIONS:1 }), 'Create');
  assert.equal(result.ok, false);
  assert.match(result.error, /1 import exception/);
  assert.match(result.error, /Alt\+O/);
  assert.match(result.error, /before retrying/);
});

test('specific Tally exception details take precedence over generic instructions', () => {
  const result = tally.interpret(importReply({ EXCEPTIONS:1, LINEERROR:'No accounting or inventory entries are available' }), 'Create');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'No accounting or inventory entries are available');
});
