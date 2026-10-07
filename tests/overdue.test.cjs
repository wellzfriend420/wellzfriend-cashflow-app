'use strict';
process.env.TZ='Asia/Tokyo';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto'),{openStore}=require('../src/storage.cjs'),createLedger=require('../src/domain/ledger.cjs'),math=require('../assets/cashflow-math.js');
const {createBackup,inspectSnapshot}=require('../src/backup.cjs'),{restore}=require('../tools/restore.cjs'),{createFrontend}=require('./helpers.cjs');
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'triangle-overdue-')),store=openStore(path.join(dir,'test.sqlite'));let day='2026-10-07';const api=createLedger(store,{today:()=>day});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 api.post({action:'saveAccount',id:'a',bank:'合成銀行',type:'普通',balance:1000000,balanceDate:'2026-07-31'});
 return {dir,store,api,setDay:d=>day=d,post:b=>api.post(b),tx:id=>store.find('cashflow_transactions',id),over:()=>api.get('getOverdue'),period:(month,mode='predict')=>api.get('getCashflowPeriod',{start:month,end:month,accounts:'a',mode,day}).periods[0]};
}
function manual(b,id='out',more={}){b.post({action:'saveTransaction',id,type:'出金',account:'a',plannedDate:'2026-08-31',plannedAmount:100000,...more});return b.tx(id);}
function fixed(b){b.post({action:'saveFixedExpense',id:'rent',name:'家賃',payee:'合成先',amount:100000,day:31,startMonth:'2026-08',endMonth:'2026-11',account:'a',holidayRule:'none',scope:'all'});return b.tx('fx_rent_202608');}
function debt(b,kind){b.post({action:kind==='receivable'?'saveReceivable':'savePayable',id:'debt',partner:'合成先',invoiceDate:'2026-08-01',occDate:'2026-08-01',dueDate:'2026-08-31',amount:100000,account:'a'});return b.tx('cf_debt');}
function schedule(b,kind='loan',mode='split'){
 b.post({action:'scheduleSave',requestId:randomUUID(),id:'s',kind,name:'合成予定',partner:'合成先',account:'a',holidayRule:'none',defaultDebitMode:mode,principalStartMode:'existing',principalBalanceDate:'2026-07-31',principalOpeningBalance:1000000,rows:[{id:'o',nominalDate:'2026-08-31',plannedPrincipal:100000,plannedInterest:10000,plannedAmount:100000}]});
 return b.over().data;
}
function request(b,id,operation,more={}){const t=b.over().data.find(t=>t.id===id);assert.ok(t);return {action:'resolveOverdue',id,operation,requestId:randomUUID(),expectedUpdatedAt:t.updatedAt,expectedVersion:t.schedule?.version,settled:true,...more};}
function resolve(b,id,operation,more={}){return b.post(request(b,id,operation,more));}
test('accepted numerical example: base 800000, all-overdue reference 750000, historical rows remain historical',t=>{
 const b=setup(t);manual(b);manual(b,'in',{type:'入金',plannedDate:'2026-09-15',plannedAmount:50000});manual(b,'future',{plannedDate:'2026-10-20',plannedAmount:200000});
 assert.deepEqual(b.over().income,{count:1,amount:50000});assert.deepEqual(b.over().expense,{count:1,amount:100000});
 for(const mode of ['predict','diff']){const p=b.period('2026-10',mode);assert.equal(p.totals.a.closing,800000);assert.equal(p.totals.a.reference,750000);assert.deepEqual(p.rows.map(t=>t.id),['future']);}
 assert.equal(b.period('2026-08').rows[0].cashDate,'2026-08-31');assert.equal(b.period('2026-08').rows[0].balanceAmount,0);assert.equal(b.period('2026-08').totals.a.closing,1000000);assert.equal(b.period('2026-09').totals.a.reference,null);assert.equal(b.period('2026-11').totals.a.opening,800000);assert.equal(b.period('2026-10','actual').totals.a.reference,null);
});
test('reads, repeat review and exports perform no business writes and do not dismiss warning',t=>{
 const b=setup(t);manual(b);schedule(b);const before=b.store.db.prepare('SELECT total_changes() n').get().n;
 const original=b.over();b.over();b.period('2026-08');b.period('2027-01');assert.deepEqual(b.over(),original);assert.equal(b.store.db.prepare('SELECT total_changes() n').get().n,before);
});
for(const kind of ['manual','fixed','receivable','payable','variable','combined','split'])for(const op of ['scheduled','actual','reschedule','cancel'])test(kind+' overdue '+op+' preserves original data and related records',t=>{
 const b=setup(t);let row;
 if(kind==='manual')row=manual(b);else if(kind==='fixed')row=fixed(b);else if(['receivable','payable'].includes(kind))row=debt(b,kind);else row=schedule(b,kind==='variable'?'lease':'loan',kind==='combined'?'combined':'split')[0];
 const id=row.id,original=row.plannedDate;
 resolve(b,id,op,{date:op==='reschedule'?'2026-11-02':'2026-09-01',amount:90000,actualPrincipal:90000,actualInterest:9000});
 const after=b.tx(id);
 if(op==='reschedule'){assert.equal(after.plannedDate,'2026-11-02');assert.equal(after.actualDate,null);}
 else assert.equal(after.plannedDate,original);
 if(op==='cancel')assert.equal(after.status,'取消');
 if(['scheduled','actual'].includes(op)&&!['receivable','payable'].includes(kind))assert.equal(after.actualDate,op==='scheduled'?original:'2026-09-01');
 if(['receivable','payable'].includes(kind)){
  const parent=b.store.find(kind==='receivable'?'receivables':'payables','debt');
  if(op==='reschedule')assert.equal(parent.dueDate,'2026-11-02');
  if(op==='cancel'){assert.equal(parent.paidAmount,0);assert.equal(parent.status,'取消');}
  if(['scheduled','actual'].includes(op)){assert.equal(parent.paidAmount,op==='scheduled'?100000:90000);const p=b.store.all('cashflow_transactions').find(t=>t.source===kind+'_payment');assert.equal(p.actualDate,op==='scheduled'?'2026-08-31':'2026-09-01');}
 }
 assert.equal(JSON.parse(b.store.setting('pending_history_'+id))[0].before.plannedDate,original);
 require('../src/domain/schedules.cjs').checkIntegrity(b.store.db);inspectSnapshot(b.store.filename);
});
test('fixed single override and cancellation survive master update, replenishment and read projection',t=>{
 const b=setup(t),row=fixed(b);resolve(b,row.id,'reschedule',{date:'2026-11-02'});resolve(b,'fx_rent_202609','cancel');
 const m=b.store.find('fixed_expenses','rent');b.post({action:'saveFixedExpense',...m,amount:200000,expectedUpdatedAt:m.updatedAt,scope:'all'});b.api.replenish();b.api.replenish();
 assert.equal(b.tx(row.id).plannedDate,'2026-11-02');assert.equal(b.tx(row.id).plannedAmount,100000);assert.equal(b.tx('fx_rent_202609').status,'取消');assert.equal(b.store.all('cashflow_transactions').filter(t=>t.id===row.id).length,1);
});
test('loan split keeps confirmed principal when interest is rescheduled or cancelled',t=>{
 const b=setup(t),rows=schedule(b),principal=rows.find(t=>t.description.endsWith('元本')),interest=rows.find(t=>t.description.endsWith('利息'));
 resolve(b,principal.id,'scheduled');resolve(b,interest.id,'reschedule',{date:'2026-09-02'});resolve(b,interest.id,'cancel');
 const m=b.api.get('getPaymentSchedules').data[0];assert.equal(m.principalRemaining,900000);assert.equal(m.interestPaid,0);assert.equal(m.occurrences[0].status,'一部支払・残予定取消');assert.equal(b.tx(principal.id).actualDate,'2026-08-31');
});
test('schedule parent save cannot undo a single date override',t=>{
 const b=setup(t),row=schedule(b,'lease')[0];resolve(b,row.id,'reschedule',{date:'2026-11-02'});
 const m=b.api.get('getPaymentSchedules').data[0];b.post({action:'scheduleSave',...m,requestId:randomUUID(),expectedVersion:m.version,rows:m.occurrences});assert.equal(b.tx(row.id).plannedDate,'2026-11-02');
});
test('partial debt cancellation retains paid amount, rejects later accidental parent save or payment',t=>{
 const b=setup(t),row=debt(b,'payable');resolve(b,row.id,'actual',{date:'2026-09-01',amount:40000});resolve(b,row.id,'cancel');
 const d=b.store.find('payables','debt');assert.equal(d.amount,100000);assert.equal(d.paidAmount,40000);assert.equal(b.tx(row.id).plannedAmount,60000);assert.equal(b.over().expense.count,0);
 assert.throws(()=>b.post({action:'savePayable',...d,expectedUpdatedAt:d.updatedAt}),/取消/);assert.throws(()=>b.post({action:'confirmPayable',id:d.id,paymentId:randomUUID(),date:'2026-09-01',amount:1,account:'a',expectedUpdatedAt:d.updatedAt}),/取消/);
});
test('stale input, retries, invalid dates and missing explicit operation are safe',t=>{
 const b=setup(t);manual(b);const p=request(b,'out','scheduled');b.post(p);assert.equal(b.post(p).duplicate,true);assert.throws(()=>b.post({...p,amount:1}),/再送/);assert.equal(b.store.all('cashflow_transactions').length,1);
 manual(b,'other');for(const extra of [{operation:'actual',date:''},{operation:'actual',date:'2026-10-08',amount:1},{operation:'reschedule',date:'2026-02-30'},{operation:'leave'},{expectedUpdatedAt:'stale'}])assert.throws(()=>b.post({...request(b,'other','scheduled'),...extra}));assert.equal(b.tx('other').actualDate,null);
});
test('account and loan baseline require acknowledgement before historical confirmation',t=>{
 const b=setup(t);manual(b,'old',{plannedDate:'2026-07-31'});assert.throws(()=>resolve(b,'old','scheduled'),/基準/);resolve(b,'old','scheduled',{acknowledgeBaseline:true});assert.equal(b.period('2026-10').totals.a.closing,1000000);
});
test('zero actual, today boundary, account filter and unsafe aggregation',t=>{
 const b=setup(t);manual(b);resolve(b,'out','actual',{date:'2026-08-31',amount:0});assert.equal(b.over().data.length,0);manual(b,'today',{plannedDate:'2026-10-07'});assert.equal(b.over().data.length,0);assert.equal(b.period('2026-10').totals.a.closing,900000);b.setDay('2026-10-08');assert.equal(b.over().data.length,1);assert.equal(b.period('2026-10').totals.a.closing,1000000);
 assert.equal(math.overdue(b.store.all('cashflow_transactions'),['other'],'2026-10-08').data.length,0);assert.throws(()=>math.overdue([{id:'x',account:'a',plannedDate:'2026-01-01',plannedAmount:NaN,type:'出金'}],['a'],'2026-10-07'),/金額/);
});
test('screen and real XLSX preserve historical amount but exclude it from running balance',t=>{
 const b=setup(t);manual(b);const f=createFrontend();f.app.accounts=b.store.all('accounts');f.app.currentMonthData=b.store.all('cashflow_transactions');f.app.currentMonth='2026-08';f.run("today=parseDate('2026-10-07')");f.context.XLSX=require('../assets/vendor/xlsx.full.min.js');
 f.context.renderCashflowTable();assert.equal(f.node('monthCloseBalance').textContent,'1,000,000円');assert.match(f.node('cashflowTableBody').innerHTML,/期限超過・基本予測対象外/);
 const wb=f.context.XLSX.utils.book_new();f.context.XLSX.utils.book_append_sheet(wb,f.context.cashflowSheet(b.period('2026-08'),f.app.accounts,'predict'),'test');const x=f.context.XLSX.read(f.context.XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});const data=f.context.XLSX.utils.sheet_to_json(x.Sheets.test,{header:1});assert.equal(data[2][0],'2026/08/31');assert.equal(data[2][5],-100000);assert.equal(data[2][6],1000000);assert.equal(data.at(-1)[6],1000000);
});
test('overdue UI warning, explicit choice and blank actual date; leaving unresolved does not write',async t=>{
 const b=setup(t);manual(b);const f=createFrontend();f.app.accounts=b.store.all('accounts');f.run("today=parseDate('2026-10-07')");let posts=0;f.context.gasApi=async()=>b.over();f.context.gasPost=async()=>{posts++;};let html='';f.context.showModal=x=>html=x;
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/overdue.js'),'utf8'),f.context);f.run("Overdue.banner('homeOverdue',APP.currentMonthData= "+JSON.stringify(b.store.all('cashflow_transactions'))+",APP.accounts,800000)");assert.match(f.node('homeOverdue').innerHTML,/出金 1件／100,000円/);await f.run('Overdue.open()');f.run('Overdue.choose(0)');assert.match(html,/予定どおりの日付・金額/);assert.match(html,/未確定のまま残す/);f.run("Overdue.form(0,'actual')");assert.match(html,/id="odDate" type="date" value=""/);await f.run('Overdue.open()');assert.equal(posts,0);
});
test('backup and restoration preserve overrides, cancellations, forecast and schema version without migration',async t=>{
 const b=setup(t);const row=fixed(b);resolve(b,row.id,'reschedule',{date:'2026-11-02'});resolve(b,'fx_rent_202609','cancel');debt(b,'payable');resolve(b,'cf_debt','cancel');schedule(b);const original=b.over();const backupDir=path.join(b.dir,'backup');const manifest=await createBackup({databasePath:b.store.filename,backupDir,statusDir:path.join(b.dir,'status')});const target=path.join(b.dir,'restore.sqlite');await restore(path.join(backupDir,manifest.id+'.manifest.json'),target);const restored=openStore(target);try{const api=createLedger(restored,{today:()=> '2026-10-07'});assert.deepEqual(api.get('getOverdue'),original);api.replenish();assert.equal(restored.find('cashflow_transactions',row.id).plannedDate,'2026-11-02');assert.equal(restored.find('cashflow_transactions','cf_debt').status,'取消');assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version,4);inspectSnapshot(target);}finally{restored.close();}
});
for(const kind of ['manual','fixed','receivable','payable','variable','combined','split'])test('UI submits explicit actual date through authenticated API: '+kind,async t=>{
 const b=setup(t);let row;if(kind==='manual')row=manual(b);else if(kind==='fixed')row=fixed(b);else if(['receivable','payable'].includes(kind))row=debt(b,kind);else row=schedule(b,kind==='variable'?'lease':'loan',kind==='combined'?'combined':'split')[0];
 const f=createFrontend({get:b.api.get,post:b.post});f.context.crypto={randomUUID};f.app.accounts=b.store.all('accounts');f.app.currentPage='settings';f.run("today=parseDate('2026-10-07')");f.context.showModal=()=>{};
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/overdue.js'),'utf8'),f.context);await f.run('Overdue.open()');const index=b.over().data.findIndex(t=>t.id===row.id);f.run(`Overdue.form(${index},'actual')`);
 f.node('odDate').value='2026-09-01';f.node('odAmount').value='90000';f.node('odPrincipal').value='90000';f.node('odInterest').value='9000';f.node('odSettled').checked=true;
 await f.run(`Overdue.submit(${index},'actual')`);assert.equal(f.node('odError').textContent,'');const tx=b.store.all('cashflow_transactions').find(t=>t.actualDate==='2026-09-01');assert.ok(tx);assert.equal(tx.plannedDate===null||tx.plannedDate==='2026-08-31',true);
});
test('read projection covers missing overdue fixed rows even while viewing earlier month',t=>{
 const b=setup(t);fixed(b);b.store.db.prepare("DELETE FROM cashflow_transactions WHERE id='fx_rent_202609'").run();const before=b.store.db.prepare('SELECT total_changes() n').get().n;
 const rows=b.api.get('getTransactions',{all:'true',through:'2026-08'}).data;assert.ok(rows.some(t=>t.id==='fx_rent_202609'&&t.virtual));assert.equal(b.store.db.prepare('SELECT total_changes() n').get().n,before);
 resolve(b,'fx_rent_202609','cancel');b.api.replenish();assert.equal(b.tx('fx_rent_202609').status,'取消');
});
test('reopening a historical actual restores overdue warning without moving its date',t=>{
 const b=setup(t);b.store.db.exec("INSERT INTO users VALUES('admin','合成管理者','test-only','admin','2026-01-01')");manual(b);resolve(b,'out','scheduled');let row=b.tx('out');
 b.api.post({action:'reopenActual',id:row.id,requestId:randomUUID(),expectedUpdatedAt:row.updatedAt,reason:'合成検証',confirmed:true},'admin');assert.equal(b.over().data[0].plannedDate,'2026-08-31');assert.equal(b.period('2026-10').totals.a.closing,1000000);assert.throws(()=>resolve(b,'out','reschedule',{date:'2026-11-01'}),/履歴/);resolve(b,'out','scheduled');assert.equal(b.tx('out').actualDate,'2026-08-31');
});
test('payment correction after cancelling residual does not revive cancelled debt',t=>{
 const b=setup(t);b.store.db.exec("INSERT INTO users VALUES('admin','合成管理者','test-only','admin','2026-01-01')");debt(b,'payable');resolve(b,'cf_debt','actual',{date:'2026-09-01',amount:40000});resolve(b,'cf_debt','cancel');const payment=b.store.all('cashflow_transactions').find(t=>t.source==='payable_payment'),d=b.store.find('payables','debt');
 b.api.post({action:'cancelActual',id:payment.id,requestId:randomUUID(),expectedUpdatedAt:payment.updatedAt,expectedParentVersion:d.updatedAt,reason:'合成検証',confirmed:true},'admin');assert.equal(b.store.find('payables','debt').paidAmount,0);assert.equal(b.store.find('payables','debt').status,'取消');assert.equal(b.tx('cf_debt').status,'取消');assert.equal(b.over().data.length,0);inspectSnapshot(b.store.filename);
});
test('account filter does not hide global warning or mix excluded accounts into reference',t=>{
 const b=setup(t);manual(b);const f=createFrontend();f.app.accounts=b.store.all('accounts');f.app.currentMonthData=b.store.all('cashflow_transactions');f.run("today=parseDate('2026-10-07')");vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/overdue.js'),'utf8'),f.context);
 f.run("Overdue.banner('cashflowOverdue',APP.currentMonthData,[],800000,APP.accounts)");assert.match(f.node('cashflowOverdue').innerHTML,/全口座/);assert.match(f.node('cashflowOverdue').innerHTML,/出金 1件／100,000円/);assert.match(f.node('cashflowOverdue').innerHTML,/場合：800,000円/);
});
