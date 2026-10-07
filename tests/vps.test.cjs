process.env.TZ='Asia/Tokyo';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../src/storage.cjs'),createLedger=require('../src/domain/ledger.cjs');
const {createAdmin,createAuth}=require('../src/auth.cjs');
const {createBackup,readStatus,listCompleted,selectRetained,inspectSnapshot}=require('../src/backup.cjs');
const {restore}=require('../tools/restore.cjs');
const {createApplication}=require('../src/server.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cashflow-vps-'));let store=openStore(path.join(dir,'data.sqlite'));t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,backupDir:path.join(dir,'backups'),statusDir:path.join(dir,'status'),databasePath:path.join(dir,'data.sqlite')};}
const account={action:'saveAccount',id:'a',bank:'合成銀行',branch:'合成支店',accountNumber:'0012345',balance:1000,balanceDate:'2026-08-31',type:'普通'};
test('WAL backup captures committed ledger, restores into a fresh database, and rejects tampering/overwrite',async t=>{
  const f=fixture(t),ledger=createLedger(f.store);
  ledger.post(account);await createAdmin(f.store,'test-admin','Synthetic-only-password');
  ledger.post({action:'saveReceivable',id:'r',partner:'合成',invoiceDate:'2026-09-01',dueDate:'2026-09-30',amount:100,account:'a'});
  ledger.post({action:'confirmReceivable',id:'r',amount:40,date:'2026-09-02',paymentId:'p1',account:'a',expectedUpdatedAt:f.store.find('receivables','r').updatedAt});
  assert.ok(fs.statSync(f.databasePath+'-wal').size>0);
  const m=await createBackup(f);assert.equal(m.counts.receivables,1);assert.equal(m.totals.receivables.outstanding,60);assert.equal(readStatus(f.statusDir).state,'ok');
  assert.equal(fs.readdirSync(f.backupDir).length,3);assert.equal(f.store.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  const manifest=path.join(f.backupDir,m.id+'.manifest.json'),target=path.join(f.dir,'restore','new.sqlite');
  assert.deepEqual(await restore(manifest,target),inspectSnapshot(f.databasePath));
  const copy=openStore(target);assert.equal(copy.all('cashflow_transactions').length,2);assert.equal(copy.db.prepare('SELECT count(*) n FROM sessions').get().n,0);copy.close();
  await assert.rejects(restore(manifest,target),/TARGET_EXISTS/);
  fs.appendFileSync(path.join(f.backupDir,m.databaseFile),'tampered');await assert.rejects(restore(manifest,path.join(f.dir,'bad.sqlite')),/CHECKSUM/);
});
test('backup failure retains previous success and completed backups; lock prevents overlap',async t=>{
  const f=fixture(t);createLedger(f.store).post(account);const first=await createBackup(f);
  await assert.rejects(createBackup({...f,databasePath:path.join(f.dir,'missing.sqlite')}),/BACKUP_FAILED/);
  assert.equal(readStatus(f.statusDir).state,'failed');assert.equal(readStatus(f.statusDir).lastSuccessAt,first.createdAt);assert.equal(listCompleted(f.backupDir).length,1);
  fs.writeFileSync(path.join(f.statusDir,'backup.lock'),'synthetic');await assert.rejects(createBackup(f),/BACKUP_LOCKED/);assert.equal(listCompleted(f.backupDir).length,1);
  fs.unlinkSync(path.join(f.statusDir,'backup.lock'));await createBackup(f);assert.equal(readStatus(f.statusDir).state,'ok');
  assert.equal(readStatus(f.statusDir,Date.now()+91*60000).state,'stale');
});
test('retention preserves latest 48 hourly and 14 daily recovery points without duplicate slots',()=>{
  const rows=Array.from({length:24*30},(_,i)=>({id:String(i),createdAt:new Date(Date.UTC(2026,8,24)-i*3600000).toISOString()}));
  const keep=selectRetained(rows);assert.ok(keep.size>=59&&keep.size<=62);for(let i=0;i<48;i++)assert.ok(keep.has(String(i)));assert.ok(!keep.has('719'));
});
test('SQLite persistence, foreign keys, integer validation and company settings survive reopening',t=>{
  const f=fixture(t),ledger=createLedger(f.store);ledger.post(account);ledger.post({action:'saveSettings',companyName:'合成会社'});
  assert.throws(()=>ledger.post({...account,id:'bad',balance:1.1}),/整数/);assert.throws(()=>ledger.post({...account,id:"bad'"}),/ID/);
  const other=openStore(f.databasePath);assert.equal(other.find('accounts','a').balance,1000);assert.equal(other.setting('companyName'),'合成会社');other.close();
});
test('authentication expires sessions and invalidates old sessions when password changes',async t=>{
  const f=fixture(t);await createAdmin(f.store,'test-admin','Synthetic-only-password');let now=Date.now();const auth=await createAuth(f.store,{now:()=>now});
  const login=await auth.login('test-admin','Synthetic-only-password','local');assert.equal(login.status,200);
  const req={headers:{cookie:auth.cookie(login.token),'x-csrf-token':login.csrf}},s=auth.session(req);assert.ok(s);assert.ok(auth.csrf(req,s));
  assert.match(auth.cookie(login.token),/Secure/);assert.match(auth.cookie(login.token),/HttpOnly/);
  now+=3500000;assert.ok(auth.session(req,{touch:false}));now+=100001;assert.equal(auth.session(req),null);
  const next=await auth.login('test-admin','Synthetic-only-password','local');const s2=auth.session({headers:{cookie:auth.cookie(next.token)}});
  await auth.changePassword(s2,'Synthetic-only-password','Synthetic-new-password');assert.equal(auth.session({headers:{cookie:auth.cookie(next.token)}}),null);
});
test('HTTP gate protects data, validates origin/CSRF, rejects file traversal, and persists authorized operations',async t=>{
  const f=fixture(t);await createAdmin(f.store,'test-admin','Synthetic-only-password');
  const origin='http://127.0.0.1:3310',app=await createApplication({store:f.store,origin,statusDir:f.statusDir});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port;
  const request=(route,opts={})=>new Promise((resolve,reject)=>{
    const req=require('node:http').request(base+route,{method:opts.method||'GET',headers:{Host:'127.0.0.1:3310',...opts.headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:{get:name=>{const v=res.headers[name];return Array.isArray(v)?v.join(','):v;}},json:async()=>JSON.parse(Buffer.concat(chunks).toString())}));});
    req.on('error',reject);req.end(opts.body);
  });
  assert.equal((await request('/api/v1?action=getAccounts')).status,401);assert.equal((await request('/')).status,303);
  assert.equal((await request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid'},body:'{}'})).status,403);
  const login=await request('/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'test-admin',password:'Synthetic-only-password'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json();
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
  assert.equal((await request('/api/v1',{method:'POST',headers,body:JSON.stringify(account)})).status,403);
  headers['X-CSRF-Token']=session.csrf;
  assert.equal((await request('/api/v1',{method:'POST',headers,body:JSON.stringify(account)})).status,200);
  const data=await(await request('/api/v1?action=getAccounts',{headers})).json();assert.equal(data.data[0].bank,'合成銀行');
  assert.equal(data.data[0].branch,'合成支店');assert.equal(data.data[0].accountNumber,'0012345');assert.ok(!Object.hasOwn(data.data[0],'name'));
  const edit=await request('/api/v1',{method:'POST',headers,body:JSON.stringify({...account,branch:'第二支店',accountNumber:'0009876',expectedUpdatedAt:data.data[0].updatedAt})});assert.equal(edit.status,200);
  const edited=await(await request('/api/v1?action=getAccounts',{headers})).json();assert.equal(edited.data[0].branch,'第二支店');assert.equal(edited.data[0].accountNumber,'0009876');
  for(const route of ['/src/storage.cjs','/.env','/var/data/cashflow.sqlite','/assets/../package.json'])assert.equal((await request(route,{headers})).status,404);
  const page=await request('/',{headers});assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const scheduled={action:'scheduleSave',requestId:'http-schedule',id:'http-s',name:'合成定期支出',partner:'合成先',kind:'other',account:'a',holidayRule:'none',rows:[{id:'http-row',nominalDate:'2027-01-31',plannedAmount:100}]};
  assert.equal((await request('/api/v1?action=getPaymentSchedules')).status,401);
  assert.equal((await request('/api/v1',{method:'POST',headers:{...headers,'X-CSRF-Token':'invalid'},body:JSON.stringify(scheduled)})).status,403);
  assert.equal((await request('/api/v1',{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:JSON.stringify(scheduled)})).status,403);
  const scheduleResult=await request('/api/v1',{method:'POST',headers,body:JSON.stringify(scheduled)});assert.equal(scheduleResult.status,200);assert.equal((await scheduleResult.json()).success,true);
  const schedules=await(await request('/api/v1?action=getPaymentSchedules',{headers})).json();assert.equal(schedules.data[0].occurrences[0].legs.length,1);
  for(const route of ['/assets/schedules.js','/assets/schedule-input.js'])assert.equal((await request(route,{headers})).status,200);
  assert.equal((await request('/auth/logout',{method:'POST',headers,body:'{}'})).status,200);assert.equal((await request('/api/v1?action=getAccounts',{headers})).status,401);
});
