'use strict';
const PaymentSchedules=(()=>{
 const uid=()=>crypto.randomUUID(),e=v=>escapeHtml(String(v??'')),q=s=>document.querySelector(s);
 const field=(key,label,value='',type='text')=>`<label class="ps-field">${label}<input id="ps_${key}" type="${type}" value="${e(value)}" class="form-input"></label>`;
 const select=(key,label,values,value)=>`<label class="ps-field">${label}<select id="ps_${key}" class="form-select">${values.map(([v,t])=>`<option value="${v}" ${v===value?'selected':''}>${t}</option>`).join('')}</select></label>`;
 const kinds=[['other','その他'],['loan','借入'],['lease','リース'],['installment','分割払い'],['insurance','保険']];
 const modes=[['combined','合算'],['split','元本・利息別']];
 const rules=[['none','調整なし'],['next','翌営業日'],['previous','前営業日']];
 const val=k=>q('#ps_'+k).value;
 const warn=fn=>async()=>{try{await fn();}catch(err){showToast(err.message,'error');}};
 function approve(message){return new Promise(resolve=>{const box=document.createElement('div');box.className='ps-confirm';const text=document.createElement('p');text.textContent=message;box.append(text);for(const [label,value] of [['この内容で進める',true],['戻る',false]]){const button=document.createElement('button');button.className='btn '+(value?'btn-primary':'btn-outline');button.textContent=label;button.onclick=()=>{box.remove();resolve(value);};box.append(button);}q('#activeModal').append(box);});}
 function modal(html){closeModal();showModal(`<div class="ps-panel">${html}</div>`);q('#activeModal .modal-sheet').classList.add('ps-wide');}
 async function send(action,body){return gasPost(action,body);}
 async function list(){
  const {data}=await gasApi('getPaymentSchedules');
  modal('<h2>変動額の定期支出・予定表</h2><p>入力した支払予定をまとめて管理します。一定額の固定支出は従来の画面を使います。</p><button class="btn btn-primary" id="ps_new">予定表を追加</button><div id="ps_list"></div>');
  q('#ps_new').onclick=()=>edit();
  for(const m of data){const b=document.createElement('button');b.className='btn btn-outline ps-list-item';b.textContent=m.name+' ／ '+(kinds.find(k=>k[0]===m.kind)?.[1]||m.kind)+' ／ '+m.occurrences.length+'回'+(m.archivedAt?'（アーカイブ）':'');b.onclick=warn(()=>detail(m.id));q('#ps_list').append(b);}
 }
 async function detail(key){
  const m=(await gasApi('getPaymentSchedules',{id:key})).data[0];
  modal(`<h2>${e(m.name)}</h2><p>${e(m.partner)} ／ ${e(accountDisplayName(APP.accounts.find(a=>a.id===m.account)))}</p>
   <button class="btn btn-outline" id="ps_back">一覧</button> <button class="btn btn-primary" id="ps_edit" ${m.archivedAt?'disabled':''}>予定表を編集・延長</button> <button class="btn btn-outline" id="ps_export">予定表をExcel出力</button> <button class="btn btn-outline" id="ps_archive" ${m.archivedAt?'disabled':''}>アーカイブ</button>
   ${m.kind==='loan'?`<p>残元本：${m.principalRemaining==null?'基準日前':e(fmtMoney(m.principalRemaining))} ／ 登録済み実績利息：${e(fmtMoney(m.interestPaid))}</p><p>残元本基準：${e(m.principalBalanceDate)}終了時点 ${e(fmtMoney(m.principalOpeningBalance))}。予定元本は差し引きません。</p>`:''}<div id="ps_detail"></div>`);
  q('#ps_back').onclick=warn(list);q('#ps_edit').onclick=warn(()=>edit(m));
  q('#ps_export').onclick=()=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(ScheduleInput.exportRows(m)),'予定表明細');XLSX.writeFile(wb,'支払予定表.xlsx');};
  q('#ps_archive').onclick=warn(async()=>{if(!await approve('一覧でアーカイブ表示にします。残っている支払予定は取消されません。'))return;await send('scheduleArchive',{id:m.id,requestId:uid(),expectedVersion:m.version});await list();});
  for(const o of m.occurrences){
   const node=document.createElement('section');node.className='ps-occurrence';
   node.innerHTML=`<strong>${e(o.nominalDate)} → ${e(o.paymentDate)} ／ ${e(fmtMoney(o.total))} ／ ${e(o.status)}</strong><p>${o.kind==='loan'?`元本 ${e(fmtMoney(o.plannedPrincipal))} ／ 利息 ${e(fmtMoney(o.plannedInterest))} ／ ${o.effectiveDebitMode==='split'?'別引落':'合算'}${o.debitModeOverride?'（この回の例外）':''}`:''}</p>`;
   for(const l of o.legs){
    const line=document.createElement('div');line.className='ps-leg';
    const label=l.component==='principal'?'元本':l.component==='interest'?'利息':'合計';
    const a=APP.accounts.find(a=>a.id===l.account);
    line.append(document.createTextNode(`${label}：${l.actualDate||l.plannedDate} ${fmtMoney(l.actualAmount??l.plannedAmount)} ${l.status} ／ ${accountDisplayName(a)} ${a?.accountNumber||''} `));
    if(l.status==='確定'){const b=document.createElement('button');b.className='btn btn-outline btn-sm';b.textContent='実績を訂正・取消';b.onclick=()=>ActualCorrections.open(l.transactionId);line.append(b);}
    if(l.status==='予定'){
     const btn=document.createElement('button');btn.className='btn btn-success btn-sm';btn.textContent='実績確定';btn.onclick=()=>confirmForm(m,o,l);line.append(btn);
     if(l.component!=='total'&&l.plannedDate>toDateKey(new Date())){const ed=document.createElement('button');ed.className='btn btn-outline btn-sm';ed.textContent='この未実績明細を変更';ed.onclick=()=>editLegForm(m,o,l);line.append(ed);}
    }node.append(line);
   }
   if(o.legs.some(l=>l.status==='予定')){const b=document.createElement('button');b.className='btn btn-outline btn-sm';b.textContent='この回の残予定を取消';b.onclick=warn(async()=>{if(!await approve('確定済み実績は残し、この回の未実績明細を取消しますか？'))return;await send('scheduleCancel',{id:o.id,expectedVersion:m.version,requestId:uid()});await detail(m.id);});node.append(b);}
   q('#ps_detail').append(node);
  }
 }
 function confirmForm(m,o,l){
  if(l.plannedDate<toDateKey(getJstToday())){Overdue.openId(l.transactionId);return;}
  const loan=o.kind==='loan',principal=l.component!=='interest',interest=l.component!=='principal';
  const requestId=uid();
  modal(`<h2>実績確定：${e(o.name)}</h2>${field('date','実績日',toDateKey(new Date()),'date')}${loan?(principal?field('principal','実績元本',o.plannedPrincipal,'number'):'')+(interest?field('interest','実績利息',o.plannedInterest,'number'):''):field('amount','実績額',l.plannedAmount,'number')}
   <p id="ps_total"></p><p>合算の差額は元本・利息を確認して入力してください。</p><label><input type="checkbox" id="ps_settled">この銀行明細の支払は完了しています（1明細内の分割決済は未対応）</label><p><button class="btn btn-success" id="ps_confirm">確定する</button> <button class="btn btn-outline" id="ps_cancel">戻る</button></p>`);
  const total=()=>{q('#ps_total').textContent='実績合計：'+fmtMoney(loan?Number(principal?val('principal'):0)+Number(interest?val('interest'):0):Number(val('amount')));};q('#activeModal').oninput=total;total();
  q('#ps_cancel').onclick=warn(()=>detail(m.id));
  q('#ps_confirm').onclick=warn(async()=>{const body={id:l.id,expectedVersion:m.version,requestId,actualDate:val('date'),settled:q('#ps_settled').checked};if(loan){body.actualPrincipal=ScheduleInput.amount(principal?val('principal'):'0');body.actualInterest=ScheduleInput.amount(interest?val('interest'):'0');}else body.actualAmount=ScheduleInput.amount(val('amount'));await send('scheduleConfirm',body);await detail(m.id);});
 }
 function editLegForm(m,o,l){
  const requestId=uid();modal(`<h2>未実績の${l.component==='principal'?'元本':'利息'}を変更</h2><p>確定済みの相手明細は変更しません。日付は調整済みの支払日を入力してください。</p>${field('date','支払予定日',l.plannedDate,'date')}${field('amount','予定額',l.plannedAmount,'number')}<button class="btn btn-primary" id="ps_saveLeg">保存</button>`);
  q('#ps_saveLeg').onclick=warn(async()=>{await send('scheduleEditLeg',{id:l.id,requestId,expectedVersion:m.version,plannedDate:val('date'),plannedAmount:ScheduleInput.amount(val('amount'))});await detail(m.id);});
 }
 async function edit(master){
  const m=master||{id:uid(),name:'',kind:'other',account:APP.accounts[0]?.id||'',partner:'',defaultDebitMode:'combined',holidayRule:'none',memo:'',occurrences:[]};
  let rows=m.occurrences.map(o=>({...o,locked:!!o.cancelledAt||o.hasHistory||o.legs.some(l=>l.actualDate)||o.paymentDate<=toDateKey(new Date())}));
  const requestId=uid();
  modal(`<h2>${master?'予定表を編集・延長':'予定表を追加'}</h2><div class="ps-fields">${field('name','名称',m.name)}${select('kind','種類',kinds,m.kind)}${select('account','支払口座',APP.accounts.map(a=>[a.id,e(accountDisplayName(a))]),m.account)}${field('partner','取引先',m.partner)}${select('holiday','休日調整',rules,m.holidayRule)}</div>
   <div id="ps_loan" class="ps-fields">${select('mode','通常の引落方式',modes,m.defaultDebitMode)}${select('startMode','借入管理開始',['new','existing'].map(x=>[x,x==='new'?'新規借入':'返済途中から']),m.principalStartMode||'existing')}${field('original','当初借入額（途中登録では任意）',m.originalPrincipal??'','number')}${field('loanDate','借入実行日（途中登録では任意）',m.loanDate||'','date')}${field('balanceDate','残元本基準日（終了時点）',m.principalBalanceDate||'','date')}${field('balance','管理開始時点残元本',m.principalOpeningBalance??'','number')}</div>
   ${field('memo','メモ',m.memo)}
   ${master?'<p><label><input type="checkbox" id="ps_apply">共通情報の変更を、将来の完全未実績回にも反映する（例外方式の回は除外）</label></p>':''}
   <p>日付は年を含めて入力。確定済み・過去の回は保護します。保存済み行の取消は詳細画面から行います。</p>
   <div class="ps-fields">${field('month','生成開始月',toDateKey(new Date()).slice(0,7),'month')}${field('count','回数',12,'number')}${select('day','日付規則',[['last','毎月末'],...Array.from({length:31},(_,i)=>[String(i+1),'毎月'+(i+1)+'日'])],'last')}</div>
   <button class="btn btn-outline" id="ps_generate">日付を作成して追加</button> <button class="btn btn-outline" id="ps_add">1行追加</button>
   <p id="ps_pasteLabel"></p><textarea id="ps_paste" class="form-input" rows="3" aria-label="Excelからの貼り付け"></textarea><button class="btn btn-outline" id="ps_pasteRun">日付を含む行を追加</button> <button class="btn btn-outline" id="ps_amountPaste">金額だけを未入力行へ貼り付け</button>
   <div class="ps-scroll"><table class="ps-table"><thead id="ps_head"></thead><tbody id="ps_rows"></tbody></table></div><p id="ps_summary"></p>
   <button class="btn btn-primary" id="ps_save">内容を確認して保存</button> <button class="btn btn-outline" id="ps_back">戻る</button>`);
  if(rows.length)q('#ps_kind').disabled=true;
  if(m.occurrences.some(o=>o.hasHistory||o.legs.some(l=>l.actualDate)))for(const key of ['startMode','original','loanDate','balanceDate','balance'])q('#ps_'+key).disabled=true;
  const loan=()=>val('kind')==='loan';
  function render(){
   q('#ps_loan').style.display=loan()?'grid':'none';q('#ps_pasteLabel').textContent=loan()?'Excelの「日付・元本・利息」の3列を貼り付け':'Excelの「日付・金額」の2列を貼り付け';
   q('#ps_head').innerHTML='<tr><th>名目支払日</th>'+(loan()?'<th>元本</th><th>利息</th><th>合計</th><th>この回の例外</th>':'<th>金額</th>')+'<th>調整済日／状態</th><th></th></tr>';
   q('#ps_rows').replaceChildren();
   rows.forEach((r,index)=>{
    const tr=document.createElement('tr');
    const cellInput=(key,type)=>{const td=document.createElement('td'),input=document.createElement('input');input.className='form-input';input.type=type;input.value=r[key]??'';input.disabled=!!r.locked;input.setAttribute('aria-label',key);input.oninput=()=>{r[key]=input.value;if(loan())totalCell.textContent=fmtMoney(Number(r.plannedPrincipal||0)+Number(r.plannedInterest||0));};td.append(input);tr.append(td);};
    let totalCell;cellInput('nominalDate','date');
    if(loan()){cellInput('plannedPrincipal','number');cellInput('plannedInterest','number');totalCell=document.createElement('td');totalCell.textContent=fmtMoney(Number(r.plannedPrincipal||0)+Number(r.plannedInterest||0));tr.append(totalCell);const td=document.createElement('td'),sel=document.createElement('select');sel.className='form-select';sel.innerHTML='<option value="">通常方式</option><option value="combined">この回だけ合算</option><option value="split">この回だけ別引落</option>';sel.value=r.debitModeOverride||'';sel.disabled=!!r.locked;sel.onchange=()=>r.debitModeOverride=sel.value||null;td.append(sel);tr.append(td);}else cellInput('plannedAmount','number');
    const status=document.createElement('td');status.textContent=(r.paymentDate||'保存時に計算')+' '+(r.status||'新規');tr.append(status);
    const td=document.createElement('td');if(!r.scheduleId){const del=document.createElement('button');del.className='btn btn-outline btn-sm';del.textContent='削除';del.onclick=()=>{rows.splice(index,1);render();};td.append(del);}tr.append(td);q('#ps_rows').append(tr);
   });q('#ps_summary').textContent=rows.length+'回';
  }
  q('#ps_kind').onchange=async()=>{if(rows.length&&!await approve('未保存の入力行をクリアして種類を変更しますか？')){q('#ps_kind').value=m.kind;return;}rows=[];m.kind=val('kind');render();};
  q('#ps_add').onclick=()=>{rows.push({id:uid(),nominalDate:'',debitModeOverride:null});render();};
  q('#ps_generate').onclick=warn(async()=>{const data=await gasApi('previewScheduleDates',{start:val('month'),count:val('count'),day:val('day'),rule:val('holiday')});rows.push(...data.data.map(d=>({...d,id:uid(),debitModeOverride:null})));render();});
  q('#ps_pasteRun').onclick=warn(async()=>{const parsed=ScheduleInput.parse(q('#ps_paste').value,loan());if(rows.length+parsed.length>1000)throw Error('1000回以内にしてください');rows.push(...parsed.map(r=>({...r,id:uid(),debitModeOverride:null})));q('#ps_paste').value='';render();});
  q('#ps_amountPaste').onclick=warn(async()=>{const data=ScheduleInput.parseAmounts(q('#ps_paste').value,loan()),targets=rows.filter(r=>!r.locked&&(loan()?(r.plannedPrincipal==null||r.plannedPrincipal==='')&&(r.plannedInterest==null||r.plannedInterest===''):(r.plannedAmount==null||r.plannedAmount==='')));if(data.length>targets.length)throw Error('貼り付け先の金額未入力行が足りません');data.forEach((v,i)=>Object.assign(targets[i],v));q('#ps_paste').value='';render();});
  q('#ps_back').onclick=warn(()=>master?detail(m.id):list());
  q('#ps_save').onclick=warn(async()=>{
   const converted=rows.map(r=>({id:r.id,nominalDate:ScheduleInput.date(r.nominalDate),debitModeOverride:r.debitModeOverride||null,...(loan()?{plannedPrincipal:ScheduleInput.amount(r.plannedPrincipal),plannedInterest:ScheduleInput.amount(r.plannedInterest)}:{plannedAmount:ScheduleInput.amount(r.plannedAmount)})}));
   const body={id:m.id,requestId,expectedVersion:m.version,name:val('name'),kind:val('kind'),account:val('account'),partner:val('partner'),holidayRule:val('holiday'),defaultDebitMode:val('mode'),memo:val('memo'),applyDefaults:!!q('#ps_apply')?.checked,rows:converted};
   if(loan())Object.assign(body,{principalStartMode:val('startMode'),originalPrincipal:val('original')===''?null:ScheduleInput.amount(val('original')),loanDate:val('loanDate')||null,principalBalanceDate:val('balanceDate'),principalOpeningBalance:ScheduleInput.amount(val('balance'))});
   const total=converted.reduce((s,r)=>s+(loan()?r.plannedPrincipal+r.plannedInterest:r.plannedAmount),0);
   if(!await approve(`${converted.length}回、予定総額${fmtMoney(total)}を保存します。既存の固定支出等に同じ支払がないことを確認してください。共通変更の既存回への反映：${body.applyDefaults?'あり（将来の未実績回のみ）':'なし'}。`))return;
   await send('scheduleSave',body);await detail(m.id);
  });render();
 }
 async function fromTransaction(t){const {data}=await gasApi('getPaymentSchedules');const m=data.find(m=>m.occurrences.some(o=>o.legs.some(l=>l.transactionId===t.id)));if(m)await detail(m.id);else showToast('予定表が見つかりません','error');}
 return {list:()=>list().catch(e=>showToast(e.message,'error')),fromTransaction};
})();

