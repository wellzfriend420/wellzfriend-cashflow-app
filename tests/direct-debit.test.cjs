'use strict';
process.env.TZ='Asia/Tokyo';
const {test,afterEach}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {openStore}=require('../src/storage.cjs'),createLedger=require('../src/domain/ledger.cjs');
const {createNotifications,clock}=require('../src/direct-debit.cjs');
const {createBackup}=require('../src/backup.cjs'),{restore}=require('../tools/restore.cjs');
const active=[];afterEach(()=>{for(const b of active.splice(0)){b.store.close();fs.rmSync(b.dir,{recursive:true,force:true});}});
function setup(options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'debit-test-')),file=path.join(dir,'db.sqlite'),store=openStore(file);
 let time='2026-10-14T01:00:00Z';const now=()=>new Date(time),ledger=createLedger(store,{today:()=>clock(now()).day});
 const config={allowed:true,target:'U'+'1'.repeat(32),origin:'https://synthetic.example',companyName:'合成会社',now,...options};
 const notify=createNotifications(store,ledger,config),b={dir,file,store,ledger,notify,config,time:t=>time=t};active.push(b);
 for(const id of ['a','b'])ledger.post({action:'saveAccount',id,bank:id==='a'?'合成銀行':'試験銀行',branch:'試験支店',type:'普通',balance:0,balanceDate:'2026-01-01'});
 return b;
}
function manual(b,id,extra={}){b.ledger.post({action:'saveTransaction',id,source:'manual',type:'出金',status:'予定',account:'a',partner:'試験相手',description:id,plannedDate:'2026-10-15',plannedAmount:100,...extra});}
function choose(b,selected,enabled=true){b.notify.save({enabled,selected,version:b.notify.settings().version},'test');}
function fixed(b,id,day,holidayRule='none'){b.ledger.post({action:'saveFixedExpense',id,name:'合成固定費',payee:'合成先',account:'a',amount:41800,day,holidayRule,startMonth:'2026-10',endMonth:'2026-11'});}
function schedule(b,mode='split'){
 b.ledger.post({action:'scheduleSave',requestId:randomUUID(),id:'s',name:'合成借入',kind:'loan',account:'b',partner:'合成先',holidayRule:'next',defaultDebitMode:mode,principalStartMode:'existing',principalBalanceDate:'2026-09-30',principalOpeningBalance:1000000,rows:[{id:'r',nominalDate:'2026-10-17',plannedPrincipal:10000,plannedInterest:1000}]});
 return b.ledger.get('getPaymentSchedules',{id:'s'}).data[0];
}
test('JST 10:00 gate, UTC date boundary, leap day/year end',()=>{
 assert.deepEqual(clock(new Date('2026-10-13T15:00:00Z')),{day:'2026-10-14',hour:0,tomorrow:'2026-10-15'});
 assert.equal(clock(new Date('2028-02-28T01:00:00Z')).tomorrow,'2028-02-29');
 assert.equal(clock(new Date('2026-12-31T01:00:00Z')).tomorrow,'2027-01-01');
 const b=setup();manual(b,'t');choose(b,['transaction:t']);b.time('2026-10-14T00:59:59Z');assert.equal(b.notify.prepare().reason,'before_10_jst');b.time('2026-10-14T01:00:00Z');assert.equal(b.notify.prepare().send,true);
});
test('default OFF and deployment OFF make no batch; tenant isolation',()=>{
 const b=setup();manual(b,'t');assert.equal(b.notify.prepare().reason,'disabled');choose(b,['transaction:t']);
 assert.equal(createNotifications(b.store,b.ledger,{...b.config,allowed:false}).prepare().reason,'disabled');
 const other=setup();assert.equal(other.notify.settings().selected.length,0);assert.equal(other.notify.prepare().reason,'disabled');
});
test('explicit selection only; one text with total and account totals; unchanged business data',()=>{
 const b=setup();manual(b,'lease',{plannedAmount:41800});manual(b,'insurance',{account:'b',plannedAmount:11640});manual(b,'unselected');manual(b,'income',{type:'入金'});manual(b,'late',{plannedDate:'2026-09-01'});manual(b,'done',{status:'確定',actualDate:'2026-10-14',actualAmount:100});manual(b,'cancelled',{status:'取消'});
 choose(b,['transaction:lease','transaction:insurance','transaction:late']);
 const before=JSON.stringify(b.store.all('cashflow_transactions')),batch=b.notify.prepare();
 assert.equal(batch.count,2);assert.equal(batch.payload.messages.length,1);assert.match(batch.payload.messages[0].text,/53,440円/);assert.match(batch.payload.messages[0].text,/合成銀行 試験支店：41,800円/);assert.doesNotMatch(batch.payload.messages[0].text,/unselected|income|late|done|cancelled/);
 assert.equal(JSON.stringify(b.store.all('cashflow_transactions')),before);
});
test('fixed expense holiday next, previous month boundary, explicit change and cancellation',()=>{
 const b=setup();fixed(b,'next',17,'next');fixed(b,'previous',1,'previous');choose(b,['fixed:next','fixed:previous']);
 assert.equal(b.notify.collect('2026-10-17').count,0);assert.equal(b.notify.collect('2026-10-19').count,1);assert.equal(b.notify.collect('2026-10-30').count,1);
 b.time('2026-10-20T01:00:00Z');let t=b.store.find('cashflow_transactions','fx_next_202610');
 b.ledger.post({action:'resolveOverdue',id:t.id,requestId:randomUUID(),operation:'reschedule',date:'2026-10-22',expectedUpdatedAt:t.updatedAt});
 assert.equal(b.notify.collect('2026-10-19').count,0);assert.equal(b.notify.collect('2026-10-22').count,1);
 t=b.store.find('cashflow_transactions','fx_next_202610');b.time('2026-10-23T01:00:00Z');b.ledger.post({action:'resolveOverdue',id:t.id,requestId:randomUUID(),operation:'cancel',expectedUpdatedAt:t.updatedAt});b.ledger.replenish();assert.equal(b.notify.collect('2026-10-22').count,0);
});
test('loan split/combined and partial confirmation include only unpaid legs',()=>{
 const b=setup();let m=schedule(b);choose(b,['schedule:s']);assert.equal(b.notify.collect('2026-10-17').count,0);assert.equal(b.notify.collect('2026-10-19').total,11000);
 const principal=m.occurrences[0].legs.find(l=>l.component==='principal');b.time('2026-10-19T01:00:00Z');
 b.ledger.post({action:'scheduleConfirm',requestId:randomUUID(),id:principal.id,expectedVersion:m.version,actualDate:'2026-10-19',actualPrincipal:10000,actualInterest:0,settled:true});
 assert.equal(b.notify.collect('2026-10-19').count,1);assert.equal(b.notify.collect('2026-10-19').total,1000);
 m=b.ledger.get('getPaymentSchedules',{id:'s'}).data[0];assert.equal(m.principalRemaining,990000);
 const c=setup();schedule(c,'combined');choose(c,['schedule:s']);assert.equal(c.notify.collect('2026-10-19').count,1);assert.equal(c.notify.collect('2026-10-19').total,11000);
});
test('variable payment schedule cancellation excludes old revision and cancelled occurrences',()=>{
 const b=setup();b.ledger.post({action:'scheduleSave',requestId:randomUUID(),id:'s',name:'合成リース',kind:'lease',account:'a',partner:'合成先',holidayRule:'none',rows:[{id:'r',nominalDate:'2026-10-15',plannedAmount:11640}]});choose(b,['schedule:s']);assert.equal(b.notify.collect('2026-10-15').total,11640);
 const m=b.ledger.get('getPaymentSchedules',{id:'s'}).data[0];b.ledger.post({action:'scheduleCancel',requestId:randomUUID(),id:'r',expectedVersion:m.version});assert.equal(b.notify.collect('2026-10-15').count,0);
});
test('payables notify outstanding amount and exclude cancelled remainder',()=>{
 const b=setup();b.ledger.post({action:'savePayable',id:'p',partner:'合成先',account:'a',occDate:'2026-10-01',amount:1000,dueDate:'2026-10-15'});choose(b,['transaction:cf_p']);
 const p=b.store.find('payables','p');b.ledger.post({action:'confirmPayable',id:'p',paymentId:'p1',expectedUpdatedAt:p.updatedAt,date:'2026-10-14',amount:400,account:'a'});assert.equal(b.notify.collect('2026-10-15').total,600);
 b.time('2026-10-16T01:00:00Z');const t=b.store.find('cashflow_transactions','cf_p');b.ledger.post({action:'resolveOverdue',id:t.id,requestId:randomUUID(),operation:'cancel',expectedUpdatedAt:t.updatedAt});assert.equal(b.notify.collect('2026-10-15').count,0);
});
test('same-day retry, another connection, send acknowledgement, no second message after edits',()=>{
 const b=setup();manual(b,'t');choose(b,['transaction:t']);const batch=b.notify.prepare();assert.deepEqual(b.notify.prepare(),batch);
 const second=openStore(b.file);try{assert.deepEqual(createNotifications(second,createLedger(second),b.config).prepare(),batch);}finally{second.close();}
 manual(b,'new');choose(b,['transaction:t','transaction:new']);assert.deepEqual(b.notify.prepare(),batch);
 assert.throws(()=>b.notify.acknowledge({day:batch.day,retryKey:'wrong',requestId:'r'}));
 const ack={day:batch.day,retryKey:batch.retryKey,requestId:'test-receipt'};b.notify.acknowledge(ack);b.notify.acknowledge(ack);assert.equal(b.notify.prepare().reason,'sent');
 b.time('2026-10-15T01:00:00Z');assert.throws(()=>b.notify.acknowledge(ack));assert.equal(b.notify.prepare().reason,'empty');
});
test('empty day sealed, invalid recipient blocked, stale settings rejected, OFF suppresses pending',()=>{
 const b=setup();choose(b,[]);assert.equal(b.notify.prepare().reason,'empty');manual(b,'t');choose(b,['transaction:t']);assert.equal(b.notify.prepare().reason,'empty');
 assert.throws(()=>b.notify.save({enabled:true,selected:[],version:0},'test'));
 assert.throws(()=>b.notify.save({enabled:true,selected:['transaction:missing'],version:b.notify.settings().version},'test'));
 const c=setup({target:''});manual(c,'t');choose(c,['transaction:t']);assert.throws(()=>c.notify.prepare(),/送信先/);
 const d=setup();manual(d,'t');choose(d,['transaction:t']);d.notify.prepare();choose(d,['transaction:t'],false);assert.equal(d.notify.prepare().reason,'disabled');
});
test('long digest remains one message, precise total; integer overflow refuses send',()=>{
 const b=setup();for(let i=0;i<100;i++)manual(b,'t'+i,{description:'合成名称'.repeat(40)});choose(b,Array.from({length:100},(_,i)=>'transaction:t'+i));const batch=b.notify.prepare();assert.equal(batch.count,100);assert.equal(batch.payload.messages.length,1);assert.ok(batch.payload.messages[0].text.length<=5000);assert.match(batch.payload.messages[0].text,/ほか.*件/);assert.match(batch.payload.messages[0].text,/10,000円/);
 const c=setup();manual(c,'a',{plannedAmount:Number.MAX_SAFE_INTEGER});manual(c,'b');choose(c,['transaction:a','transaction:b']);assert.throws(()=>c.notify.prepare(),/金額/);
});
test('backup and restore preserve setting and dedupe receipt without schema change',async()=>{
 const b=setup();manual(b,'t');choose(b,['transaction:t']);const batch=b.notify.prepare();b.notify.acknowledge({day:batch.day,retryKey:batch.retryKey,requestId:'receipt'});
 const m=await createBackup({databasePath:b.file,backupDir:path.join(b.dir,'backup'),statusDir:path.join(b.dir,'status')});const dest=path.join(b.dir,'restored.sqlite');await restore(path.join(b.dir,'backup',m.id+'.manifest.json'),dest);const restored=openStore(dest);
 try{const n=createNotifications(restored,createLedger(restored),b.config);assert.equal(n.prepare().reason,'sent');assert.deepEqual(restored.all('cashflow_transactions'),b.store.all('cashflow_transactions'));assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version,4);}finally{restored.close();}
});
test('n8n template 10 JST, inactive, one push, expiry guard, 200/409 receipts and failure isolation',()=>{
 const w=require('../deployment/n8n-direct-debit.json');assert.equal(w.active,false);assert.equal(w.settings.timezone,'Asia/Tokyo');assert.equal(w.nodes[0].parameters.rule.interval[0].expression,'0 0 10 * * *');assert.equal(w.nodes.filter(n=>n.parameters.url==='https://api.line.me/v2/bot/message/push').length,1);
 const get=name=>w.nodes.find(n=>n.name===name).parameters.jsCode;
 const execute=(code,input,batch)=>vm.runInNewContext('(function(){'+code+'})()',{Date,$input:{first:()=>({json:input})},$:()=>({first:()=>({json:batch})})});
 assert.equal(execute(get('Only pending today'),{send:false}).length,0);assert.throws(()=>execute(get('Only pending today'),{send:true,expiresAt:'2000-01-01'}),/expired/);
 const batch={day:'2026-10-14',retryKey:'key'};
 assert.equal(execute(get('Verify LINE accepted'),{statusCode:200,headers:{'x-line-request-id':'ok'}},batch)[0].json.requestId,'ok');assert.equal(execute(get('Verify LINE accepted'),{statusCode:409,headers:{'x-line-accepted-request-id':'first'}},batch)[0].json.requestId,'first');
 for(const statusCode of [400,401,409,429,500])assert.throws(()=>execute(get('Verify LINE accepted'),{statusCode,headers:{}},batch),/not accepted/);
});
test('HTTP notification endpoints require dedicated token, admin UI requires session and CSRF',async t=>{
 const {createApplication}=require('../src/server.cjs'),{createAdmin}=require('../src/auth.cjs');const b=setup(),token='x'.repeat(40),origin='https://synthetic.example';
 const app=await createApplication({store:b.store,origin,notifications:{allowed:true,token,target:b.config.target,now:()=>new Date('2026-10-14T01:00:00Z')},today:()=> '2026-10-14'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 try{
 const request=(route,body,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:route,method:body?'POST':'GET',headers:{Host:'synthetic.example','Content-Type':'application/json',...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(text)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 assert.equal((await request('/integrations/direct-debit/prepare',{})).status,401);assert.equal((await request('/integrations/direct-debit/prepare',{}, {Authorization:'Bearer wrong'})).status,401);
 assert.equal((await request('/integrations/direct-debit/prepare',{}, {Authorization:'Bearer '+token})).data.reason,'disabled');
 assert.equal((await request('/api/v1?action=getDirectDebitNotification')).status,401);
 await createAdmin(b.store,'test-admin','Synthetic-password-123456');const login=await request('/auth/login',{username:'test-admin',password:'Synthetic-password-123456'},{Origin:origin});assert.equal(login.status,200);const h={Origin:origin,Cookie:login.headers['set-cookie'][0].split(';')[0]};
 manual(b,'http-test');const body={action:'saveDirectDebitNotification',enabled:true,selected:['transaction:http-test'],version:0};assert.equal((await request('/api/v1',body,h)).status,403);h['X-CSRF-Token']=login.data.csrf;assert.equal((await request('/api/v1',body,h)).status,200);
 const settings=await request('/api/v1?action=getDirectDebitNotification',null,h);assert.equal(settings.data.enabled,true);assert.ok(!JSON.stringify(settings.data).includes(token));assert.ok(!JSON.stringify(settings.data).includes(b.config.target));
 const machine={Authorization:'Bearer '+token};const batch=(await request('/integrations/direct-debit/prepare',{},machine)).data;assert.equal(batch.send,true);assert.equal(batch.count,1);
 assert.equal((await request('/integrations/direct-debit/ack',{day:batch.day,retryKey:batch.retryKey,requestId:'synthetic-receipt'},machine)).status,200);assert.equal((await request('/integrations/direct-debit/prepare',{},machine)).data.reason,'sent');
 }finally{await app.close();}
});
test('disabled integration is inaccessible and enabled integration rejects weak credentials',async()=>{
 const {createApplication}=require('../src/server.cjs'),b=setup();
 await assert.rejects(createApplication({store:b.store,origin:'https://synthetic.example',notifications:{allowed:true,token:'short'}}),/strong token/);
 const app=await createApplication({store:b.store,origin:'http://127.0.0.1:3310',notifications:{allowed:false}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 try{const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:'/integrations/direct-debit/prepare',method:'POST',headers:{Host:'127.0.0.1:3310','Content-Type':'application/json'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});req.on('error',reject);req.end('{}');});assert.equal(status,404);}finally{await app.close();}
});
