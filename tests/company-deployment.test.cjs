'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{randomBytes}=require('node:crypto');
const root=process.env.CASHFLOW_SOURCE||path.resolve(__dirname,'..');
const {openStore}=require(root+'/src/storage.cjs'),{createAdmin}=require(root+'/src/auth.cjs'),{createApplication}=require(root+'/src/server.cjs'),{createBackup}=require(root+'/src/backup.cjs'),{restore}=require(root+'/tools/restore.cjs');
test('company deployment: empty DB, tenant branding, login, account, daily period and backup restore',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'company-smoke-')),file=path.join(dir,'db.sqlite'),store=openStore(file),origin='https://tootwo-cash.wellzfriend.com';
 const app=await createApplication({store,origin,companyName:'TOOTWO資金繰り',today:()=> '2026-10-08'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=(route,body,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:route,method:body?'POST':'GET',headers:{Host:'tootwo-cash.wellzfriend.com',...(body?{'Content-Type':'application/json',Origin:origin}:{}),...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 assert.equal((await request('/healthz')).status,200);const page=await request('/login.html');assert.match(page.text,/TOOTWO資金繰り/);assert.doesNotMatch(page.text,/ウェルノット|とらいアンぐる|\{\{APP_COMPANY_NAME/);
 for(const table of ['users','accounts','cashflow_transactions','receivables','payables','fixed_expenses','payment_schedules'])assert.equal(store.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
 const password=randomBytes(24).toString('hex');await createAdmin(store,'synthetic-admin',password);
 const login=await request('/auth/login',{username:'synthetic-admin',password});assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/; Secure/);
 const h={Cookie:login.headers['set-cookie'][0].split(';')[0],'X-CSRF-Token':JSON.parse(login.text).csrf};
 assert.equal(store.db.prepare('SELECT role FROM users').get().role,'admin');assert.match((await request('/',null,h)).text,/<title>TOOTWO資金繰り<\/title>/);
 assert.equal(JSON.parse((await request('/api/v1?action=getSettings',null,h)).text).companyName,'TOOTWO資金繰り');
 const account=await request('/api/v1',{action:'saveAccount',id:'synthetic-a',bank:'合成銀行',type:'普通',balance:1000,balanceDate:'2026-10-07'},h);assert.equal(account.status,200);
 assert.equal(JSON.parse((await request('/api/v1?action=getAccounts',null,h)).text).data.length,1);
 const daily=await request('/api/v1?action=getCashflowPeriod&start=2026-10&end=2026-10&accounts=synthetic-a&mode=predict&day=2026-10-08',null,h);assert.equal(daily.status,200);assert.equal(JSON.parse(daily.text).periods[0].totals['synthetic-a'].closing,1000);
 const m=await createBackup({databasePath:file,backupDir:path.join(dir,'backup'),statusDir:path.join(dir,'status')});const target=path.join(dir,'restore.sqlite');await restore(path.join(dir,'backup',m.id+'.manifest.json'),target);const restored=openStore(target);try{assert.deepEqual(restored.all('accounts'),store.all('accounts'));assert.equal(restored.db.prepare('SELECT count(*) n FROM users').get().n,1);}finally{restored.close();}
});
test('company display escapes HTML configuration',async t=>{
 const store=openStore(':memory:'),app=await createApplication({store,origin:'http://127.0.0.1:3310',companyName:'<Company & "Name">'});await new Promise(r=>app.server.listen(3310,'127.0.0.1',r));t.after(async()=>{await app.close();store.close();});
 const text=await(await fetch('http://127.0.0.1:3310/login.html')).text();assert.match(text,/&lt;Company &amp; &quot;Name&quot;&gt;/);assert.doesNotMatch(text,/<Company/);
});
