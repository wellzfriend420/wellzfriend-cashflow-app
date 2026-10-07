// One-time migration of the reviewed standalone UI. Do not rerun on an edited UI.
const fs=require('node:fs');
let app=fs.readFileSync('assets/app.js','utf8').replace(/\r\n/g,'\n');
app=app.replace("gasUrl: localStorage.getItem('gasUrl') || '',","gasUrl: new URL('/api/v1', location.origin).href,\n  csrf: '',");
app=app.replace("companyName: localStorage.getItem('companyName') || '資金繰りシステム',","companyName: '資金繰りシステム',");
app=app.replace(/  demoFixedExpenses:.*\n/,'');
app=app.replace(/  if \(!APP.gasUrl\) \{\n    \/\/ GAS未設定時はデモデータを返す\n    return getDemoData\(action, params\);\n  \}\n/,'');
app=app.replace("if (!APP.gasUrl) throw new Error('デモ表示中です。保存先を設定するまで業務データは保存できません');","if (!APP.csrf) throw new Error('ログインしてください');");
app=app.replace("headers: { 'Content-Type': 'text/plain;charset=UTF-8' }","headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': APP.csrf }");
app=app.replace("    if (!res.ok) throw new Error('保存先から正常な応答がありません');\n    const data = await res.json();","    if (res.status === 401) { location.replace('/login.html'); throw new Error('ログインしてください'); }\n    const data = await res.json();\n    if (!res.ok) throw new Error(data.error || '保存できませんでした');");
app=app.replace("    const data = await res.json();\n    if (data.error)","    if (res.status === 401) { location.replace('/login.html'); throw new Error('ログインしてください'); }\n    const data = await res.json();\n    if (data.error)");
const demoStart=app.indexOf('function getDemoData('), demoEnd=app.indexOf('function navigate(');
app=app.slice(0,demoStart)+app.slice(demoEnd);
app=app.replace("  document.getElementById('gasUrlInput').value = APP.gasUrl;\n",'');
app=app.replace("return Promise.all([loadMasterData(), loadFixedExpenses()])","return Promise.all([loadMasterData(), loadFixedExpenses(), refreshBackupStatus()])");
const settingStart=app.indexOf('function saveGasUrl()'),settingEnd=app.indexOf('function renderPartnerList()');
app=app.slice(0,settingStart)+`async function saveCompanyName() {
  const name = document.getElementById('companyNameInput').value.trim();
  try { await gasPost('saveSettings', {companyName:name}); APP.companyName=name;document.getElementById('companyNameNav').textContent=name;showToast('会社名を保存しました','success'); } catch {}
}
async function authPost(route,body={}) {
  const res=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':APP.csrf},body:JSON.stringify(body)});
  const data=await res.json();if(!res.ok)throw new Error(data.error||'操作できませんでした');return data;
}
async function logout() { try{await authPost('/auth/logout');location.replace('/login.html');}catch(e){showToast(e.message,'error');} }
function openPasswordForm(){showModal('<div class="modal-title">パスワード変更</div><div class="modal-body"><label class="form-label" for="currentPassword">現在のパスワード</label><input class="form-input" type="password" id="currentPassword" autocomplete="current-password"><label class="form-label" for="newPassword">新しいパスワード（12文字以上）</label><input class="form-input" type="password" id="newPassword" autocomplete="new-password" maxlength="256"><label class="form-label" for="repeatPassword">新しいパスワード（確認）</label><input class="form-input" type="password" id="repeatPassword" autocomplete="new-password" maxlength="256"></div><div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">キャンセル</button><button class="btn btn-primary" onclick="changePassword()">変更して再ログイン</button></div>');}
async function changePassword(){
  const currentPassword=document.getElementById('currentPassword').value,newPassword=document.getElementById('newPassword').value;
  if(newPassword!==document.getElementById('repeatPassword').value){showToast('確認用パスワードが一致しません','error');return;}
  if(APP.passwordBusy)return;APP.passwordBusy=true;
  try{await authPost('/auth/password',{currentPassword,newPassword});location.replace('/login.html');}catch(e){showToast(e.message,'error');}finally{APP.passwordBusy=false;}
}
async function refreshBackupStatus(){
  const banner=document.getElementById('backupBanner'),detail=document.getElementById('backupStatus');
  try{const res=await fetch('/api/v1/backup-status');if(!res.ok)throw new Error();const data=await res.json();
    const messages={ok:'VPS内バックアップは正常です',missing:'バックアップがまだ取得されていません',failed:'バックアップの取得に失敗しています。管理者に確認してください',stale:'バックアップが90分以上更新されていません。管理者に確認してください'};
    banner.textContent=data.state==='ok'?'':messages[data.state];banner.classList.toggle('hidden',data.state==='ok');
    detail.textContent=messages[data.state]+(data.lastSuccessAt?'。最終成功: '+new Date(data.lastSuccessAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+'（日本時間）':'')+'。外部バックアップは未導入です。';
  }catch{banner.textContent='バックアップ状態を確認できません。再読み込みしてください';banner.classList.remove('hidden');}
}

`+app.slice(settingEnd);
// Escape user-provided text only where it is inserted into an HTML line.
app=app.split('\n').map(line=>{
  if(!line.includes('<'))return line;
  return line.replace(/\$\{([^{}]+)\}/g,(match,expr)=>{
    if(expr.includes('escapeHtml(')||expr.includes('?')&&!expr.includes('?.')||expr.includes('===')||expr.includes('=>'))return match;
    if(/\b\w+\??\.(?:name|partner|description|memo|bank|type|msg|balanceDate|plannedDate|actualDate|invoiceDate|dueDate|occDate|startMonth|endMonth)\b/.test(expr)||/^(?:accountName|sourceLabel)$/.test(expr))return '${escapeHtml('+expr+')}';
    return match;
  });
}).join('\n');
app=app.replace(/document.addEventListener\('DOMContentLoaded',[\s\S]*$/,`document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res=await fetch('/auth/session');if(!res.ok){location.replace('/login.html');return;}
    const session=await res.json();APP.csrf=session.csrf;
    const settings=await gasApi('getSettings');APP.companyName=settings.companyName;
    document.getElementById('companyNameNav').textContent=APP.companyName;
    navigate('home');await refreshBackupStatus();setInterval(refreshBackupStatus,60000);
  }catch(e){showToast('読み込めませんでした。画面を再読み込みしてください','error');}
});
`);
app=app.replaceAll('GAS API通信','アプリ内API通信').replaceAll('GAS API Error:','API Error:');
fs.writeFileSync('assets/app.js',app);
let html=fs.readFileSync('index.html','utf8').replace(/\r\n/g,'\n');
html=html.replace(/<script src="https:[^\n]+\n/g,'').replace(/<link (?:rel="preconnect"|href="https:)[^\n]+\n/g,'');
html=html.replace('<title>日繰り資金繰り管理</title>','<title>ウェルノット資金繰り</title>\n<script defer src="/assets/vendor/xlsx.full.min.js"></script>');
html=html.replace('<div class="main-content">','<div class="main-content">\n<div id="backupBanner" class="alert-banner alert-red hidden" role="alert" style="margin:12px"></div>');
html=html.replace(/      <!-- GAS接続設定 -->[\s\S]*?      <!-- 会社設定 -->/,`      <div class="card"><div class="card-header">ログイン・バックアップ</div><div class="section"><p id="backupStatus" style="font-size:13px;margin-bottom:14px">バックアップ状態を確認しています</p><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-outline" onclick="openPasswordForm()">パスワード変更</button><button class="btn btn-outline" onclick="logout()">ログアウト</button></div></div></div>
      <!-- 会社設定 -->`);
fs.writeFileSync('index.html',html);
fs.appendFileSync('assets/styles.css',`\n/* Local replacements for the former CDN reset and utilities. */
html {line-height:1.5;-webkit-text-size-adjust:100%} body,h1,h2,h3,p {margin:0} button,input,select,textarea {font:inherit;color:inherit} button {cursor:pointer;border:0;background:none} button:disabled{opacity:.55;cursor:wait} table {border-collapse:collapse} input,textarea,select{border:1px solid var(--border)} svg{display:block;vertical-align:middle} .hidden{display:none!important}.p-4{padding:16px}.m-4{margin:16px}.mt-3{margin-top:12px}.mt-4{margin-top:16px}.w-full{width:100%}.flex-1{flex:1}.space-y-4>:not([hidden])~:not([hidden]){margin-top:16px}.space-y-3>:not([hidden])~:not([hidden]){margin-top:12px}.login-panel{width:calc(100% - 32px);max-width:420px;margin:12vh auto}.login-panel .section{padding:24px}:focus-visible{outline:3px solid #68a5df;outline-offset:2px}
`);
