'use strict';
const {createHash}=require('node:crypto');
const TABLES=new Set(['payment_schedules','payment_schedule_occurrences','payment_schedule_legs']);
const id=v=>{if(typeof v!=='string'||! /^[a-zA-Z0-9_-]{1,80}$/.test(v))throw Error('識別情報が不正です');return v;};
const str=(v,max=200)=>{if(typeof v!=='string'||v.length>max)throw Error('文字の入力を確認してください');return v.trim();};
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||isNaN(Date.parse(v))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)throw Error('日付を確認してください');return v;};
const money=v=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw Error('金額は0以上の整数円を入力してください');return v;};
const choice=(v,values)=>{if(!values.includes(v))throw Error('選択内容が不正です');return v;};
const sum=(a,b)=>money(a+b);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const actual=t=>t.actualDate!=null;
function checkIntegrity(db){
 const bad=db.prepare(`SELECT count(*) n FROM payment_schedule_legs l
 JOIN payment_schedule_occurrences o ON o.id=l.occurrenceId
 JOIN cashflow_transactions t ON t.id=l.transactionId
 WHERE t.source<>'payment_schedule' OR t.sourceId<>l.id OR t.type<>'出金' OR (t.status='予定' AND t.account<>o.account)
 OR (l.revision<>o.revision AND t.status<>'取消')
 OR (t.actualDate IS NOT NULL AND o.kind='loan' AND (l.actualPrincipal IS NULL OR l.actualInterest IS NULL OR l.actualPrincipal+l.actualInterest<>t.actualAmount
 OR (l.component='principal' AND l.actualInterest<>0) OR (l.component='interest' AND l.actualPrincipal<>0)))
 OR (t.actualDate IS NULL AND (l.actualPrincipal IS NOT NULL OR l.actualInterest IS NOT NULL))`).get().n;
 const orphans=db.prepare("SELECT count(*) n FROM cashflow_transactions t LEFT JOIN payment_schedule_legs l ON l.transactionId=t.id WHERE t.source='payment_schedule' AND l.id IS NULL").get().n;
 const topology=db.prepare(`SELECT count(*) n FROM payment_schedule_occurrences o WHERE
 (SELECT count(*) FROM payment_schedule_legs l WHERE l.occurrenceId=o.id AND l.revision=o.revision)<>
 CASE WHEN o.kind='loan' AND o.effectiveDebitMode='split' THEN (o.plannedPrincipal>0)+(o.plannedInterest>0) ELSE 1 END
 OR EXISTS(SELECT 1 FROM payment_schedule_legs l JOIN cashflow_transactions t ON t.id=l.transactionId
 WHERE l.occurrenceId=o.id AND l.revision=o.revision AND (
 t.status NOT IN ('予定','確定','取消') OR
 CASE WHEN o.kind='loan' AND o.effectiveDebitMode='split' THEN
 (l.component NOT IN ('principal','interest') OR t.plannedAmount<>CASE WHEN l.component='principal' THEN o.plannedPrincipal ELSE o.plannedInterest END)
 ELSE (l.component<>'total' OR t.plannedAmount<>CASE WHEN o.kind='loan' THEN o.plannedPrincipal+o.plannedInterest ELSE o.plannedAmount END) END))`).get().n;
 if(bad||orphans||topology)throw Error('予定表と銀行明細の整合性を確認してください');
}
module.exports=function(repo,{today,adjustDate}){
 const db=repo.db;
 const one=(table,key)=>db.prepare('SELECT * FROM '+table+' WHERE id=?').get(key);
 const all=(table)=>db.prepare('SELECT * FROM '+table).all();
 const historical=o=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='transaction_origins'").get()&&!!db.prepare('SELECT 1 FROM transaction_origins x JOIN payment_schedule_legs l ON l.transactionId=x.transactionId WHERE l.occurrenceId=? LIMIT 1').get(o.id);
 function put(table,data){
  if(!TABLES.has(table)||!db.isTransaction)throw Error('予定表保存処理が不正です');
  const old=one(table,data.id),now=new Date().toISOString();
  const v={...data,createdAt:old?.createdAt||now,updatedAt:now};
  const cols=Object.keys(v);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter(k=>k!=='id').map(k=>k+'=excluded.'+k)}`).run(...cols.map(k=>v[k]??null));
 }
 const legs=o=>db.prepare('SELECT l.*,t.status,t.account,t.actualDate,t.actualAmount,t.plannedDate,t.plannedAmount FROM payment_schedule_legs l JOIN cashflow_transactions t ON t.id=l.transactionId WHERE l.occurrenceId=? AND l.revision=? ORDER BY l.component').all(o.id,o.revision);
 const rows=key=>db.prepare('SELECT * FROM payment_schedule_occurrences WHERE scheduleId=? ORDER BY nominalDate,id').all(key);
 const pendingOverride=o=>legs(o).some(l=>repo.setting('pending_leg_override_'+l.transactionId));
 function version(old,expected){if(old&&old.version!==expected)throw Error('他の操作で更新されています。再読込してください');if(!old&&expected!=null)throw Error('対象が見つかりません');}
 function account(value){id(value);if(!repo.find('accounts',value))throw Error('有効な口座を選択してください');return value;}
 function normalizedMaster(b,old){
  const kind=choice(b.kind,['loan','lease','installment','insurance','other']);
  const v={id:id(b.id),name:str(b.name),kind,account:account(b.account),partner:str(b.partner),defaultDebitMode:kind==='loan'?choice(b.defaultDebitMode,['combined','split']):'single',holidayRule:choice(b.holidayRule,['none','next','previous']),principalStartMode:null,originalPrincipal:null,loanDate:null,principalBalanceDate:null,principalOpeningBalance:null,memo:str(b.memo||'',4000),archivedAt:old?.archivedAt||null,version:(old?.version||0)+1};
  if(!v.name||!v.partner)throw Error('名称と取引先を入力してください');
  if(kind==='loan'){
   v.principalStartMode=choice(b.principalStartMode,['new','existing']);
   v.originalPrincipal=b.originalPrincipal==null?null:money(b.originalPrincipal);
   v.loanDate=b.loanDate?day(b.loanDate):null;
   v.principalBalanceDate=day(b.principalBalanceDate);v.principalOpeningBalance=money(b.principalOpeningBalance);
   if(v.principalStartMode==='new'&&(v.originalPrincipal==null||!v.loanDate))throw Error('新規借入は当初借入額と実行日を入力してください');
   if(v.loanDate&&v.loanDate>v.principalBalanceDate)throw Error('残元本基準日は借入日以降にしてください');
  }
  return v;
 }
 function normalizeRow(input,m,old,applyDefaults){
  const defaults=old&&!applyDefaults?old:m;
  const override=input.debitModeOverride==null||input.debitModeOverride===''?null:choice(input.debitModeOverride,['combined','split']);
  const mode=m.kind==='loan'?(override||(old&&!applyDefaults&&!old.debitModeOverride?old.effectiveDebitMode:m.defaultDebitMode)):'single';
  const rule=defaults.holidayRule;const nominalDate=day(input.nominalDate);
  const v={id:id(input.id),scheduleId:m.id,name:defaults.name,kind:m.kind,account:defaults.account,partner:defaults.partner,
   nominalDate,paymentDate:adjustDate(nominalDate,rule),holidayRule:rule,debitModeOverride:m.kind==='loan'?override:null,effectiveDebitMode:mode,
   plannedAmount:m.kind==='loan'?null:money(input.plannedAmount),plannedPrincipal:m.kind==='loan'?money(input.plannedPrincipal):null,plannedInterest:m.kind==='loan'?money(input.plannedInterest):null};
  if((m.kind==='loan'?sum(v.plannedPrincipal,v.plannedInterest):v.plannedAmount)<=0)throw Error('支払合計は1円以上にしてください');
  return v;
 }
 function createLegs(o){
  const defs=o.kind==='loan'&&o.effectiveDebitMode==='split'?[['principal',o.plannedPrincipal],['interest',o.plannedInterest]]:[['total',o.kind==='loan'?sum(o.plannedPrincipal,o.plannedInterest):o.plannedAmount]];
  for(const [component,amount]of defs){
   if(amount===0)continue;
   const legId='sl_'+hash([o.id,o.revision,component]).slice(0,40),tid='st_'+legId;
   if(repo.find('cashflow_transactions',tid)||one('payment_schedule_legs',legId))throw Error('銀行明細の識別情報が重複しています');
   repo.save('cashflow_transactions',{id:tid,source:'payment_schedule',sourceId:legId,status:'予定',type:'出金',partner:o.partner,description:o.name+(component==='principal'?' 元本':component==='interest'?' 利息':''),account:o.account,plannedDate:o.paymentDate,plannedAmount:amount,actualDate:null,actualAmount:null,memo:'予定表の支払'});
   put('payment_schedule_legs',{id:legId,occurrenceId:o.id,revision:o.revision,component,transactionId:tid,actualPrincipal:null,actualInterest:null});
  }
 }
 function cancelLeg(l){if(actual(l))throw Error('確定済み実績は変更できません');repo.save('cashflow_transactions',{id:l.transactionId,status:'取消'});}
 function save(b){
  if(b.applyDefaults!=null&&typeof b.applyDefaults!=='boolean')throw Error('変更の反映方法を確認してください');
  if(!Array.isArray(b.rows)||b.rows.length>1000)throw Error('予定表は1000行以内にしてください');
  const old=one('payment_schedules',id(b.id));version(old,b.expectedVersion);
  if(old?.archivedAt)throw Error('終了した予定表は編集できません');
  const m=normalizedMaster(b,old),existing=rows(m.id);
  if(old&&existing.length&&m.kind!==old.kind)throw Error('予定作成後は種類を変更できません');
  const hasActual=existing.some(o=>legs(o).some(actual)||historical(o));
  if(hasActual&&['principalStartMode','originalPrincipal','loanDate','principalBalanceDate','principalOpeningBalance'].some(k=>m[k]!==old[k]))throw Error('実績登録後は借入基準情報を変更できません');
  const unique=new Set();
  const additions=b.rows.filter(r=>!existing.some(o=>o.id===r.id)).length;
  if(existing.length+additions>1000)throw Error('予定表は1000回以内にしてください');
  put('payment_schedules',m);
  for(const input of b.rows){
   id(input.id);if(unique.has(input.id))throw Error('同じ行IDが重複しています');unique.add(input.id);
   const oldRow=one('payment_schedule_occurrences',input.id);
   if(oldRow&&oldRow.scheduleId!==m.id)throw Error('他の予定表の行は変更できません');
   const ls=oldRow?legs(oldRow):[];
   // Defaults apply only to completely unpaid future rows without an override.
   const apply=!!b.applyDefaults&&oldRow&&!oldRow.cancelledAt&&oldRow.paymentDate>today()&&!ls.some(actual)&&!historical(oldRow)&&!pendingOverride(oldRow)&&!oldRow.debitModeOverride;
   const data=normalizeRow(input,m,oldRow,apply);
   if(oldRow&&pendingOverride(oldRow)&&data.nominalDate===oldRow.nominalDate)data.paymentDate=oldRow.paymentDate;
   const changed=!oldRow||Object.keys(data).some(k=>data[k]!==oldRow[k]);
   if(!changed)continue;
   if(oldRow){
    if(pendingOverride(oldRow))throw Error('個別に処理した回は保護されています。明細から操作してください');
    if(oldRow.cancelledAt||ls.some(actual)||historical(oldRow))throw Error('確定済み実績・取消済み・訂正履歴のある回は編集できません');
    if(oldRow.paymentDate<=today())throw Error('将来の未実績回だけ変更できます');
    if(data.paymentDate<=today())throw Error('変更後の支払日も将来日にしてください');
    ls.forEach(cancelLeg);
   }
   const o={...data,revision:(oldRow?.revision||0)+1,version:(oldRow?.version||0)+1,cancelledAt:null};
   put('payment_schedule_occurrences',o);createLegs(o);
  }
  return {success:true,id:m.id,version:m.version};
 }
 function confirm(b){
  const l=one('payment_schedule_legs',id(b.id));if(!l)throw Error('銀行明細が見つかりません');
  const o=one('payment_schedule_occurrences',l.occurrenceId),m=one('payment_schedules',o.scheduleId),t=repo.find('cashflow_transactions',l.transactionId);
  version(m,b.expectedVersion);
  if(o.revision!==l.revision||t.status==='取消'||actual(t))throw Error('確定済み実績または取消済み明細です');
  if(b.settled!==true)throw Error('この明細の全額決済を確認してください。分割決済は未対応です');
  const date=day(b.actualDate);if(date>today())throw Error('実績日は今日以前にしてください');
  let principal=null,interest=null,amount;
  if(o.kind==='loan'){
   principal=l.component==='interest'?0:money(b.actualPrincipal);
   interest=l.component==='principal'?0:money(b.actualInterest);
   amount=sum(principal,interest);
  }else amount=money(b.actualAmount);
  if(amount<=0)throw Error('実績額は1円以上にしてください。支払不要の場合は予定を取消してください');
  repo.save('cashflow_transactions',{id:t.id,status:'確定',actualDate:date,actualAmount:amount});
  put('payment_schedule_legs',{...l,actualPrincipal:principal,actualInterest:interest});
  put('payment_schedule_occurrences',{...o,version:o.version+1});put('payment_schedules',{...m,version:m.version+1});
  return {success:true,id:l.id,version:m.version+1};
 }
 function cancel(b){
  const o=one('payment_schedule_occurrences',id(b.id));if(!o)throw Error('予定が見つかりません');
  const m=one('payment_schedules',o.scheduleId);version(m,b.expectedVersion);
  if(o.cancelledAt)throw Error('取消済みです');
  const ls=legs(o);if(ls.every(actual))throw Error('確定済み実績は変更できません');
  ls.filter(l=>!actual(l)).forEach(cancelLeg);
  put('payment_schedule_occurrences',{...o,cancelledAt:new Date().toISOString(),version:o.version+1});put('payment_schedules',{...m,version:m.version+1});
  return {success:true,id:o.id};
 }
 function editLeg(b){
  const l=one('payment_schedule_legs',id(b.id));if(!l)throw Error('明細が見つかりません');
  const o=one('payment_schedule_occurrences',l.occurrenceId),m=one('payment_schedules',o.scheduleId),t=repo.find('cashflow_transactions',l.transactionId);
  version(m,b.expectedVersion);
  if(o.cancelledAt||o.revision!==l.revision||actual(t)||t.status!=='予定')throw Error('未実績の明細だけ変更できます');
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='transaction_origins'").get()&&db.prepare('SELECT 1 FROM transaction_origins WHERE transactionId=?').get(t.id))throw Error('実績履歴のある元予定は保持します。再確定後に実績訂正を使用してください');
  if(t.plannedDate<=today())throw Error('将来の未実績明細だけ変更できます');
  const date=day(b.plannedDate),amount=money(b.plannedAmount);
  if(date<=today()||amount<=0)throw Error('将来の日付と1円以上の金額を入力してください');
  if(l.component==='total')throw Error('合算は予定表の回から編集してください');
  const updated={...o,version:o.version+1,[l.component==='principal'?'plannedPrincipal':'plannedInterest']:amount};sum(updated.plannedPrincipal,updated.plannedInterest);
  put('payment_schedule_occurrences',updated);repo.save('cashflow_transactions',{id:t.id,plannedDate:date,plannedAmount:amount});put('payment_schedules',{...m,version:m.version+1});
  return {success:true,id:l.id};
 }
 function get(key,at=today()){
  day(at);if(key)id(key);
  return repo.readTransaction(()=>{
   const masters=key?[one('payment_schedules',key)].filter(Boolean):all('payment_schedules');
   return {data:masters.map(m=>{
    const occurrences=rows(m.id).map(o=>{
     const ls=legs(o),paid=ls.filter(actual).length,cancelled=ls.filter(l=>l.status==='取消').length;
     const status=paid===ls.length&&ls.length?'支払済':paid?(cancelled?'一部支払・残予定取消':'一部支払'):cancelled===ls.length?'取消':cancelled?'一部取消':'未支払';
     return {...o,legs:ls,status,hasHistory:historical(o),total:o.kind==='loan'?sum(o.plannedPrincipal,o.plannedInterest):o.plannedAmount};
    });
    const paid=occurrences.flatMap(o=>o.legs).filter(l=>actual(l)&&l.actualDate<=at);
    const principalPaid=paid.filter(l=>l.actualDate>m.principalBalanceDate).reduce((s,l)=>s+(l.actualPrincipal||0),0);
    const interestPaid=paid.reduce((s,l)=>s+(l.actualInterest||0),0);
    return {...m,occurrences,principalRemaining:m.kind==='loan'&&at>=m.principalBalanceDate?m.principalOpeningBalance-principalPaid:null,interestPaid};
   })};
  });
 }
 function pendingLeg(b,cancelled){
  const l=one('payment_schedule_legs',id(b.id));if(!l)throw Error('明細が見つかりません');
  const o=one('payment_schedule_occurrences',l.occurrenceId),m=one('payment_schedules',o.scheduleId),t=repo.find('cashflow_transactions',l.transactionId);
  version(m,b.expectedVersion);
  if(o.cancelledAt||l.revision!==o.revision||actual(t)||t.status!=='予定')throw Error('未確定の明細だけ処理できます');
  if(!cancelled&&db.prepare('SELECT 1 FROM transaction_origins WHERE transactionId=?').get(t.id))throw Error('実績履歴のある元予定は保持します');
  if(cancelled)cancelLeg(l);else repo.save('cashflow_transactions',{id:t.id,plannedDate:day(b.plannedDate)});
  repo.saveSetting('pending_leg_override_'+t.id,JSON.stringify({originalDate:t.plannedDate,operation:cancelled?'cancel':'reschedule'}));
  const current=legs(o),allCancelled=current.every(x=>x.status==='取消');
  // The nominal date and settled sibling legs remain unchanged. A split leg has its own payment date.
  put('payment_schedule_occurrences',{...o,paymentDate:!cancelled&&l.component==='total'?b.plannedDate:o.paymentDate,cancelledAt:allCancelled?new Date().toISOString():o.cancelledAt,version:o.version+1});
  put('payment_schedules',{...m,version:m.version+1});return {success:true,id:l.id};
 }
 function dates(p){
  const start=day(p.start+'-01'),count=Number(p.count),dd=p.day==='last'?31:Number(p.day),rule=choice(p.rule,['none','next','previous']);
  if(!Number.isInteger(count)||count<1||count>1000||!Number.isInteger(dd)||dd<1||dd>31)throw Error('回数・支払日を確認してください');
  const [y,m]=start.split('-').map(Number),data=[];
  for(let i=0;i<count;i++){const d=new Date(Date.UTC(y,m-1+i+1,0));d.setUTCDate(Math.min(dd,d.getUTCDate()));const nominalDate=d.toISOString().slice(0,10);day(nominalDate);data.push({nominalDate,paymentDate:adjustDate(nominalDate,rule)});}
  return {data};
 }
 function post(b,actor){
  if(!b||typeof b!=='object')throw Error('入力を確認してください');id(b.requestId);
  if(!['scheduleSave','scheduleConfirm','scheduleCancel','scheduleEditLeg','scheduleArchive','scheduleReschedule','scheduleCancelLeg'].includes(b.action))throw Error('操作が不正です');
  return repo.transaction(()=>{
   const key='schedule_request_'+b.requestId,digest=hash(b),prior=repo.setting(key);
   if(prior){const data=JSON.parse(prior);if(data.hash!==digest)throw Error('同じ再送IDで内容が異なります');return {...data.result,duplicate:true};}
   let result;
   if(b.action==='scheduleSave')result=save(b);
   else if(b.action==='scheduleConfirm')result=confirm(b);
   else if(b.action==='scheduleCancel')result=cancel(b);
   else if(b.action==='scheduleEditLeg')result=editLeg(b);
   else if(b.action==='scheduleReschedule')result=pendingLeg(b,false);
   else if(b.action==='scheduleCancelLeg')result=pendingLeg(b,true);
   else{const m=one('payment_schedules',id(b.id));if(!m)throw Error('予定表が見つかりません');version(m,b.expectedVersion);put('payment_schedules',{...m,archivedAt:new Date().toISOString(),version:m.version+1});result={success:true,id:m.id};}
   checkIntegrity(db);repo.saveSetting(key,JSON.stringify({hash:digest,result}));repo.audit(actor,b.action,b.id);return result;
  });
 }
 return {post,get,dates};
};
module.exports.checkIntegrity=checkIntegrity;
