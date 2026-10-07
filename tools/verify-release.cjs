'use strict';
// Read actual backup artifacts and restore only to a fresh temporary directory.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {restore}=require('./restore.cjs');
const {checksum,inspectSnapshot}=require('../src/backup.cjs');
const {COLUMNS}=require('../src/contract.cjs');
const {openStore}=require('../src/storage.cjs'),createLedger=require('../src/domain/ledger.cjs');
const {createApplication}=require('../src/server.cjs');
async function verify(beforePath,afterPath){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cashflow-release-'));
 try{
  const paths=[beforePath,afterPath||beforePath],targets=[];
  for(let i=0;i<paths.length;i++){
   const manifest=JSON.parse(fs.readFileSync(paths[i],'utf8')),source=path.join(path.dirname(paths[i]),manifest.databaseFile),hash=checksum(source),target=path.join(dir,i+'.sqlite');
   await restore(paths[i],target);assert.equal(checksum(source),hash);
   const report=inspectSnapshot(target);assert.deepEqual(report.counts,manifest.counts);assert.deepEqual(JSON.parse(JSON.stringify(report.totals)),manifest.totals);targets.push(target);
  }
  const db=new DatabaseSync(targets[1],{readOnly:true});
  db.prepare('ATTACH DATABASE ? AS old').run(targets[0]);
  for(const [table,columns] of [...Object.entries(COLUMNS).filter(([name])=>name!=='settings'),['users',['id','username','passwordHash','role','createdAt']]]){
   const cols=columns.map(c=>'"'+c+'"').join(',');
   const missing=db.prepare('SELECT count(*) n FROM (SELECT '+cols+' FROM old."'+table+'" EXCEPT SELECT '+cols+' FROM main."'+table+'")').get().n;
   assert.equal(missing,0,'Existing records changed in '+table);
   if(table==='accounts'||table==='users')assert.equal(db.prepare('SELECT count(*) n FROM main."'+table+'"').get().n,db.prepare('SELECT count(*) n FROM old."'+table+'"').get().n);
  }
  const users=db.prepare('SELECT count(*) n FROM users').get().n,accounts=db.prepare('SELECT count(*) n FROM accounts').get().n;db.close();
  const store=openStore(targets[1]);const ledger=createLedger(store),ids=store.all('accounts').map(a=>a.id).join(',');
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const before=ids?ledger.get('getCashflowPeriod',{start:'2026-12',end:'2030-01',mode:'predict',day,accounts:ids}).periods:null;
  const app=await createApplication({store,origin:'http://127.0.0.1:3310'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  assert.equal((await fetch('http://127.0.0.1:'+app.server.address().port+'/healthz')).status,200);
  // Materialization must not change cash amounts, dates or balances.
  if(ids){const after=ledger.get('getCashflowPeriod',{start:'2026-12',end:'2030-01',mode:'predict',day,accounts:ids}).periods;assert.deepEqual(after.map(p=>p.totals),before.map(p=>p.totals));}
  await app.close();store.close();
  console.log(JSON.stringify({result:'verified',users,accounts,existingRecordsPreserved:true,backupUnchanged:true,restoredIntegrity:'ok',restoredHealth:'ok'}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
verify(...process.argv.slice(2)).catch(error=>{console.error('RELEASE_VERIFICATION_FAILED',error.code||error.name);console.error(String(error.stack).split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,5).join('\n'));process.exitCode=1;});
