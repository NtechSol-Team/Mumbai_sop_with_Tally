'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const config=require('../src/config');
const {server,collection}=require('./helpers');
const envKeys=['MUMBAI_ERP_URL','MUMBAI_ERP_TOKEN','TALLY_HOST','TALLY_PORT','TALLY_COMPANY','POLL_SECONDS','AGENT_LABEL'];
function setup(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tally-config-test-'));
  config.setStorePath(path.join(directory,'config.json'));
  const saved=Object.fromEntries(envKeys.map((k)=>[k,process.env[k]]));
  envKeys.forEach((k)=>delete process.env[k]);
  t.after(()=>{for(const [k,v] of Object.entries(saved)) {if(v===undefined) delete process.env[k]; else process.env[k]=v;}fs.rmSync(directory,{recursive:true,force:true});});
  return directory;
}

test('company file value preserves spaces; environment precedence is explicit', (t)=>{
  setup(t); config.set({tallyCompany:' A & B '}); assert.equal(config.get().tallyCompany,' A & B ');
  process.env.TALLY_COMPANY='Environment company'; assert.equal(config.get().tallyCompany,'Environment company');
  assert.equal(config.companySource(),'environment variable TALLY_COMPANY');
  assert.throws(()=>config.set({tallyCompany:'New choice'}),/overridden by TALLY_COMPANY/);
  process.env.TALLY_COMPANY=''; assert.equal(config.get().tallyCompany,'');
});

test('invalid port/poll/file configuration fails visibly and leaves valid file intact',(t)=>{
  const directory=setup(t); config.set({tallyCompany:'A'});
  assert.throws(()=>config.set({tallyPort:NaN}),/port/);
  assert.throws(()=>config.set({pollSeconds:0}),/Poll/);
  assert.equal(config.get().tallyCompany,'A');
  fs.writeFileSync(path.join(directory,'config.json'),'{broken');
  assert.throws(()=>config.get(),/valid JSON/);
});

test('headless company discovery works without ERP credentials and makes no import',async(t)=>{
  const directory=setup(t);
  const s=await server(t,(_req,res)=>res.end(collection('COMPANY',['First',' A & B '])));
  const env={...process.env,MUMBAI_ERP_TALLY_CONFIG:path.join(directory,'config.json'),TALLY_HOST:'127.0.0.1',TALLY_PORT:String(s.port)};
  const {stdout}=await promisify(execFile)(process.execPath,[path.resolve(__dirname,'../src/run-headless.js'),'--list-companies'],{env});
  assert.deepEqual(JSON.parse(stdout),['First',' A & B ']); assert.equal(s.requests.length,1);
  assert.ok(!s.requests[0].body.includes('SVCURRENTCOMPANY'));
});

test('headless check exits unsuccessfully on a mismatch',async(t)=>{
  const directory=setup(t);
  const s=await server(t,(_req,res)=>res.end(collection('COMPANY',['Food Compnay','Nakrani LLP'])));
  const env={...process.env,MUMBAI_ERP_TALLY_CONFIG:path.join(directory,'config.json'),TALLY_HOST:'127.0.0.1',TALLY_PORT:String(s.port),TALLY_COMPANY:'Food Company'};
  await assert.rejects(promisify(execFile)(process.execPath,[path.resolve(__dirname,'../src/run-headless.js'),'--check'],{env}), (err)=>{
    assert.equal(err.code,1); assert.equal(JSON.parse(err.stdout).code,'COMPANY_NOT_OPEN'); return true;
  });
});
