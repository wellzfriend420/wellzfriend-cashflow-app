'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const {createBackend}=require('./sqlite-helpers.cjs');
const {createFrontend}=require('./helpers.cjs');
const {openStore}=require('../src/storage.cjs');
const {createBackup,inspectSnapshot,checksum,atomicJson}=require('../src/backup.cjs');
const {restore}=require('../tools/restore.cjs');
const input={action:'saveAccount',id:'new-account',bank:'合成銀行',branch:'合成支店',type:'普通',accountNumber:'0012345',balance:12345,balanceDate:'2026-09-01'};
test('account create/edit stores independent text fields and leading zeroes across SQLite reopen',()=>{
 const b=createBackend();assert.equal(b.post(input).success,true);
 let row=b.store.find('accounts',input.id);assert.equal(row.accountNumber,'0012345');assert.equal(row.bank,'合成銀行');assert.equal(row.branch,'合成支店');assert.equal(Object.hasOwn(row,'name'),false);
 assert.equal(b.store.db.prepare('SELECT typeof(accountNumber) t FROM accounts WHERE id=?').get(input.id).t,'text');
 assert.equal(b.post({...input,branch:'第二支店',accountNumber:'0009876',expectedUpdatedAt:row.updatedAt}).success,true);
 const reopened=openStore(b.store.filename);try{row=reopened.find('accounts',input.id);assert.equal(row.accountNumber,'0009876');assert.equal(row.branch,'第二支店');assert.equal(row.balance,12345);assert.equal(row.balanceDate,'2026-09-01');}finally{reopened.close();}
});
test('bank is required, account number cannot be numeric, and the removed name field is rejected',()=>{
 const b=createBackend();
 for(const invalid of [{bank:''},{bank:'  '},{bank:123},{accountNumber:12345},{accountNumber:'1e5'},{accountNumber:'１２３'},{name:'旧名称'},{branch:1}])assert.ok(b.post({...input,...invalid}).error);
 assert.equal(b.store.find('accounts',input.id),null);
 assert.equal(b.post({...input,branch:'',accountNumber:''}).success,true);
});
test('account form saves/edits strings and redisplays leading zeroes without the removed input',async()=>{
 const b=createBackend(),f=createFrontend(b);let modal='';f.context.showModal=html=>{modal=html;};
 for(const [id,value] of Object.entries({af_bank:'合成銀行',af_branch:'合成支店',af_type:'普通',af_accountNumber:'0012345',af_balance:'12345',af_balanceDate:'2026-09-01'}))f.node(id).value=value;
 await f.context.saveAccount(null);let a=b.records('accounts').find(x=>x.bank==='合成銀行');assert.ok(a);assert.equal(a.accountNumber,'0012345');
 f.context.openAccountForm(a.id);assert.match(modal,/id="af_accountNumber"[^>]*value="0012345"/);assert.match(modal,/type="text" inputmode="numeric"/);assert.ok(!modal.includes('af_name'));assert.match(modal,/銀行名 \*/);
 f.node('af_branch').value='第二支店';f.node('af_accountNumber').value='0000123';await f.context.saveAccount(a.id);
 a=b.store.find('accounts',a.id);assert.equal(a.branch,'第二支店');assert.equal(a.accountNumber,'0000123');f.context.openAccountForm(a.id);assert.match(modal,/value="0000123"/);
});
test('cashflow, debts, manual entries, fixed expenses and Excel use bank plus branch, not account number',async()=>{
 const b=createBackend();b.post(input);const f=createFrontend(b);f.app.accounts=[b.store.find('accounts',input.id)];f.app.currentMonth='2026-09';f.app.currentMonthData=[];
 assert.equal(f.context.accountDisplayName(f.app.accounts[0]),'合成銀行 合成支店');assert.equal(f.context.accountDisplayName({bank:'合成銀行'}),'合成銀行');
 f.context.renderCashflowTable();assert.match(f.node('cashflowTableHead').innerHTML,/合成銀行 合成支店/);assert.ok(!f.node('cashflowTableHead').innerHTML.includes('0012345'));
 let modal='';f.context.showModal=html=>{modal=html;};
 for(const open of ['openTransactionForm','openReceivableForm','openPayableForm','openFixedExpenseForm','openAccountFilterModal']){
  f.context[open](null);assert.match(modal,/合成銀行 合成支店/);assert.ok(!modal.includes('0012345'));
 }
 f.context.exportCashflowToExcel();assert.ok(f.captured.rows[0].includes('合成銀行 合成支店 取引額'));assert.ok(!JSON.stringify(f.captured.rows).includes('0012345'));
 assert.equal(f.node('monthCloseBalance').textContent,'12,345円');
});
test('new account fields and references survive consistent backup and restore',async()=>{
 const b=createBackend();b.post(input);b.post({action:'saveReceivable',id:'r',partner:'合成先',invoiceDate:'2026-09-01',dueDate:'2026-09-30',amount:100,account:input.id});
 const backupDir=path.join(b.dir,'backups'),m=await createBackup({databasePath:b.store.filename,backupDir,statusDir:path.join(b.dir,'status')});
 const target=path.join(b.dir,'restored.sqlite');await restore(path.join(backupDir,m.id+'.manifest.json'),target);
 const restored=openStore(target);try{assert.deepEqual(restored.find('accounts',input.id),b.store.find('accounts',input.id));assert.equal(restored.find('receivables','r').account,input.id);assert.equal(restored.find('cashflow_transactions','cf_r').account,input.id);assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version,4);}finally{restored.close();}
});
test('v1 migration drops name once, preserves IDs/balances/users, and v1 backup restores into v2 without modifying its source',async()=>{
 const b=createBackend();b.post({action:'saveReceivable',id:'r',partner:'合成先',invoiceDate:'2026-09-01',dueDate:'2026-09-30',amount:100,account:'a'});
 b.store.db.exec("DROP TABLE transaction_revisions; DROP TABLE transaction_origins; DROP TABLE payment_schedule_legs; DROP TABLE payment_schedule_occurrences; DROP TABLE payment_schedules; ALTER TABLE accounts ADD COLUMN name TEXT; UPDATE accounts SET name='旧表示',bank='' WHERE id='a'; ALTER TABLE accounts DROP COLUMN branch; ALTER TABLE accounts DROP COLUMN accountNumber; PRAGMA user_version=1;");
 b.store.db.prepare("INSERT INTO users VALUES('u','fixture-admin','not-a-password','admin','2026-09-01')").run();
 const backupDir=path.join(b.dir,'legacy');fs.mkdirSync(backupDir);const id='cashflow-20260925T000000000Z-abcdef12',file=path.join(backupDir,id+'.sqlite');
 await backup(b.store.db,file);const normalize=new DatabaseSync(file);normalize.exec('PRAGMA journal_mode=DELETE');normalize.close();
 const sha256=checksum(file),m={id,databaseFile:id+'.sqlite',createdAt:'2026-09-25T00:00:00.000Z',bytes:fs.statSync(file).size,sha256,...inspectSnapshot(file,{allowPreviousSchema:true})};
 const manifest=path.join(backupDir,id+'.manifest.json');atomicJson(manifest,m);
 const target=path.join(b.dir,'migrated.sqlite');await restore(manifest,target);assert.equal(checksum(file),sha256);
 const db=openStore(target);try{const a=db.find('accounts','a');assert.equal(a.bank,'旧表示');assert.equal(a.balance,1000);assert.equal(a.balanceDate,'2026-08-31');assert.ok(!Object.hasOwn(a,'name'));assert.equal(a.branch,null);assert.equal(a.accountNumber,null);assert.equal(db.find('receivables','r').account,'a');assert.equal(db.db.prepare('SELECT count(*) n FROM users').get().n,1);assert.equal(db.db.prepare('PRAGMA foreign_key_check').all().length,0);}finally{db.close();}
});
