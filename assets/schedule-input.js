(function(root){
 'use strict';
 function date(value){
  const s=value.trim().replaceAll('/','-'),m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(!m)throw Error('日付は年を含む YYYY/MM/DD で入力してください');
  const key=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
  if(isNaN(Date.parse(key))||new Date(key+'T00:00:00Z').toISOString().slice(0,10)!==key)throw Error('存在しない日付です');return key;
 }
 function amount(value){const s=String(value).trim().replaceAll(',','');if(!/^\d+$/.test(s)||!Number.isSafeInteger(Number(s)))throw Error('金額は整数円を入力してください');return Number(s);}
 function parse(text,loan){
  return text.split(/\r?\n/).filter(s=>s.trim()).map((line,i)=>{
   const cells=line.split('\t');if(cells.length!==(loan?3:2))throw Error((i+1)+'行目: '+(loan?'日付・元本・利息の3列':'日付・金額の2列')+'を貼り付けてください');
   try{const row={nominalDate:date(cells[0])};if(loan){row.plannedPrincipal=amount(cells[1]);row.plannedInterest=amount(cells[2]);if(!Number.isSafeInteger(row.plannedPrincipal+row.plannedInterest)||row.plannedPrincipal+row.plannedInterest<=0)throw Error('合計は1円以上の整数円です');}else{row.plannedAmount=amount(cells[1]);if(!row.plannedAmount)throw Error('金額は1円以上です');}return row;}catch(e){throw Error((i+1)+'行目: '+e.message);}
  });
 }
 function exportRows(master){
  const rows=[['予定表','種類','回ID','名目日','予定日','引落方式','予定元本','予定利息','予定合計','実績元本','実績利息','実績合計','元本実績日','利息実績日','状態','銀行明細ID']];
  for(const o of master.occurrences){const paid=o.legs.filter(l=>l.actualDate),loan=o.kind==='loan';
   const value=k=>paid.length?paid.reduce((s,l)=>s+Number(l[k]||0),0):'';
   rows.push([o.name,o.kind,o.id,o.nominalDate,o.paymentDate,o.effectiveDebitMode,loan?o.plannedPrincipal:'',loan?o.plannedInterest:'',o.total,loan?value('actualPrincipal'):'',loan?value('actualInterest'):'',value('actualAmount'),paid.filter(l=>l.component!=='interest').map(l=>l.actualDate).join(', '),loan?paid.filter(l=>l.component!=='principal').map(l=>l.actualDate).join(', '):'',o.status,o.legs.map(l=>l.transactionId).join(', ')]);
  }return rows;
 }
 function parseAmounts(text,loan){return text.split(/\r?\n/).filter(s=>s.trim()).map((line,i)=>{const c=line.split('\t');if(c.length!==(loan?2:1))throw Error((i+1)+'行目の金額列数を確認してください');return loan?{plannedPrincipal:amount(c[0]),plannedInterest:amount(c[1])}:{plannedAmount:amount(c[0])};});}
 const api={parse,parseAmounts,date,amount,exportRows};if(typeof module!=='undefined')module.exports=api;root.ScheduleInput=api;
})(typeof globalThis!=='undefined'?globalThis:this);
