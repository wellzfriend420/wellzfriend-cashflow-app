'use strict';
const {createHash}=require('node:crypto');
const actions=new Set(['correctActual','cancelActual','reopenActual']);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
module.exports=function(repo,{today,syncDebtSchedule}){
 const db=repo.db,table='cashflow_transactions';
 const hasTables=()=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='transaction_origins'").get();
 const origin=id=>hasTables()?db.prepare('SELECT * FROM transaction_origins WHERE transactionId=?').get(id):null;
 const tracked=id=>!!origin(id);
 function remember(t,plan){
  if(!hasTables()||origin(t.id))return;
  db.prepare('INSERT INTO transaction_origins(transactionId,kind,originalJson,planJson,createdAt) VALUES(?,?,?,?,?)').run(t.id,plan?'plan':'direct',JSON.stringify(t),plan?JSON.stringify(plan):null,new Date().toISOString());
 }
 function infer(t){
  if(origin(t.id))return;
  if(t.id.startsWith('xl_')||String(t.sourceId||'').startsWith('excel_'))throw Error('移行履歴が見つかりません。訂正を中止しました');
  const plan=t.plannedDate&&t.plannedAmount!=null?{...t,status:'予定',actualDate:null,actualAmount:null}:null;
  remember(t,plan);
 }
 function related(t){
  if(t.source==='payment_schedule'){
   const leg=db.prepare('SELECT * FROM payment_schedule_legs WHERE transactionId=?').get(t.id);
   if(!leg)throw Error('関連する銀行明細がありません');
   const occurrence=db.prepare('SELECT * FROM payment_schedule_occurrences WHERE id=?').get(leg.occurrenceId);
   const master=db.prepare('SELECT * FROM payment_schedules WHERE id=?').get(occurrence.scheduleId);
   if(leg.revision!==occurrence.revision)throw Error('旧版の予定表明細は変更できません');
   return {leg,occurrence,master};
  }
  if(['receivable_payment','payable_payment'].includes(t.source)){
   const kind=t.source.replace('_payment',''),debt=repo.find(kind==='receivable'?'receivables':'payables',t.sourceId);
   if(!debt)throw Error('元の売掛・買掛がありません');
   return {kind,debt};
  }
  if(!['manual','fixed_expense'].includes(t.source))throw Error('この実績の訂正は未対応です');
  return {};
 }
 const snapshot=t=>({transaction:t,...related(t)});
 function canReopen(t,r,o){
  if(o?.kind==='migration')return false;
  if(r.debt)return true;
  if(o?.kind==='direct')return false;
  if(r.occurrence)return !r.occurrence.cancelledAt&&!r.master.archivedAt;
  if(t.source==='fixed_expense'&&!repo.find('fixed_expenses',t.sourceId))return false;
  return !!(o?.planJson||(!o&&t.plannedDate&&t.plannedAmount!=null));
 }
 function get(id){
  const t=repo.find(table,id);if(!t)throw Error('実績が見つかりません');
  const r=related(t),o=origin(id);
  const history=hasTables()?db.prepare('SELECT * FROM transaction_revisions WHERE transactionId=? ORDER BY createdAt,requestId').all(id).map(x=>({...x,before:JSON.parse(x.beforeJson),after:JSON.parse(x.afterJson),beforeJson:undefined,afterJson:undefined})):[];
  return {transaction:t,origin:o?{...o,original:JSON.parse(o.originalJson),originalJson:undefined,plan:o.planJson?JSON.parse(o.planJson):null,planJson:undefined}:null,history,...r,
   canReopen:canReopen(t,r,o),typeEditable:t.source==='manual',accounts:repo.all('accounts')};
 }
 function list(){
  return {data:db.prepare(`SELECT r.requestId,r.transactionId,r.action,r.actorId,r.actorName,r.reason,r.createdAt,t.status,
   json_extract(r.beforeJson,'$.transaction.actualDate') actualDate,
   json_extract(r.beforeJson,'$.transaction.description') description
   FROM transaction_revisions r JOIN cashflow_transactions t ON t.id=r.transactionId ORDER BY r.createdAt DESC,r.requestId DESC LIMIT 500`).all()};
 }
 function day(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||isNaN(Date.parse(v))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v||v>today())throw Error('実績日は今日以前の有効な日付を入力してください');return v;}
 function money(v){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw Error('金額は0以上の整数円を入力してください');return v;}
 function text(v,max){if(typeof v!=='string'||v.length>max)throw Error('入力文字数を確認してください');return v;}
 function execute(b,actor){
  const allowed=new Set(['action','id','requestId','expectedUpdatedAt','expectedParentVersion','reason','confirmed','acknowledgeBaseline','actualDate','actualAmount','actualPrincipal','actualInterest','account','type','partner','description','memo']);
  if(!b||!actions.has(b.action)||Object.keys(b).some(k=>!allowed.has(k)))throw Error('訂正項目が不正です');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(b.requestId||''))throw Error('再送識別情報が必要です');
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(b.id||''))throw Error('実績識別情報が不正です');
  if(b.confirmed!==true||!text(b.reason,1000).trim())throw Error('変更理由と確認が必要です');
  return repo.transaction(()=>{
   const user=db.prepare("SELECT id,username FROM users WHERE id=? AND role='admin'").get(actor);
   if(!user)throw Error('管理者だけが実績を訂正できます');
   const digest=hash(b),prior=db.prepare('SELECT * FROM transaction_revisions WHERE requestId=?').get(b.requestId);
   if(prior){if(prior.requestHash!==digest||prior.actorId!==actor)throw Error('同じ再送IDの内容が異なります');return {success:true,id:b.id,duplicate:true};}
   const t=repo.find(table,b.id);if(!t||t.status!=='確定'||t.actualDate==null)throw Error('確定済み実績を選択してください');
   if(t.updatedAt!==b.expectedUpdatedAt)throw Error('他の操作で更新されています。再読込してください');
   const r=related(t);
   if(r.master&&r.master.version!==b.expectedParentVersion||r.debt&&r.debt.updatedAt!==b.expectedParentVersion)throw Error('元予定が更新されています。再読込してください');
   infer(t);const o=origin(t.id),before=snapshot(t);
   let next={...t},principal=null,interest=null;
   if(b.action==='correctActual'){
    next.actualDate=day(b.actualDate);
    if(!['入金','出金'].includes(b.type))throw Error('入金・出金を選択してください');
    if(t.source!=='manual'&&b.type!==t.type)throw Error('元予定の入金・出金区分は変更できません');
    if(!repo.find('accounts',b.account))throw Error('口座を選択してください');
    Object.assign(next,{type:b.type,account:b.account,partner:text(b.partner,1000),description:text(b.description,1000),memo:text(b.memo,4000)});
    if(r.occurrence?.kind==='loan'){
     principal=money(b.actualPrincipal);interest=money(b.actualInterest);
     if(r.leg.component==='principal'&&interest!==0||r.leg.component==='interest'&&principal!==0)throw Error('元本・利息の明細区分は変更できません');
     next.actualAmount=money(principal+interest);
     if(b.actualAmount!==next.actualAmount)throw Error('合計は元本と利息の合計にしてください');
    }else next.actualAmount=money(b.actualAmount);
    if((r.debt||r.leg)&&next.actualAmount===0)throw Error('0円への変更は取消を使用してください');
   }else{
    if(b.action==='reopenActual'&&!canReopen(t,r,o))throw Error('戻せる元予定がありません。実績の訂正または取消を使用してください');
    next.actualDate=null;next.actualAmount=null;next.status='取消';
    if(b.action==='reopenActual'&&!r.debt){
     const plan=JSON.parse(o.planJson);for(const k of ['type','account','partner','description','plannedDate','plannedAmount','memo'])next[k]=plan[k];next.status='予定';
    }
   }
   const affects=t.actualDate!==next.actualDate||t.actualAmount!==next.actualAmount||t.account!==next.account||t.type!==next.type||r.leg&&principal!==r.leg.actualPrincipal;
   const basisWarning=affects&&[t,next].some(x=>x.actualDate&&(x.actualDate<=repo.find('accounts',x.account).balanceDate||r.master?.kind==='loan'&&x.actualDate<=r.master.principalBalanceDate));
   if(basisWarning&&b.acknowledgeBaseline!==true)throw Error('残高基準日以前の実績です。基準残高は自動変更されないことを確認してください');
   repo.save(table,next);
   if(r.debt){
    const amount=Number(r.debt.paidAmount)-Number(t.actualAmount)+(next.actualAmount||0);
    if(amount<0||amount>r.debt.amount)throw Error('訂正後の決済済額が請求・支払総額を超えています');
    const updated={...r.debt,paidAmount:amount,status:amount===r.debt.amount?(r.kind==='receivable'?'回収済':'支払済'):amount?(r.kind==='receivable'?'一部入金':'一部支払'):(r.kind==='receivable'?'未回収':'未払')};
    repo.save(r.kind==='receivable'?'receivables':'payables',updated);syncDebtSchedule(r.kind,updated);
   }
   if(r.leg){
    const now=new Date().toISOString();
    db.prepare('UPDATE payment_schedule_legs SET actualPrincipal=?,actualInterest=?,updatedAt=? WHERE id=?').run(principal,interest,now,r.leg.id);
    db.prepare('UPDATE payment_schedule_occurrences SET version=version+1,updatedAt=? WHERE id=?').run(now,r.occurrence.id);
    db.prepare('UPDATE payment_schedules SET version=version+1,updatedAt=? WHERE id=?').run(now,r.master.id);
    require('./schedules.cjs').checkIntegrity(db);
   }
   const after=snapshot(repo.find(table,t.id));
   db.prepare('INSERT INTO transaction_revisions VALUES(?,?,?,?,?,?,?,?,?,?)').run(b.requestId,digest,t.id,b.action,user.id,user.username,b.reason.trim(),JSON.stringify(before),JSON.stringify(after),new Date().toISOString());
   require('../correction-schema.cjs').checkIntegrity(db);
   repo.audit(actor,b.action,t.id);
   return {success:true,id:t.id};
  });
 }
 return {post:execute,get,list,tracked,remember,actions};
};
