'use strict';
process.env.TZ='Asia/Tokyo';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openStore}=require('../src/storage.cjs'),createLedger=require('../src/domain/ledger.cjs');
const math=require('../assets/cashflow-math.js'),{createFrontend}=require('./helpers.cjs');
const {createBackup,inspectSnapshot,checksum}=require('../src/backup.cjs'),{restore}=require('../tools/restore.cjs');
const {createApplication}=require('../src/server.cjs');
function fixture(t,day='2026-12-31'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cashflow-year-')),file=path.join(dir,'data.sqlite');
 let store=openStore(file),now=day,ledger=createLedger(store,{today:()=>now});
 const f={dir,file,get store(){return store;},get ledger(){return ledger;},get: (action,args)=>ledger.get(action,args),post:body=>ledger.post(body),setDay:day=>now=day,
 reopen(){store.close();store=openStore(file);ledger=createLedger(store,{today:()=>now});},
 tx:()=>store.all('cashflow_transactions'),accounts:()=>store.all('accounts'),
 projection:through=>ledger.get('getTransactions',{all:'true',through}).data,
 period:(start,end=start,mode='predict')=>ledger.get('getCashflowPeriod',{start,end,mode,day:now,accounts:'a'}).periods};
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 f.post({action:'saveAccount',id:'a',bank:'合成銀行',branch:'合成支店',accountNumber:'0012345',type:'普通',balance:1000,balanceDate:'2026-12-30'});
 return f;
}
function fixed(f,extra={}){return f.post({action:'saveFixedExpense',id:'rent',name:'合成家賃',payee:'合成先',amount:10,day:31,startMonth:'2026-12',endMonth:null,account:'a',holidayRule:'none',scope:'all',...extra});}
function manual(f,id,date,amount,type){return f.post({action:'saveTransaction',id,account:'a',type,plannedDate:date,plannedAmount:amount,actualDate:date,actualAmount:amount,status:'確定'});}
function update(f,record,changes){return f.post({action:'saveTransaction',...record,...changes,expectedUpdatedAt:record.updatedAt});}
test('SQLite year boundary: Dec31 closing equals Jan1 opening; January movements persist after reopen',t=>{
 const f=fixture(t);manual(f,'dec','2026-12-31',100,'入金');f.setDay('2027-01-05');manual(f,'janIn','2027-01-01',80,'入金');manual(f,'janOut','2027-01-02',50,'出金');f.reopen();
 const [dec,jan]=f.period('2026-12','2027-01','actual');assert.equal(dec.totals.a.closing,1100);assert.equal(jan.totals.a.opening,1100);assert.equal(jan.totals.a.closing,1130);
 assert.equal(math.balanceAt(f.accounts()[0],f.tx(),'2027-01-02','actual','2027-01-05'),1130);
});
for(const kind of ['receivable','payable'])test('SQLite outstanding '+kind+' crosses years with split payments and retry protection',t=>{
 const f=fixture(t),table=kind==='receivable'?'receivables':'payables',save=kind==='receivable'?'saveReceivable':'savePayable',confirm=kind==='receivable'?'confirmReceivable':'confirmPayable';
 f.post({action:save,id:'debt',partner:'合成先',invoiceDate:'2026-12-01',occDate:'2026-12-01',dueDate:'2026-12-31',amount:100,account:'a'});
 function pay(amount,date,paymentId){const d=f.store.find(table,'debt');return {action:confirm,id:d.id,amount,date,paymentId,account:'a',expectedUpdatedAt:d.updatedAt};}
 f.post(pay(40,'2026-12-31','first'));f.setDay('2027-01-05');f.reopen();
 assert.equal(f.store.find(table,'debt').paidAmount,40);assert.equal(f.store.find('cashflow_transactions','cf_debt').plannedAmount,60);
 assert.equal(math.rows(f.projection('2027-01'),['a'],'2027-01','predict','2027-01-05').find(t=>t.id==='cf_debt'),undefined);
 assert.equal(math.rows(f.projection('2027-01'),['a'],'2026-12','predict','2027-01-05').find(t=>t.id==='cf_debt').cashDate,'2026-12-31');
 const p=pay(60,'2027-01-05','second');f.post(p);assert.equal(f.post(p).duplicate,true);assert.equal(f.store.find(table,'debt').paidAmount,100);
 assert.equal(f.tx().filter(t=>t.source===kind+'_payment').length,2);assert.equal(f.store.find('cashflow_transactions','cf_debt').status,'完了');
});
test('continuous and finite expenses: 13-month horizon, no writes on distant views, intervening forecast included',t=>{
 const f=fixture(t);fixed(f);fixed(f,{id:'finite',endMonth:'2027-02',amount:20});
 assert.equal(f.tx().filter(t=>t.sourceId==='rent').length,13);assert.equal(f.tx().filter(t=>t.sourceId==='finite').length,3);
 const count=f.tx().length,changes=f.store.db.prepare('SELECT total_changes() n').get().n;
 const far=f.period('2030-01')[0];assert.equal(far.totals.a.opening,1000-37*10-3*20);assert.equal(far.totals.a.closing,1000-38*10-3*20);
 assert.equal(f.tx().length,count);assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes);
 f.ledger.replenish();f.ledger.replenish();assert.equal(f.tx().length,count);
});
test('replenishment recovers downtime at real application startup and preserves confirmed/cancelled records',async t=>{
 const f=fixture(t);fixed(f);const december=f.store.find('cashflow_transactions','fx_rent_202612');update(f,december,{actualDate:'2026-12-31',actualAmount:9,status:'確定'});
 const january=f.store.find('cashflow_transactions','fx_rent_202701');update(f,january,{status:'取消'});
 f.setDay('2029-01-04');f.reopen();const app=await createApplication({store:f.store,today:()=> '2029-01-04'});await app.close();
 assert.equal(f.tx().length,38);assert.equal(f.store.find('cashflow_transactions','fx_rent_202612').actualAmount,9);assert.equal(f.store.find('cashflow_transactions','fx_rent_202701').status,'取消');
 f.ledger.replenish();assert.equal(f.tx().length,38);
 const master=f.store.find('fixed_expenses','rent');fixed(f,{amount:12,scope:'all',expectedUpdatedAt:master.updatedAt});
 assert.equal(f.store.find('cashflow_transactions','fx_rent_202612').actualAmount,9);assert.equal(f.store.find('cashflow_transactions','fx_rent_202701').status,'取消');
 assert.ok(!f.period('2029-01')[0].rows.some(t=>t.id==='fx_rent_202701'));
});
test('virtual cancellations materialize exactly once, cannot revive on reads, edits or later replenishment',t=>{
 const f=fixture(t);fixed(f);const v=f.projection('2030-01').find(t=>t.id==='fx_rent_203001');assert.equal(v.virtual,true);
 update(f,v,{status:'取消'});assert.equal(f.tx().length,14);
 assert.ok(!f.period('2030-01')[0].rows.some(t=>t.id===v.id));
 const master=f.store.find('fixed_expenses','rent');fixed(f,{amount:20,expectedUpdatedAt:master.updatedAt});
 assert.equal(f.store.find('cashflow_transactions',v.id).status,'取消');
 f.setDay('2030-01-01');f.ledger.replenish();assert.equal(f.tx().filter(t=>t.id===v.id).length,1);assert.equal(f.store.find('cashflow_transactions',v.id).status,'取消');
});
test('bank holidays Dec31 and Jan1-Jan3, weekend chain, next/previous/none and cross-month occurrence identity',t=>{
 const f=fixture(t);
 fixed(f,{id:'dec',endMonth:'2026-12',holidayRule:'next'});assert.equal(f.store.find('cashflow_transactions','fx_dec_202612').plannedDate,'2027-01-04');
 for(const day of [1,2,3]){fixed(f,{id:'jan'+day,startMonth:'2027-01',endMonth:'2027-01',day,holidayRule:'next'});assert.equal(f.store.find('cashflow_transactions','fx_jan'+day+'_202701').plannedDate,'2027-01-04');}
 fixed(f,{id:'prev',startMonth:'2027-01',endMonth:'2027-01',day:1,holidayRule:'previous'});assert.equal(f.store.find('cashflow_transactions','fx_prev_202701').plannedDate,'2026-12-30');
 fixed(f,{id:'long',startMonth:'2020-12',endMonth:'2020-12',holidayRule:'next'});assert.equal(f.store.find('cashflow_transactions','fx_long_202012').plannedDate,'2021-01-04');
 fixed(f,{id:'holiday',startMonth:'2027-01',endMonth:'2027-01',day:9,holidayRule:'next'});assert.equal(f.store.find('cashflow_transactions','fx_holiday_202701').plannedDate,'2027-01-12');
 fixed(f,{id:'none',endMonth:'2026-12'});assert.equal(f.store.find('cashflow_transactions','fx_none_202612').plannedDate,'2026-12-31');
 fixed(f,{id:'across',endMonth:'2027-01',holidayRule:'next'});assert.equal(f.tx().filter(t=>t.sourceId==='across').length,2);
 // A far next-month previous-bank-day payment must also appear in the selected month.
 fixed(f,{id:'futurePrev',startMonth:'2030-01',endMonth:'2030-01',day:1,holidayRule:'previous'});
 assert.ok(f.period('2029-12')[0].rows.some(t=>t.id==='fx_futurePrev_203001'));
});
test('month navigation and period Excel match screen; empty months, all modes, continuity and 60-month limit',async t=>{
 const f=fixture(t);fixed(f);const frontend=createFrontend(f);frontend.run("today=new Date(2027,0,5)");f.setDay('2027-01-05');
 frontend.app.selectedAccountIds=['a'];
 await frontend.context.switchMonth('2026-12');assert.equal(frontend.app.currentMonth,'2026-12');
 await frontend.context.switchMonth('2030-01');assert.equal(frontend.app.currentMonth,'2030-01');assert.match(frontend.node('monthTabs').innerHTML,/2027年/);
 const count=f.tx().length;
 const XLSX=require('../assets/vendor/xlsx.full.min.js');let workbook;frontend.context.XLSX={...XLSX,writeFile:wb=>workbook=wb};
 for(const mode of ['predict','actual','diff']){
  frontend.app.currentMode=mode;frontend.node('exportStart').value='2026-12';frontend.node('exportEnd').value='2027-03';
  await frontend.context.exportCashflowPeriod();assert.equal(workbook.SheetNames.length,5);assert.equal(workbook.SheetNames[0],'期間集計');
  const decoded=XLSX.read(XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
  const summary=XLSX.utils.sheet_to_json(decoded.Sheets['期間集計'],{header:1});
  for(let i=1;i<summary.length;i++){
   const [month,,opening,income,expense,closing]=summary[i];assert.equal(closing,opening+income-expense);
   if(i>1)assert.equal(opening,summary[i-1][5]);
   await frontend.context.switchMonth(month);assert.equal(frontend.node('monthOpenBalance').textContent,opening.toLocaleString('ja-JP')+'円');assert.equal(frontend.node('monthCloseBalance').textContent,closing.toLocaleString('ja-JP')+'円');
   const data=XLSX.utils.sheet_to_json(decoded.Sheets[month],{header:1});assert.equal(data[1][6],opening);assert.equal(data.at(-1)[6],closing);
  }
 }
 assert.equal(f.tx().length,count);assert.equal(f.period('2020-01')[0].rows.length,0);assert.equal(f.period('2020-01')[0].totals.a.opening,f.period('2020-01')[0].totals.a.closing);
 assert.equal(f.period('2026-01','2030-12').length,60);assert.throws(()=>f.period('2026-01','2031-01'),/60/);
});
test('consistent backup restores recurrence rules, cancellations, accounts and identical distant forecasts',async t=>{
 const f=fixture(t);fixed(f);const row=f.tx()[0];update(f,row,{status:'取消'});
 const before=f.period('2026-12','2028-01');const manifest=await createBackup({databasePath:f.file,backupDir:path.join(f.dir,'backup'),statusDir:path.join(f.dir,'status'),now:new Date('2026-12-31T12:00:00Z')});
 const manifestPath=path.join(f.dir,'backup',manifest.id+'.manifest.json'),target=path.join(f.dir,'restored.sqlite'),hash=checksum(path.join(f.dir,'backup',manifest.id+'.sqlite'));
 await restore(manifestPath,target);const store=openStore(target);try{
  const ledger=createLedger(store,{today:()=> '2026-12-31'});assert.deepEqual(ledger.get('getCashflowPeriod',{start:'2026-12',end:'2028-01',mode:'predict',day:'2026-12-31',accounts:'a'}).periods,before);
  assert.equal(store.find('accounts','a').accountNumber,'0012345');assert.equal(store.find('fixed_expenses','rent').endMonth,null);
  assert.equal(inspectSnapshot(target).integrity,'ok');
 }finally{store.close();}assert.equal(checksum(path.join(f.dir,'backup',manifest.id+'.sqlite')),hash);
});

test('fixed expense form saves continuous NULL and can return to a finite end month',async t=>{
 const f=fixture(t),ui=createFrontend(f);ui.app.accounts=f.accounts();
 for(const [id,value] of Object.entries({fe_name:'合成家賃',fe_payee:'合成先',fe_amount:'10',fe_day:'25',fe_startMonth:'2026-12',fe_endMonth:'2027-12',fe_account:'a',fe_holidayRule:'next',fe_memo:''}))ui.node(id).value=value;
 ui.node('fe_continuous').checked=true;await ui.context.saveFixedExpenseForm(null);
 let master=f.store.all('fixed_expenses')[0];assert.ok(master);assert.equal(master.endMonth,null);
 ui.app.fixedExpenses=[master];ui.context.openFixedExpenseForm(master.id);
 assert.match(ui.node('fixedExpenseList').innerHTML,/継続/);
 ui.node('fe_continuous').checked=false;ui.node('fe_endMonth').value='2027-02';ui.node('fe_scope').value='future';
 await ui.context.saveFixedExpenseForm(master.id);master=f.store.find('fixed_expenses',master.id);assert.equal(master.endMonth,'2027-02');assert.equal(f.tx().length,3);
});
test('replenishment failure rolls back partial generation and exposes a retryable failure state',t=>{
 const f=fixture(t);fixed(f);f.ledger.replenish();const count=f.tx().length;f.setDay('2027-02-01');
 const save=f.store.save;let attempts=0;f.store.save=(...args)=>{if(++attempts===2)throw new Error('Synthetic failure');return save(...args);};
 assert.throws(()=>f.ledger.replenish(),/Synthetic/);assert.equal(f.tx().length,count);assert.equal(f.ledger.get('getFixedExpenseMaintenance').state,'failed');
 f.store.save=save;f.ledger.replenish();assert.equal(f.tx().length,15);assert.equal(f.ledger.get('getFixedExpenseMaintenance').state,'ok');
});
