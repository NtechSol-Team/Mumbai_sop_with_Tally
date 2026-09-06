'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Exercise actual TypeScript services against controlled database boundaries.
// No .env is loaded and no database or external application is contacted.
function load(relative, mocks) {
  const filename=path.resolve(__dirname,'../src',relative);
  const compiled=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const module=new Module(filename,moduleParent);
  const nativeRequire=Module.createRequire(filename);
  module.require=(name) => name in mocks ? mocks[name] : nativeRequire(name);
  module._compile(compiled,filename);
  return module.exports;
}
const moduleParent=module;
const defaults={syncEnabled:true,syncSales:true,syncReceipts:true,syncPurchases:true,syncExpenses:true,syncStockJournal:false,inventoryMode:'ACCOUNTING_ONLY',syncFromDate:null};
function service(prisma,cfg=defaults) {
  return load('modules/tally/tally.service.ts',{
    '../../config/prisma':{prisma}, '../../config/logger':{logger:{warn(){}}},
    '../../shared/utils/AppError':{AppError:{notFound:(s)=>new Error(s),invalidState:(s)=>new Error(s),unauthorized:(s)=>new Error(s)}},
    '../../shared/utils/pagination':{},
    '../../jobs/queue':{enqueue:async()=>{},JobName:{}},
    './tally.config':{getTallyConfig:async()=>cfg},
    './tally.dependencies': load('modules/tally/tally.dependencies.ts', {'../../config/prisma':{prisma}}),
  });
}
const row=()=>({id:'row1',revision:3,status:'PENDING',attempts:0,lastAttemptAt:null,dedupKey:'key',payloadJson:{meta:{revision:3}}});

test('agent routes reject legacy clients before heartbeat, dispatch or acknowledgement', async (t) => {
  const express = require('express');
  const types = load('shared/types/api.ts', {});
  const errors = load('shared/utils/AppError.ts', { '../types/api': types });
  const schemas = load('modules/tally/tally.schema.ts', {
    '../../shared/utils/pagination': { paginationQuerySchema: require('zod').z.object({}) },
  });
  const calls = [];
  const noop = (_req, _res, next) => next();
  const { tallyRouter } = load('modules/tally/tally.routes.ts', {
    '../../shared/utils/asyncHandler': load('shared/utils/asyncHandler.ts', {}),
    '../../shared/middleware/validate': load('shared/middleware/validate.ts', {
      '../utils/AppError': errors, '../types/api': types,
    }),
    '../../shared/guards/authGuard': { authGuard: noop },
    '../../shared/guards/roleGuard': { requireSuperAdmin: noop },
    '../../shared/middleware/rateLimit': { writeRateLimiter: noop },
    '../../shared/utils/apiResponse': load('shared/utils/apiResponse.ts', {}),
    '../../shared/utils/AppError': errors,
    './tally.schema': schemas,
    './tally.service': { tallyService: {
      assertAgentToken: async (token) => { if (token !== 'test-token') throw errors.AppError.unauthorized(); },
      agentHeartbeat: async () => { calls.push('heartbeat'); return { protocolVersion: 2, syncEnabled: true }; },
      agentPending: async () => { calls.push('pending'); return []; },
      agentLedgersPending: async () => { calls.push('ledgers-pending'); return []; },
    } },
  });
  const app = express();
  app.use(express.json(), tallyRouter);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const address = `http://127.0.0.1:${server.address().port}/agent`;
  for (const protocol of [undefined, '1', '3']) {
    for (const endpoint of ['/heartbeat', '/pending', '/ledgers-pending', '/results', '/ledgers-result']) {
      const response = await fetch(address + endpoint, {
        method: ['/heartbeat', '/results', '/ledgers-result'].includes(endpoint) ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer test-token', ...(protocol ? { 'X-Tally-Agent-Protocol': protocol } : {}) },
      });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /Tally Agent update required/);
    }
  }
  assert.deepEqual(calls, []);
  for (const endpoint of ['/heartbeat', '/pending', '/ledgers-pending']) {
    const response = await fetch(address + endpoint, {
      method: endpoint === '/heartbeat' ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer test-token', 'X-Tally-Agent-Protocol': '2', 'Content-Type': 'application/json' },
      ...(endpoint === '/heartbeat' ? { body: '{}' } : {}),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.deepEqual(calls, ['heartbeat', 'pending', 'ledgers-pending']);
});

test('Sync OFF prevents querying, dispatching or consuming attempts',async()=>{
  const actual=service({}, {...defaults,syncEnabled:false});
  assert.deepEqual(await actual.agentPending(25),[]);
});

test('dispatch rechecks modules/cutover and atomically claims matching revisions',async()=>{
  const queue=row(), updates=[]; let query;
  const prisma={tallyConfig:{update:async()=>{}},tallySyncQueue:{
    findMany:async(args)=>{query=args;return [queue];},
    updateMany:async(args)=>{updates.push(args);return {count:args.where.id ? 1 : 0};},
  }};
  const cfg={...defaults,syncSales:false,syncFromDate:new Date('2026-09-01')};
  const result=await service(prisma,cfg).agentPending(100);
  assert.equal(query.take,25); assert.ok(!query.where.entityType.in.includes('SALES_BILL'));
  assert.deepEqual(query.where.entityDate,{gte:cfg.syncFromDate});
  assert.ok(query.where.OR.some((x)=>x.lastAttemptAt===null));
  assert.deepEqual(updates[1].where,{id:'row1',revision:3,status:'PENDING',lastAttemptAt:null,attempts:0});
  assert.equal(result[0].revision,3);
});

test('a concurrent claim winner prevents second dispatch',async()=>{
  const prisma={tallyConfig:{update:async()=>{}},tallySyncQueue:{findMany:async()=>[row()],updateMany:async()=>({count:0})}};
  assert.deepEqual(await service(prisma).agentPending(25),[]);
});

test('stale acknowledgements cannot mark a newer revision synced',async()=>{
  const updated=[];
  const prisma={tallySyncQueue:{updateMany:async(args)=>{updated.push(args);return {count:args.where.revision===3 ? 1 : 0};}}};
  const actual=service(prisma);
  const stale=await actual.agentReportResults([{id:'row1',revision:2,status:'SYNCED'}]);
  assert.deepEqual(stale,{synced:0,failed:0,ignored:1});
  const current=await actual.agentReportResults([{id:'row1',revision:3,status:'SYNCED',tallyVoucherId:'42'}]);
  assert.equal(current.synced,1); assert.equal(updated[1].where.status,'PENDING');
});

test('database acknowledgement failures propagate so the agent retains its journal',async()=>{
  const actual=service({tallySyncQueue:{updateMany:async()=>{throw new Error('database unavailable');}}});
  await assert.rejects(actual.agentReportResults([{id:'row1',revision:3,status:'SYNCED'}]),/database unavailable/);
});

test('heartbeat stores exact local target and invalidates previous company ledger confirmations',async()=>{
  const updates=[];
  const tx={tallyConfig:{findUniqueOrThrow:async()=>({tallyCompanyName:'Old',tallyHost:'localhost',tallyPort:9000}),update:async(args)=>{updates.push(args);return {...args.data,syncEnabled:true};}},tallyLedgerMap:{updateMany:async(args)=>updates.push(args)}};
  const actual=service({$transaction:async(cb)=>cb(tx)});
  const result=await actual.agentHeartbeat({tallyCompanyName:' A & B ',tallyHost:'127.0.0.1',tallyPort:9001});
  assert.deepEqual(updates[0],{data:{validatedAt:null}});
  assert.equal(updates[1].data.tallyCompanyName,' A & B '); assert.equal(result.protocolVersion,2);
});

test('ledger provisioning obeys the master Sync switch',async()=>{
  const actual=service({tallyConfig:{findUnique:async()=>({autoProvisionLedgers:true,syncEnabled:false})}});
  assert.deepEqual(await actual.agentLedgersPending(),[]);
});

test('ledger results do not confirm a renamed mapping',async()=>{
  let where;
  const actual=service({tallyLedgerMap:{updateMany:async(args)=>{where=args.where;return {count:0};}}});
  await actual.agentReportLedgerResults([{id:'L1',ledgerName:'Old',parentGroup:'Sales Accounts',status:'CREATED'}]);
  assert.equal(where.OR[0].tallyLedgerName,'Old');
});

test('hard-deleted expenses retain ready cancellation with original voucher identity',async()=>{
  const original={id:'q1',entityType:'EXPENSE',entityId:'e1',revision:2,status:'SYNCED',voucherType:'PAYMENT',entityDate:new Date('2026-09-06'),docNumber:null,dedupKey:'stable-key',payloadJson:{voucherType:'JOURNAL',voucherNumber:'original-number',date:'20260905'}};
  let updated;
  const actual=load('modules/tally/tally.outbox.ts',{});
  const tx={tallySyncQueue:{findUnique:async()=>original,update:async(args)=>{updated=args;}}};
  await actual.markTallyDeleted(tx,'EXPENSE','e1');
  const p=updated.data.payloadJson;
  assert.equal(p.action,'CANCEL'); assert.equal(p.voucherType,'JOURNAL'); assert.equal(p.voucherNumber,'original-number');
  assert.equal(p.dedupKey,'stable-key'); assert.equal(p.meta.revision,3); assert.deepEqual(p.lines,[]);
});

test('EXCLUDED vouchers are never cancelled',async()=>{
  const actual=load('modules/tally/tally.outbox.ts',{});
  await actual.markTallyDeleted({tallySyncQueue:{findUnique:async()=>({status:'EXCLUDED'})}},'EXPENSE','e1');
});

test('result schema requires revision and heartbeat preserves exact company whitespace',()=>{
  const actual=load('modules/tally/tally.schema.ts',{'../../shared/utils/pagination':{paginationQuerySchema:require('zod').z.object({})}});
  assert.equal(actual.agentResultSchema.safeParse({results:[{id:'11111111-1111-4111-8111-111111111111',status:'SYNCED'}]}).success,false);
  assert.equal(actual.agentHeartbeatSchema.parse({tallyCompanyName:' A & B '}).tallyCompanyName,' A & B ');
  assert.equal(actual.updateTallyConfigSchema.safeParse({tallyCompanyName:'Ignored remote setting'}).success,false);
});

test('source edit during voucher build cannot publish the old revision or report it built',async()=>{
  const live={id:'q1',revision:2,status:'PENDING',payloadJson:null};
  let emitted=false;
  const actual=load('jobs/handlers/tallyBuildVouchers.ts',{
    '../../config/prisma':{prisma:{tallySyncQueue:{findMany:async()=>[{...live}],updateMany:async(args)=>{
      if(args.where.revision!==live.revision) return {count:0};
      Object.assign(live,args.data); return {count:1};
    }}}},
    '../../config/logger':{logger:{info(){}}},
    '../../sockets/realtime':{emitRealtime:async()=>{emitted=true;}},
    '../../sockets/events':{RealtimeEvent:{REPORT_READY:'ready'}},
    '../../modules/tally/tally.builder':{buildVoucher:async()=>{live.revision=3;return {meta:{revision:2}};}},
    '../../modules/tally/tally.types':{TallyBuildError:class extends Error{},TallyDeferError:class extends Error{}},
    '../../modules/tally/tally.config':{getTallyConfig:async()=>({syncEnabled:true}),ensureTallyDefaults:async()=>{}},
  });
  await actual.tallyBuildVouchersHandler([]);
  assert.equal(live.payloadJson,null); assert.equal(live.revision,3); assert.equal(emitted,false);
});

for (const status of ['PENDING','FAILED','EXCLUDED',null,'SYNCED']) {
  test(`payment dependencies require a confirmed parent (${status ?? 'missing'})`, async () => {
    const queries=[];
    const prisma={tallySyncQueue:{findUnique:async(args)=>{queries.push(args);return status ? {status,docNumber:'PB-TEST'} : null;}}};
    const actual=load('modules/tally/tally.dependencies.ts',{'../../config/prisma':{prisma}});
    const result=await actual.parentVoucherWaitReason('PURCHASE_BILL','bill1','purchase bill');
    if (status==='SYNCED') assert.equal(result,null);
    else assert.match(result,new RegExp(status ?? 'not queued'));
    assert.equal(queries[0].where.entityType_entityId.entityId,'bill1');
  });
}

for (const entityType of ['SUPPLIER_PAYMENT','PAYMENT_IN']) {
  test(`prebuilt ${entityType} is held without consuming attempts until its actual parent is synced`, async () => {
    const q={...row(),entityType,entityId:'payment1'}, updates=[];
    let parentStatus='FAILED';
    const prisma={tallyConfig:{update:async()=>{}},
      supplierPayment:{findUnique:async()=>({supplierBillId:'actual-bill'})},
      payment:{findUnique:async()=>({billId:'actual-bill'})},
      tallySyncQueue:{findMany:async()=>[q],findUnique:async(args)=>{
        assert.equal(args.where.entityType_entityId.entityId,'actual-bill');
        return {status:parentStatus,docNumber:'BILL-1'};
      },updateMany:async(args)=>{updates.push(args);return {count:args.where.id ? 1 : 0};}},
    };
    const actual=service(prisma);
    assert.deepEqual(await actual.agentPending(25),[]);
    assert.match(updates.at(-1).data.errorMessage,/FAILED/);
    assert.ok(!updates.some((u)=>u.data.attempts));
    parentStatus='SYNCED';
    assert.equal((await actual.agentPending(25)).length,1);
    assert.deepEqual(updates.at(-1).data.attempts,{increment:1});
  });
}

test('advance receipts, cancellation payloads and unrelated vouchers bypass invoice dependencies', async()=>{
  const actual=load('modules/tally/tally.dependencies.ts',{'../../config/prisma':{prisma:{payment:{findUnique:async()=>({billId:null})}}}});
  assert.equal(await actual.paymentVoucherWaitReason({entityType:'PAYMENT_IN',entityId:'advance',payloadJson:{action:'CREATE'}}),null);
  assert.equal(await actual.paymentVoucherWaitReason({entityType:'SUPPLIER_PAYMENT',entityId:'deleted',payloadJson:{action:'CANCEL'}}),null);
  assert.equal(await actual.paymentVoucherWaitReason({entityType:'PURCHASE_BILL',entityId:'bill',payloadJson:{action:'CREATE'}}),null);
});

test('held payments do not starve later invoices in the dispatch queue', async()=>{
  const held={...row(),entityType:'SUPPLIER_PAYMENT',entityId:'payment1'};
  const bill={...row(),id:'bill-row',entityType:'PURCHASE_BILL',entityId:'bill1'};
  const queries=[],updates=[];
  const prisma={tallyConfig:{update:async()=>{}},supplierPayment:{findUnique:async()=>({supplierBillId:'bill1'})},tallySyncQueue:{
    findUnique:async()=>({status:'PENDING',docNumber:'PB-1'}),
    findMany:async(args)=>{queries.push(args);return args.cursor ? [bill] : [held];},
    updateMany:async(args)=>{updates.push(args);return {count:args.where.id ? 1 : 0};},
  }};
  const result=await service(prisma).agentPending(1);
  assert.deepEqual(result.map((r)=>r.id),['bill-row']);
  assert.deepEqual(queries[1].cursor,{id:'row1'});
  assert.equal(updates.filter((u)=>u.data.attempts).length,1);
});

test('supplier payment builder defers a failed purchase instead of constructing an Agst Ref voucher', async()=>{
  const types=load('modules/tally/tally.types.ts',{});
  const prisma={supplierPayment:{findUnique:async()=>({bill:{id:'bill1',isGstBill:true,outletId:null}})},
    tallySyncQueue:{findUnique:async()=>({status:'FAILED',docNumber:'PB-1'})}};
  const actual=load('modules/tally/tally.builder.ts',{
    '../../config/prisma':{prisma}, '../../config/env':{env:{}}, '../../shared/utils/gst':{},
    './tally.types':types, './tally.config':{loadLedgerIndex:async()=>({}),getTallyConfig:async()=>defaults},
    './tally.dependencies':load('modules/tally/tally.dependencies.ts',{'../../config/prisma':{prisma}}),
  });
  await assert.rejects(actual.buildVoucher({...row(),entityType:'SUPPLIER_PAYMENT',entityId:'payment1'}),
    (error)=>error instanceof types.TallyDeferError && /PB-1.*FAILED/.test(error.message));
});
