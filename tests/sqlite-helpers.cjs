process.env.TZ='Asia/Tokyo';
const {afterEach}=require('node:test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../src/storage.cjs'),createLedger=require('../src/domain/ledger.cjs');
const {COLUMNS}=require('../src/contract.cjs');
const active=[];
afterEach(()=>{for(const {store,dir} of active.splice(0)){store.close();fs.rmSync(dir,{recursive:true,force:true});}});
function createBackend(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cashflow-test-')),store=openStore(path.join(dir,'data.sqlite'));
  active.push({store,dir});let fail=false,lose=false,count=0;
  const transaction=store.transaction;
  store.transaction=work=>{const result=transaction(()=>{const value=work();if(fail){fail=false;throw new Error('Injected storage failure');}return value;});count++;if(lose){lose=false;throw new Error('Injected lost response after commit');}return result;};
  const ledger=createLedger(store,{today:()=> '2026-09-17'});
  const api={store,dir,post:body=>{try{return ledger.post(body);}catch(e){return {error:e.message};}},get:ledger.get,records:store.all,
    snapshot:()=>Object.fromEntries(Object.keys(COLUMNS).map(name=>[name,store.all(name)])),failNext:()=>{fail=true;},loseNextResponse:()=>{lose=true;},get batchCount(){return count;},get locked(){return store.db.isTransaction;}};
  for(const [id,balance] of [['a',1000],['b',2000]])api.post({action:'saveAccount',id,bank:'合成銀行'+id,type:'普通',balance,balanceDate:'2026-08-31'});
  return api;
}
module.exports={createBackend};
