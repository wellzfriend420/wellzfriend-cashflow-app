'use strict';
const ActualCorrections=(()=>{
 const e=v=>escapeHtml(String(v??'')),q=id=>document.getElementById(id);
 const labels={correctActual:'確定実績の訂正',cancelActual:'実績を取消',reopenActual:'確定解除して元予定へ戻す'};
 const names={actualDate:'実績日',type:'入金／出金',actualAmount:'実績金額',account:'口座',partner:'取引先',description:'摘要／内容',memo:'メモ',status:'状態'};
 const safe=fn=>async(...args)=>{try{await fn(...args);}catch(err){showToast(err.message,'error');}};
 const account=(id,accounts)=>{const a=accounts.find(a=>a.id===id);return a?[a.bank,a.branch,a.type,a.accountNumber].filter(Boolean).join(' '):id;};
 function modal(title,body,footer=''){closeModal();showModal(`<div class="modal-title">${e(title)}</div><div class="modal-body">${body}</div><div class="modal-footer" style="flex-wrap:wrap">${footer}</div>`);}
 function summary(t,accounts){return `<dl class="correction-summary">${Object.entries(names).map(([k,label])=>`<div><dt>${label}</dt><dd>${e(k==='account'?account(t[k],accounts):k==='actualAmount'&&t[k]!=null?fmtMoney(t[k]):t[k]??'―')}</dd></div>`).join('')}</dl>`;}
 function historyHtml(d){return d.history.map(h=>`<details><summary>${e(h.createdAt)} ${e(labels[h.action])} ／ ${e(h.actorName)}</summary><p>変更理由：${e(h.reason)}</p><h4>変更前</h4>${summary(h.before.transaction,d.accounts)}${breakdown(h.before)}<h4>変更後</h4>${summary(h.after.transaction,d.accounts)}${breakdown(h.after)}</details>`).join('')||'<p>訂正・取消履歴はありません。</p>';}
 function breakdown(s){return s.leg?`<p>実績元本：${e(s.leg.actualPrincipal==null?'―':fmtMoney(s.leg.actualPrincipal))} ／ 実績利息：${e(s.leg.actualInterest==null?'―':fmtMoney(s.leg.actualInterest))}</p>`:s.debt?`<p>決済済額：${e(fmtMoney(s.debt.paidAmount))} ／ ${e(s.debt.status)}</p>`:'';}
 async function open(id){
  const d=await gasApi('getActualDetail',{id}),t=d.transaction;
  const source=d.origin?.kind==='migration'?`<details><summary>Excel移行元（変更できません）</summary><p>案件：${e(d.origin.migrationId)}<br>原本：${e(d.origin.sourceFile)}<br>${e(d.origin.sheet)}!${e(d.origin.cell)}</p><p style="overflow-wrap:anywhere">SHA256：${e(d.origin.fileHash)}</p><h4>移行時の内容</h4>${summary(d.origin.original,d.accounts)}</details>`:'';
  modal(t.status==='確定'?'確定実績の詳細':'実績の履歴',summary(t,d.accounts)+breakdown(d)+source+`<h3>訂正・取消履歴</h3>${historyHtml(d)}`,
   (t.status==='確定'?'<button class="btn btn-primary" id="ac_edit">実績のまま訂正</button><button class="btn btn-danger" id="ac_cancel">実績を取消</button>'+(d.canReopen?'<button class="btn btn-outline" id="ac_reopen">元予定へ戻す</button>':''):'')+'<button class="btn btn-outline" onclick="closeModal()">閉じる</button>');
  if(t.status==='確定'){q('ac_edit').onclick=()=>form(d,'correctActual');q('ac_cancel').onclick=()=>form(d,'cancelActual');if(d.canReopen)q('ac_reopen').onclick=()=>form(d,'reopenActual');}
 }
 function field(key,label,value,type='text'){return `<label class="form-label" for="ac_${key}">${label}</label><input class="form-input" id="ac_${key}" type="${type}" value="${e(value)}">`;}
 function form(d,action,draft){
  const t=d.transaction,loan=d.occurrence?.kind==='loan',edit=action==='correctActual',v=draft||{...t,actualPrincipal:d.leg?.actualPrincipal,actualInterest:d.leg?.actualInterest};
  let body=edit?field('actualDate','実績日',v.actualDate,'date')+`<label class="form-label" for="ac_type">入金／出金</label><select class="form-select" id="ac_type" ${d.typeEditable?'':'disabled'}>${['入金','出金'].map(x=>`<option ${x===v.type?'selected':''}>${x}</option>`).join('')}</select><label class="form-label" for="ac_account">口座（口座番号まで確認してください）</label><select class="form-select" id="ac_account">${d.accounts.map(a=>`<option value="${e(a.id)}" ${a.id===v.account?'selected':''}>${e(account(a.id,d.accounts))}</option>`).join('')}</select>`:'';
  if(edit){
   if(loan)body+=(d.leg.component!=='interest'?field('actualPrincipal','実績元本',v.actualPrincipal,'number'):'')+(d.leg.component!=='principal'?field('actualInterest','実績利息',v.actualInterest,'number'):'')+'<p id="ac_total"></p>';
   else body+=field('actualAmount','実績金額',v.actualAmount,'number');
   body+=field('partner','取引先',v.partner||'')+field('description','摘要／内容',v.description||'')+`<label class="form-label" for="ac_memo">メモ</label><textarea class="form-textarea" id="ac_memo">${e(v.memo||'')}</textarea><p>確定実績として保存します。当初の予定と移行元情報は保持します。</p>`;
  }else body+=summary(t,d.accounts)+(action==='cancelActual'?'<p>この実績を残高計算から除外します。明細と変更前の内容は履歴として残ります。</p>':'<p>この実績を残高計算から除外し、保存された元の予定へ戻します。</p>');
  if(d.debt)body+='<p>元の売掛・買掛の決済済額も連動して更新します。取消・確定解除では未決済残額が増え、残額の予定が再表示されます。請求・債務自体の取消ではありません。</p>';
  if(loan)body+='<p>銀行残高は引落合計、借入残元本は実績元本で再計算します。別引落の相手明細は変更しません。</p>';
  body+=`<label class="form-label" for="ac_reason">変更理由（必須）</label><textarea id="ac_reason" class="form-textarea" maxlength="1000">${e(draft?.reason||'')}</textarea><p>残高基準日以前の実績を変更しても、設定済みの基準残高は自動変更しません。基準日の翌日以降の実績だけが、基準残高からの積み上げに反映されます。</p><label><input type="checkbox" id="ac_basis" ${draft?.acknowledgeBaseline?'checked':''}>基準日以前に関わる変更の場合、この扱いを確認しました</label>`;
  modal(labels[action],body,'<button class="btn btn-outline" id="ac_back">戻る</button><button class="btn btn-primary" id="ac_review">変更内容を確認</button>');
  const amount=id=>{const s=q(id).value;if(s===''||!/^\d+$/.test(s)||!Number.isSafeInteger(Number(s)))throw Error('金額は0以上の整数円を入力してください');return Number(s);};
  if(edit&&loan){const total=()=>{q('ac_total').textContent='引落合計：'+fmtMoney(Number(q('ac_actualPrincipal')?.value||0)+Number(q('ac_actualInterest')?.value||0));};if(d.leg.component!=='interest')q('ac_actualPrincipal').oninput=total;if(d.leg.component!=='principal')q('ac_actualInterest').oninput=total;total();}
  q('ac_back').onclick=safe(()=>open(t.id));
  q('ac_review').onclick=safe(async()=>{
   const b={id:t.id,expectedUpdatedAt:t.updatedAt,reason:q('ac_reason').value,confirmed:true,acknowledgeBaseline:q('ac_basis').checked};
   if(!b.reason.trim())throw Error('変更理由を入力してください');
   if(d.master)b.expectedParentVersion=d.master.version;if(d.debt)b.expectedParentVersion=d.debt.updatedAt;
   if(edit){for(const k of ['actualDate','type','account','partner','description','memo'])b[k]=q('ac_'+k).value;
    if(loan){b.actualPrincipal=d.leg.component==='interest'?0:amount('ac_actualPrincipal');b.actualInterest=d.leg.component==='principal'?0:amount('ac_actualInterest');b.actualAmount=b.actualPrincipal+b.actualInterest;}else b.actualAmount=amount('ac_actualAmount');
   }
   review(d,action,b);
  });
 }
 function review(d,action,b){
  const t=d.transaction,next=action==='correctActual'?{...t,...b}:action==='reopenActual'&&!d.debt?{...(d.origin?.plan||t),status:'予定',actualDate:null,actualAmount:null}:{...t,status:'取消',actualDate:null,actualAmount:null};
  modal('最終確認：'+labels[action],`<h3>変更前</h3>${summary(t,d.accounts)}${breakdown(d)}<h3>変更後</h3>${summary(next,d.accounts)}${d.occurrence?.kind==='loan'?`<p>実績元本 ${e(action==='correctActual'?fmtMoney(b.actualPrincipal):'除外')} ／ 実績利息 ${e(action==='correctActual'?fmtMoney(b.actualInterest):'除外')}</p>`:''}<p>理由：${e(b.reason)}</p><p>対象口座の残高を再計算します。口座変更の場合は変更前・変更後の両口座に反映します。</p>`,'<button class="btn btn-outline" id="ac_back">入力へ戻る</button><button class="btn btn-danger" id="ac_save">この内容で保存</button>');
  const requestId=crypto.randomUUID();
  q('ac_back').onclick=()=>form(d,action,b);
  q('ac_save').onclick=safe(async()=>{await gasPost(action,{...b,requestId});closeModal();await loadCashflowMonth(APP.currentMonth);showToast('変更を保存しました。残高を再計算しました','success');});
 }
 async function history(){
  const {data}=await gasApi('getActualHistory');
  modal('実績の訂正・取消履歴','<p>新しい順に最大500件。各明細の詳細には全履歴を表示します。</p>'+data.map(h=>`<button class="btn btn-outline correction-history" data-transaction="${e(h.transactionId)}">${e(h.createdAt)} ／ ${e(labels[h.action])}<br>${e(h.actualDate)} ${e(h.description||'摘要なし')} ／ ${e(h.actorName)}<br>${e(h.reason)}</button>`).join(''),'<button class="btn btn-outline" onclick="closeModal()">閉じる</button>');
  document.querySelectorAll('.correction-history').forEach(b=>b.onclick=safe(()=>open(b.dataset.transaction)));
 }
 return {open:safe(open),history:safe(history)};
})();
