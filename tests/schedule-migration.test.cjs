'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const legacy=require('./fixtures/storage-v2.cjs'),{openStore}=require('../src/storage.cjs');
const ledger=require('../src/domain/ledger.cjs');
const {checksum,inspectSnapshot,atomicJson}=require('../src/backup.cjs'),{restore}=require('../tools/restore.cjs');
const {migrateSchedules}=require('../src/schedule-schema.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'migration3-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'old.sqlite'),store=legacy.openStore(file),api=ledger(store);api.post({action:'saveAccount',id:'a',bank:'合成銀行',branch:'合成支店',accountNumber:'0012345',type:'普通',balance:123456,balanceDate:'2026-08-31'});api.post({action:'saveReceivable',id:'r',partner:'合成先',invoiceDate:'2026-09-01',dueDate:'2026-09-30',amount:100,account:'a'});api.post({action:'confirmReceivable',id:'r',amount:40,date:'2026-09-02',paymentId:'p',account:'a',expectedUpdatedAt:store.find('receivables','r').updatedAt});store.db.exec("INSERT INTO users VALUES('u','synthetic','synthetic-hash','admin','2026-09-01'); INSERT INTO sessions VALUES('token','u','csrf',1,2,3)");return {dir,file,store};}
function snapshot(db){return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY 1').all()]));}
test('real v2 WAL backup restores, migration preserves every legacy row, old app refuses v3, rollback opens v2 backup',async t=>{
 const f=fixture(t),before=snapshot(f.store.db),id='cashflow-20260928T000000000Z-abcdef12',source=path.join(f.dir,id+'.sqlite');
 await backup(f.store.db,source);f.store.close();const normalize=new DatabaseSync(source);normalize.exec('PRAGMA journal_mode=DELETE');normalize.close();
 const sha=checksum(source),manifest=path.join(f.dir,id+'.manifest.json');atomicJson(manifest,{id,databaseFile:id+'.sqlite',createdAt:'2026-09-28T00:00:00.000Z',sha256:sha,bytes:fs.statSync(source).size,...inspectSnapshot(source,{allowPreviousSchema:true})});fs.writeFileSync(path.join(f.dir,id+'.sha256'),sha+'  '+id+'.sqlite\n');
 const upgraded=openStore(f.file);try{const after=snapshot(upgraded.db);for(const name of Object.keys(before))assert.deepEqual(after[name],before[name],name);assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,4);assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(upgraded.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);}finally{upgraded.close();}
 const rejection=require('node:child_process').spawnSync(process.execPath,['-e',"require('./tests/fixtures/storage-v2.cjs').openStore(process.argv[1])",f.file],{cwd:path.join(__dirname,'..'),encoding:'utf8'});assert.notEqual(rejection.status,0);assert.match(rejection.stderr,/newer/);
 const target=path.join(f.dir,'restored.sqlite');await restore(manifest,target);const restored=openStore(target);try{assert.deepEqual(restored.db.prepare('SELECT * FROM cashflow_transactions ORDER BY id').all(),before.cashflow_transactions);assert.deepEqual(restored.db.prepare('SELECT * FROM users').all(),before.users);assert.equal(restored.db.prepare('SELECT count(*) n FROM sessions').get().n,0);}finally{restored.close();}
 const rollback=path.join(f.dir,'rollback.sqlite');fs.copyFileSync(source,rollback);const old=legacy.openStore(rollback);try{assert.deepEqual(snapshot(old.db),before);}finally{old.close();}assert.equal(checksum(source),sha);
});
test('failed schema migration rolls all table and row changes back and restores FK enforcement',t=>{
 const f=fixture(t);try{f.store.db.exec('CREATE TABLE payment_schedules(id TEXT PRIMARY KEY)');const before=snapshot(f.store.db);assert.throws(()=>migrateSchedules(f.store.db),/already exists/);assert.deepEqual(snapshot(f.store.db),before);assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,2);assert.equal(f.store.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length,0);}finally{f.store.close();}
});

