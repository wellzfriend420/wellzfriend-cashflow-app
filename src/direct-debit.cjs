'use strict';
const {createHash}=require('node:crypto');
const CONFIG='directDebitNotification';
const clean=v=>String(v||'').replace(/[\r\n\t]/g,' ').slice(0,120);
const yen=n=>n.toLocaleString('ja-JP')+'円';
const add=(a,b)=>{if(!Number.isSafeInteger(b)||b<0||!Number.isSafeInteger(a+b))throw Error('通知金額を確認してください');return a+b;};
function clock(now){
 const local=new Date(now.getTime()+9*3600000).toISOString();
 return {day:local.slice(0,10),hour:Number(local.slice(11,13)),tomorrow:new Date(Date.parse(local.slice(0,10)+'T00:00:00Z')+86400000).toISOString().slice(0,10)};
}
function createNotifications(store,ledger,{allowed=false,target='',origin='',companyName='',now=()=>new Date()}={}){
 const config=()=>JSON.parse(store.setting(CONFIG)||'{"enabled":false,"selected":[],"version":0}');
 function candidates(){
  const accounts=new Map(store.all('accounts').map(a=>[a.id,clean([a.bank,a.branch].filter(Boolean).join(' '))]));
  const rows=[];
  for(const f of store.all('fixed_expenses'))rows.push({key:'fixed:'+f.id,label:'固定支出：'+clean(f.name),account:accounts.get(f.account)});
  for(const s of store.db.prepare('SELECT id,name,account FROM payment_schedules').all())rows.push({key:'schedule:'+s.id,label:'支払予定表：'+clean(s.name),account:accounts.get(s.account)});
  for(const t of store.all('cashflow_transactions'))if(['manual','payable'].includes(t.source)&&t.type==='出金'&&t.status==='予定'&&!t.actualDate)rows.push({key:'transaction:'+t.id,label:clean(t.plannedDate)+' '+clean(t.partner)+' '+clean(t.description)+' '+yen(t.plannedAmount),account:accounts.get(t.account)});
  return rows;
 }
 function save(body,actor){return store.transaction(()=>{
  const old=config();
  if(body.version!==old.version)throw Error('他の操作で更新されています。再読込してください');
  if(typeof body.enabled!=='boolean'||!Array.isArray(body.selected)||body.selected.length>10000||body.selected.some(k=>typeof k!=='string'))throw Error('通知設定を確認してください');
  const valid=new Set(candidates().map(x=>x.key));
  if(body.selected.some(k=>!valid.has(k)&&!old.selected.includes(k)))throw Error('通知対象が見つかりません');
  const v={enabled:body.enabled,selected:[...new Set(body.selected)].sort(),version:old.version+1};
  store.saveSetting(CONFIG,JSON.stringify(v));store.audit(actor,'saveDirectDebitNotification','settings');return {success:true};
 });}
 function collect(date){
  const selected=new Set(config().selected),accounts=new Map(store.all('accounts').map(a=>[a.id,a]));
  const parents=new Map(store.db.prepare('SELECT l.id,o.scheduleId FROM payment_schedule_legs l JOIN payment_schedule_occurrences o ON o.id=l.occurrenceId WHERE l.revision=o.revision AND o.cancelledAt IS NULL').all().map(x=>[x.id,x.scheduleId]));
  const rows=ledger.get('getTransactions',{month:date.slice(0,7)}).data.filter(t=>t.type==='出金'&&t.status==='予定'&&t.actualDate==null&&t.plannedDate===date&&Number(t.plannedAmount)>0).filter(t=>
   t.source==='fixed_expense'?selected.has('fixed:'+t.sourceId):t.source==='payment_schedule'?parents.has(t.sourceId)&&selected.has('schedule:'+parents.get(t.sourceId)):['manual','payable'].includes(t.source)&&selected.has('transaction:'+t.id));
  rows.sort((a,b)=>a.account.localeCompare(b.account)||a.id.localeCompare(b.id));
  let total=0;const sums=new Map();
  for(const t of rows){if(!accounts.has(t.account))throw Error('通知先口座を確認してください');total=add(total,t.plannedAmount);sums.set(t.account,add(sums.get(t.account)||0,t.plannedAmount));}
  const accountName=id=>clean([accounts.get(id).bank,accounts.get(id).branch].filter(Boolean).join(' '));
  const accountTotals=[...sums].map(([id,amount])=>({id,label:accountName(id),amount}));
  const header=clean(companyName)+'\n明日（'+date+'）、自動引落予定があります。\n\n';
  const footer='\n明日の引落予定合計：'+yen(total)+'\n\n口座別合計\n'+accountTotals.map(a=>a.label+'：'+yen(a.amount)).join('\n')+'\n\n通知作成時点の未確定予定です。最新情報：\n'+origin;
  let details='';let included=0;
  for(const t of rows){const line='・'+[clean(t.partner),clean(t.description)].filter(Boolean).join(' ')+'　'+yen(t.plannedAmount)+'\n　'+accountName(t.account)+'\n';if((header+details+line+footer).length>4700)break;details+=line;included++;}
  const text=header+details+(included<rows.length?'ほか'+(rows.length-included)+'件（詳細はアプリで確認）\n':'')+footer;
  if(text.length>5000)throw Error('通知文が長すぎます。口座数を確認してください');
  return {date,count:rows.length,total,accountTotals,transactionIds:rows.map(t=>t.id),text};
 }
 function prepare(){return store.transaction(()=>{
  if(!allowed||!config().enabled)return {send:false,reason:'disabled'};
  if(!/^[UCR][0-9a-f]{32}$/.test(target))throw Error('LINE送信先が未設定です');
  const c=clock(now());if(c.hour<10)return {send:false,reason:'before_10_jst'};
  const key='directDebitBatch_'+c.day;
  const old=store.setting(key);
  if(old){const batch=JSON.parse(old);return batch.status==='pending'?{send:true,...batch}:{send:false,reason:batch.status};}
  const data=collect(c.tomorrow);
  // Stable across retries, concurrent runs and a same-day restore of the tenant DB.
  const h=createHash('sha256').update(origin+'|direct-debit|'+c.day).digest('hex');
  const retryKey=h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
  const batch={day:c.day,status:data.count?'pending':'empty',retryKey,expiresAt:c.tomorrow+'T00:00:00+09:00',payload:{to:target,messages:[{type:'text',text:data.text}]},transactionIds:data.transactionIds,count:data.count};
  store.saveSetting(key,JSON.stringify(batch));
  return data.count?{send:true,...batch}:{send:false,reason:'empty'};
 });}
 function acknowledge(body){return store.transaction(()=>{
  const c=clock(now());
  if(body.day!==c.day)throw Error('通知日が一致しません');
  const key='directDebitBatch_'+c.day,batch=JSON.parse(store.setting(key)||'null');
  if(!batch||batch.retryKey!==body.retryKey||!['pending','sent'].includes(batch.status))throw Error('通知記録が一致しません');
  if(typeof body.requestId!=='string'||! /^[a-zA-Z0-9-]{1,100}$/.test(body.requestId))throw Error('LINE受付結果を確認してください');
  if(batch.status!=='sent'){batch.status='sent';batch.acceptedAt=now().toISOString();batch.requestId=body.requestId;store.saveSetting(key,JSON.stringify(batch));}
  return {success:true};
 });}
 return {save,collect,prepare,acknowledge,settings:()=>store.readTransaction(()=>({...config(),available:allowed,recipientConfigured:/^[UCR][0-9a-f]{32}$/.test(target),candidates:candidates(),preview:collect(clock(now()).tomorrow),todayStatus:JSON.parse(store.setting('directDebitBatch_'+clock(now()).day)||'null')?.status||'not_run'}))};
}
module.exports={createNotifications,clock};
