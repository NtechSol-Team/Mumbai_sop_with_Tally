'use strict';
const http = require('node:http');
const { create } = require('xmlbuilder2');

const collection = (type, names) => create({ ENVELOPE: {
  HEADER: { STATUS: 1 }, BODY: { DATA: { COLLECTION: { [type]: names.map((name) => ({ '@NAME': name, NAME: name })) } } },
} }).end();
const importReply = (counts = {}) => create({ RESPONSE: { CREATED: 0, ALTERED: 0, DELETED: 0, IGNORED: 0, ERRORS: 0, ...counts } }).end();
const item = (revision = 0, action = 'CREATE', type = 'SALES') => ({
  id: '11111111-1111-4111-8111-111111111111', revision, dedupKey: 'MUMBAIERP-SALES_BILL-abc',
  payload: { contractVersion: 1, action, voucherType: type, date: '20260906', voucherNumber: 'BL-2026-00001',
    dedupKey: 'MUMBAIERP-SALES_BILL-abc', narration: 'ERP sync',
    lines: action === 'CANCEL' ? [] : [{ ledger: 'Customer & Co', drCr: 'DR', amount: 100 }, { ledger: 'Sales', drCr: 'CR', amount: 100 }],
    meta: { entityType: 'SALES_BILL', entityId: 'abc', revision },
  },
});

async function server(t, handler) {
  const requests = [];
  const service = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ body, path: req.url, headers: req.headers });
    try { await handler(req, res, body, requests); }
    catch (err) { res.writeHead(500).end(err.message); }
  });
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { service.closeAllConnections(); service.close(resolve); }));
  return { port: service.address().port, requests };
}

module.exports = { collection, importReply, item, server };
