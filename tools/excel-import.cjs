'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{createHash}=require('node:crypto');
const CASE='cashflow-excel-r85-2026-04-07-v1',KEY='migration:'+CASE;
const appRoot=process.env.CASHFLOW_APP_ROOT||path.resolve(__dirname,'..'),math=require(path.join(appRoot,'assets/cashflow-math.js'));
const canonical=x=>JSON.stringify(sort(x));
function sort(x){return Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;}
const hash=x=>createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex');
const fields=['id','source','sourceId','status','type','partner','description','account','plannedDate','plannedAmount','actualDate','actualAmount','memo'];
function validate(p){
 assert.equal(p.caseId,CASE);assert.match(p.sourceSha256,/^[a-f0-9]{64}$/);assert.equal(p.rows.length,265);assert.equal(p.accounts.length,4);
 const months={},types={},ids=new Set(),cells=new Set();
 for(const a of p.accounts){assert.equal(a.type,'普通');assert.equal(a.balanceDate,'2026-03-31');assert.ok(Number.isSafeInteger(a.balance));assert.match(a.accountNumber,/^\d{7}$/);}
 for(const r of p.rows){const t=r.transaction,v=r.provenance;assert.equal(v.sha256,p.sourceSha256);assert.equal(v.file,p.sourceFile);assert.match(v.sheet,/^[4-7]月分$/);assert.match(v.cell,/^[C-F]\d+$/);assert.equal(t.id,'xl_'+hash(`${p.sourceSha256}|${v.sheet}|${v.cell}`));assert.ok(!ids.has(t.id));ids.add(t.id);assert.ok(!cells.has(v.sheet+'!'+v.cell));cells.add(v.sheet+'!'+v.cell);
  assert.equal(t.source,'manual');assert.equal(t.status,'確定');assert.ok(['入金','出金'].includes(t.type));assert.ok(t.actualDate>='2026-04-01'&&t.actualDate<='2026-07-31');assert.ok(Number.isSafeInteger(t.actualAmount)&&t.actualAmount>0);assert.equal(t.plannedDate,t.actualDate);assert.equal(t.plannedAmount,t.actualAmount);assert.equal(t.account,p.accounts.find(a=>a.accountNumber===r.accountNumber)?.id);
  months[t.actualDate.slice(0,7)]=(months[t.actualDate.slice(0,7)]||0)+1;types[t.type]=(types[t.type]||0)+1;
 }
 assert.deepEqual(months,{'2026-04':68,'2026-05':59,'2026-06':80,'2026-07':58});assert.deepEqual(types,{'入金':61,'出金':204});assert.equal(p.checkpoints.length,20);assert.equal(p.daily.length,488);
}
function read(db,table){return db.prepare('SELECT * FROM '+table+' ORDER BY 1').all();}
function businessSnapshot(db){const result={};for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('sessions','login_attempts') ORDER BY name").all())result[name]=read(db,name);return result;}
function verifyRows(db,p){
 for(const r of p.rows){const row=db.prepare('SELECT '+fields.join(',')+' FROM cashflow_transactions WHERE id=?').get(r.transaction.id);assert.ok(row,'Missing imported record');assert.equal(canonical(row),canonical(r.transaction),'Imported record differs: '+r.provenance.sheet+'!'+r.provenance.cell);}
}
function report(db,p){
 verifyRows(db,p);const accounts=read(db,'accounts'),transactions=read(db,'cashflow_transactions'),imported=transactions.filter(t=>p.rows.some(r=>r.transaction.id===t.id));
 const checkpoints=p.checkpoints.map(c=>{const a=accounts.find(a=>a.accountNumber===c.accountNumber);const calculated=math.actualAt(a,transactions,c.date);assert.equal(calculated,c.app,'Balance checkpoint mismatch');return {...c,actual:calculated,difference:calculated-c.excel};});
 for(const c of p.daily){const a=accounts.find(a=>a.accountNumber===c.accountNumber);assert.equal(math.actualAt(a,transactions,c.date),c.app,'Daily balance mismatch');}
 const groups={};for(const t of imported){const a=accounts.find(a=>a.id===t.account),key=t.actualDate.slice(0,7)+'|'+a.accountNumber;const g=groups[key]??={month:t.actualDate.slice(0,7),accountNumber:a.accountNumber,count:0,incomeCount:0,expenseCount:0,income:0,expense:0};g.count++;g[t.type==='入金'?'incomeCount':'expenseCount']++;g[t.type==='入金'?'income':'expense']+=t.actualAmount;}
 for(const a of p.accounts){const actual=accounts.find(x=>x.id===a.id);assert.equal(actual.type,'普通');assert.equal(actual.balanceDate,a.balanceDate);assert.equal(actual.balance,a.balance);assert.equal(actual.accountNumber,a.accountNumber);}
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 require(path.join(appRoot,'src/domain/schedules.cjs')).checkIntegrity(db);
 return {caseId:CASE,imported:imported.length,incomeCount:imported.filter(t=>t.type==='入金').length,expenseCount:imported.filter(t=>t.type==='出金').length,accounts:p.accounts.map(a=>accounts.find(x=>x.id===a.id)),groups:Object.values(groups),checkpoints,dailyChecks:p.daily.length,totalBankRows:transactions.length,knownExceptionsPreserved:true};
}
function apply(database,p,{failAfter=0,expectedSnapshotHash=null}={}){
 validate(p);const digest=hash(p),db=new DatabaseSync(database,{timeout:5000,enableForeignKeyConstraints:true});
 try{
  const schema=db.prepare('PRAGMA user_version').get().user_version;assert.ok([3,4].includes(schema));db.exec('BEGIN IMMEDIATE');
  const prior=db.prepare('SELECT value FROM settings WHERE key=?').get(KEY);
  if(prior){
   const complete=JSON.parse(prior.value);assert.equal(complete.payloadHash,digest,'Same migration case with changed source/content');
   assert.deepEqual(complete.transactionIds,p.rows.map(r=>r.transaction.id));
   if(schema===3)verifyRows(db,p);
   else for(const r of p.rows){
    const o=db.prepare('SELECT * FROM transaction_origins WHERE transactionId=?').get(r.transaction.id);
    assert.equal(o?.migrationId,CASE);assert.equal(o.fileHash,p.sourceSha256);assert.equal(o.sheet,r.provenance.sheet);assert.equal(o.cell,r.provenance.cell);
    const original=JSON.parse(o.originalJson);for(const k of fields)assert.equal(original[k],r.transaction[k]);
    const current=db.prepare('SELECT source,sourceId FROM cashflow_transactions WHERE id=?').get(r.transaction.id);
    assert.equal(current?.source,original.source);assert.equal(current?.sourceId,original.sourceId);
   }
   for(const a of p.accounts){const existing=db.prepare('SELECT id FROM accounts WHERE id=?').get(a.id);assert.ok(existing);}
   db.exec('COMMIT');return {alreadyCompleted:true,added:0,accountsCreated:0,baselinesUpdated:0,caseId:CASE};
  }
  assert.equal(schema,3,'New import is not supported after the correction schema upgrade');
  const before=businessSnapshot(db),now=new Date().toISOString();
  if(expectedSnapshotHash)assert.equal(hash(before),expectedSnapshotHash,'Database changed after backup verification');
  assert.equal(db.prepare("SELECT count(*) n FROM cashflow_transactions WHERE coalesce(actualDate,plannedDate) BETWEEN '2026-04-01' AND '2026-07-31'").get().n,0,'Existing target-period records require review');
  for(const a of p.accounts){const match=db.prepare('SELECT * FROM accounts WHERE bank=? AND accountNumber=?').all(a.bank,a.accountNumber);if(a.existing){assert.equal(match.length,1);assert.equal(canonical(match[0]),canonical(a.existing),'Account changed after review');}else{assert.equal(match.length,0,'Account already exists');assert.equal(db.prepare('SELECT count(*) n FROM accounts WHERE id=?').get(a.id).n,0);}}
  for(const r of p.rows)assert.equal(db.prepare('SELECT count(*) n FROM cashflow_transactions WHERE id=? OR sourceId=?').get(r.transaction.id,r.transaction.sourceId).n,0,'Migration record conflict');
  let order=db.prepare('SELECT coalesce(max(sort),0) n FROM accounts').get().n;
  for(const a of p.accounts){if(a.existing)db.prepare('UPDATE accounts SET balance=?,balanceDate=?,type=?,updatedAt=? WHERE id=?').run(a.balance,a.balanceDate,a.type,now,a.id);else db.prepare('INSERT INTO accounts (id,bank,branch,type,accountNumber,balance,balanceDate,sort,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(a.id,a.bank,a.branch,a.type,a.accountNumber,a.balance,a.balanceDate,++order,now,now);}
  const insert=db.prepare('INSERT INTO cashflow_transactions ('+fields.join(',')+',createdAt,updatedAt) VALUES ('+Array(fields.length+2).fill('?').join(',')+')');
  p.rows.forEach((r,i)=>{insert.run(...fields.map(k=>r.transaction[k]),now,now);if(failAfter===i+1)throw Error('INJECTED_FAILURE');});
  const result=report(db,p);
  const unchanged=['cashflow_transactions','receivables','payables','partners','fixed_expenses','payment_schedules','payment_schedule_occurrences','payment_schedule_legs','users','audit_events'];
  for(const table of unchanged)for(const old of before[table]){const actual=db.prepare('SELECT * FROM '+table+' WHERE id=?').get(old.id);assert.equal(canonical(actual),canonical(old),'Existing data changed: '+table);}
  for(const old of before.settings)assert.equal(canonical(db.prepare('SELECT * FROM settings WHERE key=?').get(old.key)),canonical(old));
  const completion={caseId:CASE,sourceFile:p.sourceFile,sourceSha256:p.sourceSha256,payloadHash:digest,completedAt:now,count:265,accountIds:p.accounts.map(a=>a.id),transactionIds:p.rows.map(r=>r.transaction.id)};
  db.prepare('INSERT INTO settings (key,value,updatedAt) VALUES (?,?,?)').run(KEY,JSON.stringify(completion),now);
  db.prepare('INSERT INTO audit_events (actor,action,target,createdAt) VALUES (?,?,?,?)').run('operator','excel_actuals_import',CASE,now);
  db.exec('COMMIT');return {...result,added:265,accountsCreated:2,baselinesUpdated:2,existingRecordsPreserved:true,payloadHash:digest};
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
}
function verify(database,p){validate(p);const db=new DatabaseSync(database,{readOnly:true,timeout:5000});try{db.exec('PRAGMA query_only=ON;BEGIN');const r=report(db,p);db.exec('COMMIT');return r;}finally{db.close();}}
if(require.main===module){const [mode,database,file,expectedSnapshotHash]=process.argv.slice(2),p=JSON.parse(fs.readFileSync(file,'utf8'));if(!['apply','verify'].includes(mode))throw Error('Usage: import.cjs apply|verify database payload');console.log(JSON.stringify(mode==='apply'?apply(database,p,{expectedSnapshotHash}):verify(database,p)));}
module.exports={apply,verify,canonical,hash,businessSnapshot,KEY};
