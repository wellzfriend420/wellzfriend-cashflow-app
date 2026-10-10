'use strict';
const DirectDebitNotification=(()=>{
 async function open(){try{
  const data=await gasApi('getDirectDebitNotification');
  const e=escapeHtml;
  closeModal();showModal(`<div class="ps-panel"><h2>自動引落しのLINE通知</h2>
   <p>実際の引落予定日の前日10:00（日本時間）に、未確定の出金を1通にまとめます。休日調整後の日付が基準です。</p>
   <p>${data.available?(data.recipientConfigured?'LINE連携：設定済み':'LINE送信先：管理者による設定待ち'):'この会社のLINE連携は未有効です。対象の選択は保存できます。'}</p>
   <p>本日の通知：${e(({sent:'LINE受付済み',pending:'送信確認待ち',empty:'対象なし',not_run:'未実行'})[data.todayStatus]||data.todayStatus)}</p>
   <p>保存済み設定での翌日対象（${e(data.preview.date)}）：${data.preview.count}件 ／ ${e(fmtMoney(data.preview.total))}</p>
   <label><input type="checkbox" id="dd_enabled" ${data.enabled?'checked':''}> LINE通知をONにする</label>
   <p>自動引落しの予定だけを選んでください。固定支出・支払予定表は今後の回も対象になります。振込・現金払いは選びません。</p>
   <p>通知後に追加・変更した予定は同日再通知しません。最新の予定は日繰りで確認してください。</p>
   <div id="dd_candidates"></div><button type="button" id="dd_save" class="btn btn-primary">保存</button>
   <button type="button" onclick="closeModal()" class="btn btn-outline">閉じる</button></div>`);
  const list=document.getElementById('dd_candidates');
  for(const item of data.candidates){const label=document.createElement('label');label.style.display='block';label.style.margin='12px 0';const input=document.createElement('input');input.type='checkbox';input.value=item.key;input.checked=data.selected.includes(item.key);label.append(input,document.createTextNode(' '+item.label+' ／ '+(item.account||'')));list.append(label);}
  if(!data.candidates.length)list.textContent='選択できる支払予定がありません。予定の登録後に選択してください。';
  document.getElementById('dd_save').onclick=async()=>{try{
   const visible=new Set(data.candidates.map(x=>x.key));
   const selected=[...data.selected.filter(k=>!visible.has(k)),...Array.from(list.querySelectorAll('input:checked'),x=>x.value)];
   await gasPost('saveDirectDebitNotification',{enabled:document.getElementById('dd_enabled').checked,selected,version:data.version});closeModal();showToast('通知設定を保存しました');
  }catch(err){showToast(err.message,'error');}};
 }catch(err){showToast(err.message,'error');}}
 return {open};
})();
