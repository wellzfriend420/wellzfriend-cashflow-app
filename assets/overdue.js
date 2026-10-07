/* Overdue review never writes until an explicit operation is submitted. */
const Overdue = (() => {
  let items=[];
  const esc=escapeHtml;
  function modal(html){closeModal();showModal(html);}
  function banner(id,transactions,accounts,reference,warningAccounts=accounts){
    const el=document.getElementById(id);if(!el)return;
    const d=CashflowMath.overdue(transactions,warningAccounts.map(a=>a.id),toDateKey(today));
    const selected=CashflowMath.overdue(transactions,accounts.map(a=>a.id),toDateKey(today));
    el.innerHTML=d.data.length?`<div class="alert-banner alert-amber" role="alert"><div><strong>⚠ 期限を過ぎた未確定の予定があります。</strong><p>支払い・入金忘れですか？<br>それとも確定忘れですか？</p><p>期限超過（全口座）：入金 ${d.income.count}件／${fmtMoney(d.income.amount)}<br>出金 ${d.expense.count}件／${fmtMoney(d.expense.amount)}</p><button class="btn btn-outline" onclick="Overdue.open()">未確定の予定を確認する</button><p>基本予測には含めていません。件数は銀行明細単位です。</p></div></div>`:'';
    if(reference!=null)el.innerHTML+=`<p>期限超過分もすべて今後発生すると仮定した場合：${fmtMoney(reference+selected.income.amount-selected.expense.amount)}<br><small>表示対象口座の基本予測＋同じ口座の期限超過未確定入金－期限超過未確定出金。実際の処理状況を確認するための参考値です。</small></p>`;
  }
  async function open(){
    try{
      const response=await gasApi('getOverdue');items=response.data;today=parseDate(response.day);
      modal(`<div class="modal-title">期限超過した未確定予定</div><div class="modal-body"><p>元の予定日を表示しています。確認するだけでは変更されません。</p><p>入金 ${response.income.count}件／${fmtMoney(response.income.amount)}　出金 ${response.expense.count}件／${fmtMoney(response.expense.amount)}</p>${items.length?items.map((t,i)=>`<div class="card" style="padding:12px"><strong>${esc(t.plannedDate)} ${esc(t.type)} ${fmtMoney(t.plannedAmount)}</strong><p>${esc(t.partner)} ${esc(t.description)}<br>${esc(accountDisplayName(APP.accounts.find(a=>a.id===t.account)))}</p><button class="btn btn-outline" onclick="Overdue.choose(${i})">処理方法を選ぶ</button></div>`).join(''):'<p>期限超過した未確定予定はありません。</p>'}<button class="btn btn-outline" onclick="closeModal()">閉じる</button></div>`);
    }catch(e){showToast(e.message,'error');}
  }
  function choose(i){
    const t=items[i];
    modal(`<div class="modal-title">未確定予定の確認</div><div class="modal-body"><p>${esc(t.partner)} ${esc(t.description)}<br>元予定：${esc(t.plannedDate)}／${fmtMoney(t.plannedAmount)}</p><p>処理方法を明示的に選択してください。</p><button class="btn btn-primary" onclick="Overdue.form(${i},'scheduled')">予定どおりの日付・金額で確定</button><button class="btn btn-outline" onclick="Overdue.form(${i},'actual')">実際の日付／金額を指定して確定</button><button class="btn btn-outline" onclick="Overdue.open()">未確定のまま残す</button><button class="btn btn-outline" onclick="Overdue.form(${i},'reschedule')">予定日を変更</button><button class="btn btn-outline" onclick="Overdue.form(${i},'cancel')">この未確定明細を取消</button></div>`);
  }
  function form(i,operation){
    const t=items[i],m=t.schedule,o=m?.occurrences.find(o=>o.legs.some(l=>l.transactionId===t.id)),l=o?.legs.find(l=>l.transactionId===t.id),confirming=['scheduled','actual'].includes(operation),loan=m?.kind==='loan';
    const field=(label,id,type,value)=>`<label>${label}<input class="form-input" id="${id}" type="${type}" value="${esc(value)}" ${type==='number'?'min="0" step="1"':''}></label>`;
    const amounts=operation==='actual'?(loan?`${l.component!=='interest'?field('実績元本（円）','odPrincipal','number',o.plannedPrincipal):''}${l.component!=='principal'?field('実績利息（円）','odInterest','number',o.plannedInterest):''}`:field('実績額（円）','odAmount','number',t.plannedAmount)):'';
    modal(`<div class="modal-title">${{scheduled:'予定どおりに確定',actual:'実際の日付・金額で確定',reschedule:'予定日を変更',cancel:'未確定明細を取消'}[operation]}</div><div class="modal-body"><p>${esc(t.plannedDate)}／${fmtMoney(t.plannedAmount)} ${esc(t.description)}</p>${operation==='actual'||operation==='reschedule'?field(operation==='actual'?'実績日（必須）':'変更後の予定日（必須）','odDate','date',''):''}${amounts}${confirming?`<p>口座残高基準日：${esc(APP.accounts.find(a=>a.id===t.account)?.balanceDate)}${loan?'<br>借入残元本基準日：'+esc(m.principalBalanceDate):''}</p><label><input id="odBaseline" type="checkbox">基準日以前の実績を登録する場合、基準残高に含まれることを確認しました</label>`:''}${confirming&&m?'<p><label><input id="odSettled" type="checkbox">この銀行明細の全額決済を確認しました</label></p>':''}${operation==='cancel'?'<p>この未確定明細だけを取消します。登録済み実績は保持します。売掛・買掛は未決済残額の取消であり、入金・支払実績にはなりません。</p>':''}<p id="odError" role="alert"></p><button id="odSubmit" class="btn btn-primary" onclick="Overdue.submit(${i},'${operation}')">${confirming?'この内容で確定する':operation==='cancel'?'取消を実行する':'この日付へ変更する'}</button><button class="btn btn-outline" onclick="Overdue.choose(${i})">戻る</button></div>`);
  }
  async function submit(i,operation){
    const t=items[i],button=document.getElementById('odSubmit'),read=id=>document.getElementById(id),number=id=>{const v=read(id)?.value;return v==null?0:v===''?null:Number(v);};
    button.disabled=true;
    try{
      // Retain the request ID after a lost response; a retry cannot double-book a payment.
      button.dataset.requestId ||= crypto.randomUUID();
      await gasPost('resolveOverdue',{id:t.id,requestId:button.dataset.requestId,operation,expectedUpdatedAt:t.updatedAt,expectedVersion:t.schedule?.version,date:read('odDate')?.value,amount:number('odAmount'),actualPrincipal:number('odPrincipal'),actualInterest:number('odInterest'),settled:read('odSettled')?.checked===true,acknowledgeBaseline:read('odBaseline')?.checked===true});
      if(APP.currentPage==='home')await loadHome();else if(APP.currentPage==='cashflow')await loadCashflowMonth(APP.currentMonth);
      else if(APP.currentPage==='receivables')await loadReceivables();else if(APP.currentPage==='payables')await loadPayables();
      await open();
    }catch(e){read('odError').textContent=e.message;button.disabled=false;}
  }
  async function openId(id){await open();const i=items.findIndex(t=>t.id===id);if(i>=0)choose(i);}
  return {banner,open,openId,choose,form,submit};
})();
