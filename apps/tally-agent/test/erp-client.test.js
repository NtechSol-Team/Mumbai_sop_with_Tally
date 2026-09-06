'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const erp = require('../src/erp-client');
const c = { erpUrl: 'https://example.test', agentToken: 'test-token' };

for (const stage of ['fetch', 'body']) {
  test(`ERP ${stage} timeout keeps the real error instead of mutating DOMException.message`, async (t) => {
    const original = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    t.mock.method(global, 'fetch', async () => {
      if (stage === 'fetch') throw original;
      return { ok: true, status: 200, text: async () => { throw original; } };
    });
    await assert.rejects(erp.ledgersPending(c), (error) => {
      assert.equal(error.message, 'ERP did not respond within 30s.');
      assert.equal(error.source, 'ERP'); assert.equal(error.cause, original);
      assert.equal(original.message, 'The operation was aborted due to timeout');
      return true;
    });
  });
}

test('ERP wrapper preserves HTTP status and the server error message', async (t) => {
  t.mock.method(global,'fetch',async()=>({ok:false,status:401,text:async()=>JSON.stringify({success:false,error:{message:'Invalid agent token'}})}));
  await assert.rejects(erp.ledgersPending(c), (error) => {
    assert.equal(error.status,401); assert.equal(error.source,'ERP');
    assert.equal(error.message,'Invalid agent token'); return true;
  });
});

test('ERP classification handles immutable network errors without altering them', async (t) => {
  const original = Object.freeze(new Error('Connection closed'));
  t.mock.method(global,'fetch',async()=>{throw original;});
  await assert.rejects(erp.ledgersPending(c), (error) => {
    assert.equal(error.message,'Connection closed'); assert.equal(error.source,'ERP');
    assert.equal(error.cause,original); return true;
  });
});
