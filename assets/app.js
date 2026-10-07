// ========================================================
// グローバル状態管理
// ========================================================
const APP = {
  gasUrl: new URL('/api/v1', location.origin).href,
  csrf: '',
  companyName: '資金繰りシステム',
  currentPage: 'home',
  currentMode: 'predict',   // 日繰りモード: predict/actual/diff
  currentMonth: null,       // 表示中の月 (YYYY-MM、JST基準)
  currentMonthData: [],     // 日繰りデータキャッシュ
  accounts: [],             // 口座マスタ
  partners: [],             // 取引先マスタ
  receivables: [],          // 売掛データ
  payables: [],             // 買掛データ
  transactions: [],         // 資金繰りトランザクション
  fixedExpenses: [],          // 固定支出マスタ
  selectedAccountIds: null, // 日繰りで表示する口座ID配列（null=未初期化、初期化後は全口座IDの配列）
};

// 今日の日付（JST基準）
let today = getJstToday();

// ========================================================
// ユーティリティ関数
// ========================================================
/** 金額を日本円形式にフォーマット */
function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '―';
  const num = Number(n);
  if (isNaN(num)) return '―';
  return num.toLocaleString('ja-JP') + '円';
}

/** HTMLへ表示するユーザー入力値をエスケープ */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function accountDisplayName(account) {
  return CashflowMath.accountLabel(account || {});
}

/**
 * 日付文字列（YYYY-MM-DD等）またはDateを、JSTのカレンダー日として
 * ローカルDateオブジェクト（時刻0:00、タイムゾーン変換によるズレなし）に変換する。
 * "YYYY-MM-DD"形式の文字列をnew Date()に直接渡すとUTC0時として解釈され、
 * 日本時間でブラウザ表示すると前日になってしまう問題を避けるための関数。
 */
function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) {
    if (isNaN(s)) return null;
    return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  }
  const str = String(s).trim();
  // "YYYY-MM-DD" または "YYYY-MM-DDTHH:mm:ss..." 形式は日付部分のみ抜き出して
  // ローカル日付として組み立てる（タイムゾーンの影響を受けない）
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  // それ以外の形式はDateコンストラクタにフォールバック
  const d = new Date(str);
  if (isNaN(d)) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 今日の日付を JST のカレンダー日（時刻0:00）で取得 */
function getJstToday() {
  // Intl APIでJSTの年月日を取得し、ローカルDateとして組み立てる
  // （サーバー/ブラウザのタイムゾーンに関わらずJST基準の「今日」を固定するため）
  const jstStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()); // "YYYY-MM-DD" 形式で返る
  const [y, m, d] = jstStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Date を YYYY-MM-DD 文字列に変換（保存用、JSTのカレンダー日のまま） */
function toDateKey(d) {
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** 日付を YYYY/MM/DD にフォーマット（JST基準） */
function fmtDate(d) {
  if (!d) return '';
  const dt = parseDate(d);
  if (!dt) return typeof d === 'string' ? d : '';
  return `${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
}

/** 日付を MM/DD にフォーマット（JST基準） */
function fmtDateShort(d) {
  if (!d) return '';
  const dt = parseDate(d);
  if (!dt) return '';
  return `${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
}

/** 遅延日数計算（JST基準） */
function calcDelay(dueDate) {
  if (!dueDate) return 0;
  const due = parseDate(dueDate);
  if (!due) return 0;
  const diff = Math.floor((today - due) / 86400000);
  return diff > 0 ? diff : 0;
}

/** UUID生成 */
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** トースト通知 */
function showToast(msg, type = 'default') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  if (type === 'error') t.style.background = '#D94B3A';
  if (type === 'success') t.style.background = '#0F9E6E';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

/** ローディング表示 */
function showLoading(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = '<div class="loading-spinner"></div>';
}

// ========================================================
// アプリ内API通信
// ========================================================
async function gasApi(action, params = {}) {
  try {
    const url = new URL(APP.gasUrl);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([k, v]) => {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
    });
    const res = await fetch(url.toString(), { method: 'GET' });
    if (res.status === 401) { location.replace('/login.html'); throw new Error('ログインしてください'); }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (e) {
    console.error('API Error:', e);
    showToast('通信エラー: ' + e.message, 'error');
    throw e;
  }
}

async function gasPost(action, body = {}) {
  let ownsWrite = false;
  try {
    if (!APP.csrf) throw new Error('ログインしてください');
    if (APP.writeBusy) throw new Error('保存中です。完了をお待ちください');
    APP.writeBusy = true;
    ownsWrite = true;
    const modal = document.getElementById('activeModal');
    if (modal) modal.querySelectorAll('button').forEach(button => { button.disabled = true; });
    const caches = { accounts: APP.accounts, partners: APP.partners, receivables: APP.receivables,
      payables: APP.payables, cashflow_transactions: APP.currentMonthData, fixed_expenses: APP.fixedExpenses };
    const tables = { saveTransaction: 'cashflow_transactions', saveReceivable: 'receivables', savePayable: 'payables',
      confirmReceivable: 'receivables', confirmPayable: 'payables', saveAccount: 'accounts', savePartner: 'partners',
      saveFixedExpense: 'fixed_expenses', deleteFixedExpense: 'fixed_expenses' };
    const existing = (caches[body.sheet || tables[action]] || []).find(item => item.id === body.id);
    const res = await fetch(APP.gasUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': APP.csrf },
      body: JSON.stringify({ ...body, action, expectedUpdatedAt: body.expectedUpdatedAt ?? existing?.updatedAt ?? '' })
    });
    if (res.status === 401) { location.replace('/login.html'); throw new Error('ログインしてください'); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存できませんでした');
    if (data.error || !data.success) throw new Error(data.error || '保存結果を確認できません');
    return data;
  } catch (e) {
    showToast(e.message, 'error');
    throw e;
  } finally {
    if (ownsWrite) {
      APP.writeBusy = false;
      const modal = document.getElementById('activeModal');
      if (modal) modal.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  }
}

function formRecordId() {
  const modal = document.getElementById('activeModal');
  if (!modal) throw new Error('入力画面を開き直してください');
  if (!modal.dataset.recordId) modal.dataset.recordId = genId();
  return modal.dataset.recordId;
}

// ========================================================
// 画面切り替え
// ========================================================
function navigate(page) {
  today = getJstToday();
  // 全ページ非表示
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  // 全ナビ非活性
  document.querySelectorAll('.nav-item, .side-nav-item').forEach(n => n.classList.remove('active'));

  // 対象ページ表示
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.remove('hidden');

  // ナビ活性化（モバイル・PC）
  const navEl = document.getElementById('nav-' + page);
  if (navEl) navEl.classList.add('active');
  document.querySelectorAll('.side-nav-item').forEach(n => {
    if (n.textContent.trim() === getNavLabel(page)) n.classList.add('active');
  });

  APP.currentPage = page;
  updateFab(page);

  // 各ページの初期化
  const loaders = { home: loadHome, cashflow: loadCashflow, receivables: loadReceivables,
    payables: loadPayables, accounts: loadAccounts, settings: loadSettings };
  if (loaders[page]) Promise.resolve().then(loaders[page]).catch(error => showToast(error.message, 'error'));
}

function getNavLabel(page) {
  return { home:'ホーム', cashflow:'日繰り', receivables:'売掛', payables:'買掛', accounts:'口座', settings:'設定' }[page] || '';
}

function updateFab(page) {
  const fab = document.getElementById('fabBtn');
  const fabMap = {
    cashflow: { show: true, label: '＋' },
    receivables: { show: true, label: '＋' },
    payables: { show: true, label: '＋' },
    accounts: { show: false, label: '' },
    home: { show: false, label: '' },
    settings: { show: false, label: '' },
  };
  const cfg = fabMap[page] || { show: false };
  fab.style.display = cfg.show ? 'flex' : 'none';
  fab.textContent = cfg.label;
}

function handleFab() {
  switch(APP.currentPage) {
    case 'cashflow': openTransactionForm(); break;
    case 'receivables': openReceivableForm(); break;
    case 'payables': openPayableForm(); break;
  }
}

// ========================================================
// ホーム画面
// ========================================================
async function loadHome() {
  today=getJstToday();
  document.getElementById('homeDate').textContent =
    `${today.getFullYear()}年${today.getMonth()+1}月${today.getDate()}日 現在`;

  // マスタデータ取得
  await Promise.all([loadMasterData()]);

  // 残高計算
  const [txRes, recRes, payRes] = await Promise.all([
    gasApi('getTransactions', { all: true }),
    gasApi('getReceivables'),
    gasApi('getPayables'),
  ]);

  APP.transactions = txRes.data || [];
  if(txRes.day) today=parseDate(txRes.day);
  APP.receivables = recRes.data || [];
  APP.payables = payRes.data || [];

  // 口座別現在残高
  const totalBalance = APP.accounts.reduce((s, a) => s + CashflowMath.actualAt(a, APP.transactions, toDateKey(today)), 0);
  document.getElementById('totalBalance').textContent = fmtMoney(totalBalance);
  document.getElementById('balanceAsOf').textContent = `基準残高＋登録済み実績（口座合計）`;

  // 口座リスト
  const acEl = document.getElementById('accountBalanceList');
  acEl.innerHTML = APP.accounts.map(a => `
    <div class="list-row" style="cursor:default">
      <div style="flex:1">
        <div style="font-weight:600;font-size:14px">${escapeHtml(accountDisplayName(a))}</div>
        <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(a.type || '')}</div>
      </div>
      <div class="amount" style="color:var(--primary)">${fmtMoney(CashflowMath.actualAt(a, APP.transactions, toDateKey(today)))}</div>
    </div>
  `).join('');

  // 月末・30日予測残高
  const eom = calcForecastBalance(APP.transactions, APP.accounts, getEOM());
  const d30 = calcForecastBalance(APP.transactions, APP.accounts, get30Days());
  document.getElementById('eomForecast').textContent = fmtMoney(eom);
  document.getElementById('eomForecast').className = 'value ' + (eom < 0 ? 'balance-negative' : 'balance');
  document.getElementById('day30Forecast').textContent = fmtMoney(d30);
  document.getElementById('day30Forecast').className = 'value ' + (d30 < 0 ? 'balance-negative' : 'balance');

  // 未回収売掛
  const totalRec = APP.receivables
    .filter(r => r.status !== '回収済' && r.status !== '取消')
    .reduce((s, r) => s + (Number(r.amount) - Number(r.paidAmount || 0)), 0);
  document.getElementById('totalReceivables').textContent = fmtMoney(totalRec);

  // 未払買掛
  const totalPay = APP.payables
    .filter(p => p.status !== '支払済' && p.status !== '取消')
    .reduce((s, p) => s + (Number(p.amount) - Number(p.paidAmount || 0)), 0);
  document.getElementById('totalPayables').textContent = fmtMoney(totalPay);

  // ヘッダー更新
  document.getElementById('receivableHeader').textContent = fmtMoney(totalRec);
  document.getElementById('payableHeader').textContent = fmtMoney(totalPay);

  // アラート
  renderAlerts(eom, d30);
  if(typeof Overdue!=='undefined'){Overdue.banner('homeOverdue',APP.transactions,APP.accounts,eom);document.getElementById('day30Reference').textContent='期限超過分もすべて今後発生すると仮定した30日後参考値：'+fmtMoney(d30+CashflowMath.overdue(APP.transactions,APP.accounts.map(a=>a.id),toDateKey(today)).income.amount-CashflowMath.overdue(APP.transactions,APP.accounts.map(a=>a.id),toDateKey(today)).expense.amount);}

  // 直近取引
  renderRecentTransactions();
}

/** 今月末（JST基準のtodayから算出） */
function getEOM() {
  return new Date(today.getFullYear(), today.getMonth()+1, 0);
}
/** 30日後（JST基準のtodayから算出） */
function get30Days() {
  const d = new Date(today);
  d.setDate(d.getDate() + 30);
  return d;
}

/** 予測残高計算：指定日までの取引を集計 */
function calcForecastBalance(transactions, accounts, targetDate) {
  return accounts.reduce((sum, a) => sum + CashflowMath.balanceAt(a, transactions, toDateKey(targetDate), 'predict', toDateKey(today)), 0);
}

/** アラート表示 */
function renderAlerts(eom, d30) {
  const alerts = [];
  const now = today; // JST基準の「今日」を使用

  // 資金ショート予測
  if (eom < 0 || d30 < 0) {
    alerts.push({
      type: 'red',
      icon: '⚠️',
      title: '資金ショート予測',
      msg: `${eom < 0 ? '今月末' : '30日以内'}に残高がマイナスになる可能性があります。`
    });
  }

  // 売掛遅延
  const overdueRec = APP.receivables.filter(r => {
    if (r.status === '回収済') return false;
    const due = parseDate(r.dueDate);
    return due && due < now;
  });
  if (overdueRec.length > 0) {
    alerts.push({
      type: 'amber',
      icon: '📥',
      title: `売掛入金遅延（${overdueRec.length}件）`,
      msg: overdueRec.map(r => `${r.partner}：${fmtMoney(Number(r.amount)-Number(r.paidAmount||0))}`).join('、')
    });
  }

  // 買掛遅延
  const overduePay = APP.payables.filter(p => {
    if (p.status === '支払済') return false;
    const due = parseDate(p.dueDate);
    return due && due < now;
  });
  if (overduePay.length > 0) {
    alerts.push({
      type: 'red',
      icon: '📤',
      title: `買掛支払遅延（${overduePay.length}件）`,
      msg: overduePay.map(p => `${p.partner}：${fmtMoney(Number(p.amount)-Number(p.paidAmount||0))}`).join('、')
    });
  }

  const container = document.getElementById('alertSection');
  if (alerts.length === 0) {
    container.innerHTML = `<div class="alert-banner alert-blue"><span>✅</span><div>その他のアラートはありません</div></div>`;
    return;
  }
  container.innerHTML = alerts.map(a => `
    <div class="alert-banner alert-${escapeHtml(a.type)}">
      <span style="font-size:18px;flex-shrink:0">${a.icon}</span>
      <div>
        <div style="font-weight:700;margin-bottom:2px">${a.title}</div>
        <div style="font-size:12px;opacity:0.85">${escapeHtml(a.msg)}</div>
      </div>
    </div>
  `).join('');
}

/** 直近取引表示 */
function renderRecentTransactions() {
  const plus7 = new Date(today); plus7.setDate(plus7.getDate() + 7);

  // 今日から7日以内の取引を抽出
  const recent = APP.transactions
    .filter(t => {
      if (t.status === '取消') return false;
      const d = parseDate(t.actualDate || t.plannedDate);
      return d && d >= today && d <= plus7;
    })
    .sort((a, b) => {
      const da = parseDate(a.actualDate || a.plannedDate);
      const db = parseDate(b.actualDate || b.plannedDate);
      return da - db;
    })
    .slice(0, 8);

  const el = document.getElementById('recentTransactions');
  if (recent.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">7日以内の取引はありません</div>';
    return;
  }
  el.innerHTML = recent.map(t => {
    const d = parseDate(t.actualDate || t.plannedDate);
    const amt = Number(CashflowMath.hasActual(t) ? t.actualAmount : t.plannedAmount);
    const isIncome = t.type === '入金';
    return `
      <div class="list-row">
        <div style="width:40px;text-align:center;flex-shrink:0">
          <div style="font-size:10px;color:var(--text-muted)">${String(d.getMonth()+1).padStart(2,'0')}月</div>
          <div style="font-size:18px;font-weight:700;line-height:1">${d.getDate()}</div>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.partner || t.description)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(t.description)}</div>
        </div>
        <div class="amount ${isIncome ? 'income' : 'expense'}" style="flex-shrink:0">
          ${isIncome ? '+' : '-'}${fmtMoney(amt)}
        </div>
      </div>
    `;
  }).join('');
}

// ========================================================
// マスタデータ読み込み
// ========================================================
async function loadMasterData() {
  const [acRes, ptRes] = await Promise.all([gasApi('getAccounts'), gasApi('getPartners')]);
  APP.accounts = acRes.data || [];
  APP.partners = ptRes.data || [];
}

// ========================================================
// 日繰り画面
// ========================================================
async function loadCashflow() {
  await loadMasterData();

  // 口座フィルターの初期化（未初期化時は全口座を選択状態にする）
  if (APP.selectedAccountIds === null) {
    APP.selectedAccountIds = APP.accounts.map(a => a.id);
  }

  // 月タブ生成（前後のJST基準「今日」を起点に）
  if (!APP.currentMonth) {
    APP.currentMonth = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
  }
  renderMonthTabs();
  updateAccountFilterCount();
  await loadCashflowMonth(APP.currentMonth);
}

function renderMonthTabs() {
  document.getElementById('cashflowMonth').value=APP.currentMonth;
  const tabs = [];
  for (let i = -2; i <= 4; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const label = `${d.getFullYear()}年${d.getMonth()+1}月`;
    tabs.push({ key, label });
  }
  document.getElementById('monthTabs').innerHTML = tabs.map(t => `
    <div class="month-tab ${t.key === APP.currentMonth ? 'active' : ''}"
         onclick="switchMonth('${t.key}')">${t.label}</div>
  `).join('');
}

async function switchMonth(month) {
  CashflowMath.months(month,month,1);
  APP.currentMonth = month;
  renderMonthTabs();
  await loadCashflowMonth(month);
}

async function loadCashflowMonth(month) {
  today=getJstToday();
  document.getElementById('cashflowTableBody').innerHTML =
    '<tr><td colspan="9" style="text-align:center;padding:40px"><div class="loading-spinner" style="margin:0 auto"></div></td></tr>';

  await loadMasterData();
  const res = await gasApi('getTransactions', { month, all: true, through: month });
  APP.currentMonthData = res.data || [];
  if(res.day) today=parseDate(res.day);
  renderCashflowTable();
}

// ----------------------------------------------------------
// 口座フィルター
// ----------------------------------------------------------
function updateAccountFilterCount() {
  const el = document.getElementById('accountFilterCount');
  if (!el) return;
  const total = APP.accounts.length;
  const selected = (APP.selectedAccountIds || []).length;
  el.textContent = total > 0 ? `(${selected}/${total})` : '';
}

function openAccountFilterModal() {
  const checkboxesHtml = APP.accounts.map(a => {
    const checked = (APP.selectedAccountIds || []).includes(a.id);
    return `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer">
        <input type="checkbox" class="acct-filter-cb" value="${a.id}" ${checked ? 'checked' : ''}
               style="width:18px;height:18px;accent-color:var(--primary)">
        <span style="font-size:14px;font-weight:600">${escapeHtml(accountDisplayName(a))}</span>
        <span style="font-size:11px;color:var(--text-muted);margin-left:auto">${escapeHtml(a.type || '')}</span>
      </label>
    `;
  }).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">表示する口座を選択</div>
    <div class="modal-body">
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <button class="btn btn-outline btn-xs" onclick="toggleAllAccountFilters(true)">すべて選択</button>
        <button class="btn btn-outline btn-xs" onclick="toggleAllAccountFilters(false)">すべて解除</button>
      </div>
      <div>${checkboxesHtml || '<div style="padding:12px;color:var(--text-muted);font-size:13px">口座が登録されていません</div>'}</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="applyAccountFilter()">表示を更新</button>
    </div>
  `);
}

function toggleAllAccountFilters(checkedState) {
  document.querySelectorAll('.acct-filter-cb').forEach(cb => { cb.checked = checkedState; });
}

function applyAccountFilter() {
  const checked = Array.from(document.querySelectorAll('.acct-filter-cb:checked')).map(cb => cb.value);
  if (checked.length === 0) {
    showToast('最低1つは口座を選択してください', 'error');
    return;
  }
  APP.selectedAccountIds = checked;
  updateAccountFilterCount();
  closeModal();
  renderCashflowTable();
}

// ----------------------------------------------------------
// 日繰りテーブル描画（通帳形式：1取引=1行）
// ----------------------------------------------------------

/**
 * 選択中の口座リスト（accounts内の表示順=sort順）を返す
 */
function getVisibleAccounts() {
  const selected = APP.selectedAccountIds || APP.accounts.map(a => a.id);
  return APP.accounts
    .filter(a => selected.includes(a.id))
    .sort((a, b) => (Number(a.sort)||0) - (Number(b.sort)||0));
}

/**
 * テーブルヘッダーを選択口座に応じて動的生成
 * 固定列：日付・取引先・摘要・区分・状態
 * 口座ごとに：取引額・残高 の2列
 */
function renderCashflowTableHead() {
  const visibleAccounts = getVisibleAccounts();
  const accountHeaderCells = visibleAccounts.map(a => `
    <th colspan="2" style="text-align:center;min-width:170px;border-left:2px solid rgba(255,255,255,0.25)">${escapeHtml(accountDisplayName(a))}</th>
  `).join('');
  const accountSubHeaderCells = visibleAccounts.map(() => `
    <th style="min-width:85px;text-align:right;border-left:2px solid rgba(255,255,255,0.25)">取引額</th>
    <th style="min-width:85px;text-align:right">残高</th>
  `).join('');

  document.getElementById('cashflowTableHead').innerHTML = `
    <tr>
      <th rowspan="2" style="min-width:54px">日付</th>
      <th rowspan="2" style="min-width:160px">摘要</th>
      ${accountHeaderCells}
      <th rowspan="2" style="min-width:50px">状態</th>
    </tr>
    <tr>
      ${accountSubHeaderCells}
    </tr>
  `;
}

/**
 * 各選択口座の「表示開始時点（月初時点）の残高」を計算する。
 * 残高基準日の終了残高と全期間の実績から算出する。
 * 予測・差異では、月初までの未決済予定も反映する。
 */
function calcAccountOpeningBalances(monthStartDate) {
  return CashflowMath.opening(APP.accounts, APP.currentMonthData, toDateKey(monthStartDate).slice(0, 7), APP.currentMode, toDateKey(today));
}

/** 日繰りテーブル描画 */
function renderCashflowTable() {
  renderCashflowTableHead();

  const mode = APP.currentMode;
  const month = APP.currentMonth;
  document.getElementById('monthCloseLabel').textContent = mode === 'actual' ? '月末実績:' : '月末基本予測:';
  const [y, m] = month.split('-').map(Number);
  const monthStartDate = new Date(y, m - 1, 1);
  const visibleAccounts = getVisibleAccounts();
  const visibleAccountIds = visibleAccounts.map(a => a.id);
  const colCount = 2 + visibleAccounts.length * 2 + 1; // 固定2列（日付・摘要）＋口座2列×N＋状態1列

  // フィルタリング：選択口座の取引のみ、モードに応じた絞り込み
  const period=CashflowMath.period(visibleAccounts,APP.currentMonthData,month,month,mode,toDateKey(today))[0];
  const rows=period.rows;
  if(typeof Overdue!=='undefined')Overdue.banner('cashflowOverdue',APP.currentMonthData,visibleAccounts,mode!=='actual'&&month>=toDateKey(today).slice(0,7)?Object.values(period.totals).reduce((s,t)=>s+t.closing,0):null,APP.accounts);

  // 口座ごとの月初残高（選択中の口座のみ計算すればよいが全口座分計算しておく）
  const runningBalances = {...period.opening};

  // 月初残高表示：選択口座の合計
  const openingTotal = visibleAccountIds.reduce((s, id) => s + (runningBalances[id] || 0), 0);
  document.getElementById('monthOpenBalance').textContent = fmtMoney(openingTotal);

  const tbody = document.getElementById('cashflowTableBody');
  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="${colCount}" style="text-align:center;padding:40px;color:var(--text-muted)">
        <div style="font-size:14px">取引がありません</div>
        <div style="font-size:12px;margin-top:8px">＋ボタンから取引を追加してください</div>
      </td></tr>`;
    document.getElementById('monthCloseBalance').textContent = fmtMoney(openingTotal);
    return;
  }

  let html = '';

  rows.forEach(t => {
    const useActual = CashflowMath.hasActual(t);
    // 表示する金額・日付（モードにより分岐）
    const amount = t.cashAmount;
    const dateKey = t.cashDate;
    const isIncome = t.type === '入金';
    const signedAmount = isIncome ? amount : -amount; // 出金はマイナス表示

    // この取引が動かす口座の残高を更新
    if (runningBalances[t.account] !== undefined && t.status !== '取消') {
      runningBalances[t.account] += (isIncome?1:-1)*t.balanceAmount;
    }

    const statusColor = { '確定': '#0F9E6E', '予定': '#1E6FBF', '一部確定': '#D97706', '取消': '#9CA3AF' }[t.status] || '#9CA3AF';
    const rowClass = t.status === '取消' ? 'row-cancelled' : (useActual ? 'row-confirmed' : 'row-planned');

    // 差異モード：予定と実績の差額バッジ
    let diffHtml = '';
    if (mode === 'diff' && t.actualDate && t.plannedDate) {
      const amtDiff = (Number(t.actualAmount)||0) - (Number(t.plannedAmount)||0);
      diffHtml = `<div style="font-size:9px;color:${amtDiff >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
        差${amtDiff >= 0 ? '+' : ''}${fmtMoney(amtDiff)}
      </div>`;
    }

    const d = parseDate(dateKey);
    const dateCell = d ? `
      <div style="font-size:10px;color:var(--text-muted)">${d.toLocaleDateString('ja-JP',{weekday:'short',timeZone:'Asia/Tokyo'})}</div>
      <div style="font-size:14px;font-weight:700">${d.getMonth()+1}/${d.getDate()}</div>
    ` : '―';

    // 口座ごとのセルを生成（取引が発生した口座だけ金額を表示、他は空白。残高は全列で表示しキャリー）
    const accountCells = visibleAccounts.map(a => {
      const bal = runningBalances[a.id] || 0;
      const isThisAccount = (t.account === a.id) && t.status !== '取消';
      const amtCell = isThisAccount
        ? `<span class="${signedAmount >= 0 ? 'income' : 'expense'}">${signedAmount >= 0 ? '' : '-'}${fmtMoney(Math.abs(signedAmount)).replace('円','')}円</span>`
        : '';
      return `
        <td class="amount" style="text-align:right;border-left:2px solid var(--border)">${amtCell}</td>
        <td class="amount" style="text-align:right;color:${bal < 0 ? 'var(--accent-red)' : '#374151'}">${fmtMoney(bal)}</td>
      `;
    }).join('');

    html += `
      <tr class="${rowClass}" onclick="openTransactionDetail('${t.id}')" style="cursor:pointer">
        <td class="date-cell">${dateCell}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis">
          <div style="display:flex;align-items:baseline;gap:5px">
            <span class="badge ${isIncome ? 'badge-green' : 'badge-red'}" style="font-size:9px;flex-shrink:0">${isIncome ? '入' : '出'}</span>
            <span style="font-weight:600;font-size:12px">${escapeHtml(t.partner || '')}</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${escapeHtml(t.description || '')}</div>
        </td>
        ${accountCells}
        <td>
          <span class="status-dot" style="background:${statusColor}"></span>
          <span style="font-size:10px">${t.overdue?'期限超過・基本予測対象外':t.status}</span>
          ${diffHtml}
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  // 月末予測残高：選択口座の最終残高合計
  const closingTotal = visibleAccountIds.reduce((s, id) => s + (runningBalances[id] || 0), 0);
  document.getElementById('monthCloseBalance').textContent = fmtMoney(closingTotal);
}

/** 表示モード切替 */
function setMode(mode) {
  APP.currentMode = mode;
  ['predict','actual','diff'].forEach(m => {
    const btn = document.getElementById('mode' + m.charAt(0).toUpperCase() + m.slice(1));
    if (btn) {
      btn.classList.toggle('active', m === mode);
      btn.style.color = m === mode ? 'var(--primary)' : 'rgba(255,255,255,0.7)';
    }
  });
  renderCashflowTable();
}

// ----------------------------------------------------------
// Excel出力（月別：日繰り・選択口座の取引額/残高を含む）
// ----------------------------------------------------------
/**
 * 現在表示中の月・モード・選択口座の日繰り表をExcel(.xlsx)としてダウンロードする。
 * 画面表示と同じロジックで残高を再計算し、口座ごとに取引額・残高の列を並べる。
 */
function cashflowSheet(period,accounts,mode) {
  const header=['日付','取引先','摘要','区分','状態（期限超過は基本予測に不算入）'];
  accounts.forEach(a=>header.push(accountDisplayName(a)+' 取引額',accountDisplayName(a)+' 残高'));
  const running={...period.opening};
  const balanceRow=label=>['','',label,'','',...accounts.flatMap(a=>['',running[a.id]])];
  const data=[header,balanceRow('月初残高')];
  for(const t of period.rows){
    const amount=(t.type==='入金'?1:-1)*t.cashAmount;running[t.account]+=(t.type==='入金'?1:-1)*t.balanceAmount;
    data.push([t.cashDate.replaceAll('-','/'),t.partner||'',t.description||'',t.type,t.overdue?'期限超過・基本予測対象外':t.status,...accounts.flatMap(a=>[a.id===t.account?amount:'',running[a.id]])]);
  }
  data.push(balanceRow(mode==='actual'?'月末実績残高':'月末基本予測残高'));
  const sheet=XLSX.utils.aoa_to_sheet(data);
  sheet['!cols']=[{wch:12},{wch:16},{wch:28},{wch:8},{wch:8},...accounts.flatMap(()=>[{wch:13},{wch:13}])];
  return sheet;
}
function exportCashflowToExcel() {
  if(typeof XLSX==='undefined'){showToast('Excel出力ライブラリの読み込みに失敗しました','error');return;}
  const accounts=getVisibleAccounts();if(!accounts.length){showToast('出力する口座が選択されていません','error');return;}
  const mode=APP.currentMode,month=APP.currentMonth;
  const period=CashflowMath.period(accounts,APP.currentMonthData,month,month,mode,toDateKey(today))[0];
  const wb=XLSX.utils.book_new(),label={predict:'予測',actual:'実績',diff:'差異'}[mode];
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(overdueExcelRows(period,accounts)),'期限超過と参考値');
  XLSX.utils.book_append_sheet(wb,cashflowSheet(period,accounts,mode),'日繰り_'+label);
  XLSX.writeFile(wb,'日繰り_'+month+'_'+label+'.xlsx');
}
function openPeriodExport() {
  showModal('<div class="modal-title">期間を指定してExcel出力</div><div class="modal-body"><label>開始年月<input class="form-input" type="month" id="exportStart" value="'+APP.currentMonth+'"></label><label>終了年月<input class="form-input" type="month" id="exportEnd" value="'+APP.currentMonth+'"></label><p>最大60か月。現在選択中の口座・表示モードで出力します。</p><button class="btn btn-primary" id="exportPeriodRun">出力</button><button class="btn btn-outline" id="exportPeriodClose">閉じる</button></div>');
  document.getElementById('exportPeriodRun').addEventListener('click',exportCashflowPeriod);
  document.getElementById('exportPeriodClose').addEventListener('click',closeModal);
}
async function exportCashflowPeriod() {
  const button=document.getElementById('exportPeriodRun');
  try {
    const start=document.getElementById('exportStart').value,end=document.getElementById('exportEnd').value;
    CashflowMath.months(start,end,60);
    const accounts=getVisibleAccounts().map(a=>({...a})),mode=APP.currentMode,day=toDateKey(today);
    if(!accounts.length) throw new Error('出力する口座が選択されていません');
    button.disabled=true;
    const response=await gasApi('getCashflowPeriod',{start,end,mode,day,accounts:accounts.map(a=>a.id).join(',')});
    const periods=response.periods, exportAccounts=response.accounts;
    const wb=XLSX.utils.book_new();
    const summary=[['年月','銀行名・支店名','月初残高','算入入金（期限超過除外）','算入出金（期限超過除外）','月末基本予測／実績残高','期限超過入金件数','期限超過入金額','期限超過出金件数','期限超過出金額','期限超過分もすべて今後発生すると仮定した月末参考値']];
    for(const period of periods)for(const a of exportAccounts){const t=period.totals[a.id];summary.push([period.month,accountDisplayName(a),t.opening,t.income,t.expense,t.closing,...overdueExcelValues(period,a)]);}
    const sheet=XLSX.utils.aoa_to_sheet(summary);sheet['!cols']=[{wch:10},{wch:28},...Array.from({length:8},()=>({wch:22})),{wch:55}];
    sheet['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:summary.length-1,c:10}})};
    XLSX.utils.book_append_sheet(wb,sheet,'期間集計');
    for(const period of periods)XLSX.utils.book_append_sheet(wb,cashflowSheet(period,exportAccounts,mode),period.month);
    XLSX.writeFile(wb,'日繰り_'+start+'_'+end+'_'+({predict:'予測',actual:'実績',diff:'差異'}[mode])+'.xlsx');
    closeModal();
  }catch(error){showToast(error.message||'出力できませんでした','error');}finally{button.disabled=false;}
}


// ========================================================
// 取引詳細モーダル
// ========================================================
function openTransactionDetail(id) {
  const pending=APP.currentMonthData.find(t=>t.id===id);
  if(pending&&CashflowMath.isOverdue(pending,toDateKey(today))&&typeof Overdue!=='undefined'){Overdue.openId(id);return;}
  const t = APP.currentMonthData.find(x => x.id === id);
  if (!t) return;

  const useActual = CashflowMath.hasActual(t);
  if(useActual){ActualCorrections.open(id);return;}
  const plannedAmt = Number(t.plannedAmount) || 0;
  const actualAmt = Number(t.actualAmount) || 0;
  const amtDiff = actualAmt - plannedAmt;
  const dateDiff = (t.actualDate && t.plannedDate)
    ? Math.round((parseDate(t.actualDate) - parseDate(t.plannedDate)) / 86400000)
    : null;
  const accountName = accountDisplayName(APP.accounts.find(a => a.id === t.account)) || t.account || '';

  const statusColor = { '確定': 'green', '予定': 'blue', '一部確定': 'amber', '取消': 'gray' }[t.status] || 'gray';
  if(t.source==='payment_schedule'){PaymentSchedules.fromTransaction(t);return;}
  const isFixedExpense = t.source === 'fixed_expense';
  const isDebt = /^(receivable|payable)/.test(t.source || '');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">取引詳細</div>
    <div class="modal-body">
      <div style="margin-bottom:12px">
        <span class="badge badge-${statusColor}">${t.status}</span>
        <span class="badge ${t.type === '入金' ? 'badge-green' : 'badge-red'}" style="margin-left:6px">${escapeHtml(t.type)}</span>
        ${isFixedExpense ? '<span class="badge badge-amber" style="margin-left:6px">固定支出から自動生成</span>' : ''}
      </div>

      <div class="detail-row">
        <span class="detail-label">取引先</span>
        <span class="detail-value">${escapeHtml(t.partner || '―')}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">摘要</span>
        <span class="detail-value">${escapeHtml(t.description || '―')}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">口座</span>
        <span class="detail-value">${escapeHtml(accountName)}</span>
      </div>

      <div style="margin:16px 0;padding:12px;background:var(--surface-2);border-radius:8px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px">予定</div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px">${escapeHtml(fmtDate(t.plannedDate) || '未設定')}</span>
          <span class="amount ${t.type==='入金'?'income':'expense'}">${fmtMoney(plannedAmt)}</span>
        </div>
      </div>

      <div style="margin-bottom:16px;padding:12px;background:${useActual?'var(--accent-green-light)':'var(--surface-2)'};border-radius:8px;border:${useActual?'1px solid #86efac':''}" >
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px">実績</div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px">${escapeHtml(fmtDate(t.actualDate) || '未確定')}</span>
          <span class="amount ${t.type==='入金'?'income':'expense'}">${useActual ? fmtMoney(actualAmt) : '―'}</span>
        </div>
      </div>

      ${useActual ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
        <div style="background:var(--surface-2);border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:11px;color:var(--text-muted)">金額差異</div>
          <div class="amount ${amtDiff>=0?'diff-positive':'diff-negative'}" style="margin-top:4px">
            ${amtDiff>=0?'+':''}${fmtMoney(amtDiff)}
          </div>
        </div>
        <div style="background:var(--surface-2);border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:11px;color:var(--text-muted)">日付差</div>
          <div class="amount ${dateDiff===0?'':'diff-negative'}" style="margin-top:4px">
            ${dateDiff !== null ? (dateDiff === 0 ? '予定通り' : dateDiff > 0 ? '+'+dateDiff+'日遅延' : Math.abs(dateDiff)+'日早め') : '―'}
          </div>
        </div>
      </div>` : ''}

      ${t.memo ? `<div style="padding:10px;background:var(--surface-2);border-radius:8px;font-size:13px;color:var(--text-muted)">${escapeHtml(t.memo)}</div>` : ''}
    </div>
    <div class="modal-footer" style="flex-wrap:wrap">
      ${isDebt ? `<button class="btn btn-outline btn-sm" onclick="closeModal();navigate('${t.source.startsWith('receivable') ? 'receivables' : 'payables'}')">売掛・買掛で確認</button>` : useActual ? '' : isFixedExpense ? `<button class="btn btn-outline btn-sm" onclick="closeModal();navigate('settings')">固定支出マスタを開く</button>` : `<button class="btn btn-outline btn-sm" onclick="openTransactionForm('${id}')">編集</button>`}
      ${!useActual && !isDebt && t.status !== '取消' ? `<button class="btn btn-success btn-sm" onclick="closeModal();openConfirmForm('${id}')">実績確定</button>` : ''}
      ${!isFixedExpense && !isDebt && !useActual && t.status !== '取消' ? `<button class="btn btn-outline btn-sm" onclick="cancelTransaction('${id}')">取消</button>` : ''}
      ${!isFixedExpense && !isDebt && !useActual ? `<button class="btn btn-danger btn-sm" onclick="deleteTransaction('${id}')">削除</button>` : ''}
    </div>
  `);
}

// ========================================================
// 取引フォーム（新規・編集）
// ========================================================
function openTransactionForm(editId) {
  const t = editId ? APP.currentMonthData.find(x => x.id === editId) : null;
  const accountOptions = APP.accounts.map(a =>
    `<option value="${a.id}" ${t?.account===a.id?'selected':''}>${escapeHtml(accountDisplayName(a))}</option>`).join('');
  const partnerOptions = APP.partners.map(p =>
    `<option value="${escapeHtml(p.name)}" ${t?.partner===p.name?'selected':''}>${escapeHtml(p.name)}</option>`).join('');

  const today2 = toDateKey(today);

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${t ? '取引を編集' : '取引を追加'}</div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">区分 *</label>
          <select class="form-select" id="tf_type">
            <option value="入金" ${t?.type==='入金'?'selected':''}>入金</option>
            <option value="出金" ${t?.type==='出金'?'selected':''}>出金</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">口座 *</label>
          <select class="form-select" id="tf_account">${accountOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">取引先</label>
        <input list="partnerList_dl" class="form-input" id="tf_partner" placeholder="取引先名" value="${escapeHtml(t?.partner||'')}">
        <datalist id="partnerList_dl">${partnerOptions}</datalist>
      </div>
      <div class="form-group">
        <label class="form-label">摘要</label>
        <input class="form-input" id="tf_description" placeholder="内容・摘要" value="${escapeHtml(t?.description||'')}">
      </div>
      <div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-bottom:14px">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:10px">予定</div>
        <div class="form-row">
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">予定日 *</label>
            <input type="date" class="form-input" id="tf_plannedDate" value="${escapeHtml(t?.plannedDate || today2)}">
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">予定金額 *</label>
            <input type="number" class="form-input" id="tf_plannedAmount" placeholder="0" value="${t?.plannedAmount||''}">
          </div>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">メモ</label>
        <textarea class="form-textarea" id="tf_memo" rows="2">${escapeHtml(t?.memo||'')}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="saveTransaction(${editId ? `'${editId}'` : 'null'})">保存</button>
    </div>
  `);
}

/** 実績確定フォーム */
function openConfirmForm(id) {
  const pending=APP.currentMonthData.find(t=>t.id===id);
  if(pending&&CashflowMath.isOverdue(pending,toDateKey(today))&&typeof Overdue!=='undefined'){Overdue.openId(id);return;}
  const t = APP.currentMonthData.find(x => x.id === id);
  if (!t) return;
  if(t.source==='payment_schedule'){PaymentSchedules.fromTransaction(t);return;}
  const today2 = toDateKey(today);

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">実績確定</div>
    <div class="modal-body">
      <div style="padding:12px;background:var(--surface-2);border-radius:8px;margin-bottom:16px">
        <div style="font-size:12px;color:var(--text-muted)">予定</div>
        <div style="font-size:14px;font-weight:600;margin-top:4px">
          ${fmtDate(t.plannedDate)}　${fmtMoney(t.plannedAmount)}
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">実績日 *</label>
          <input type="date" class="form-input" id="cf_actualDate" value="${today2}">
        </div>
        <div class="form-group">
          <label class="form-label">実績金額 *</label>
          <input type="number" class="form-input" id="cf_actualAmount" placeholder="0" value="${t.plannedAmount||''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">確定状態</label>
        <select class="form-select" id="cf_status">
          <option value="確定">確定（全額）</option>

        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-success flex-1" onclick="confirmTransaction('${id}')">確定する</button>
    </div>
  `);
}

async function saveTransaction(editId) {
  const data = {
    id: editId || formRecordId(),
    type: document.getElementById('tf_type').value,
    account: document.getElementById('tf_account').value,
    partner: document.getElementById('tf_partner').value,
    description: document.getElementById('tf_description').value,
    plannedDate: document.getElementById('tf_plannedDate').value,
    plannedAmount: Number(document.getElementById('tf_plannedAmount').value),
    memo: document.getElementById('tf_memo').value,
    status: editId ? (APP.currentMonthData.find(x=>x.id===editId)?.status || '予定') : '予定',
    source: 'manual',
    sourceId: '',
    actualDate: null,
    actualAmount: null,
    createdAt: editId ? (APP.currentMonthData.find(x=>x.id===editId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (!data.plannedDate || !Number.isSafeInteger(data.plannedAmount) || data.plannedAmount < 0) {
    showToast('予定日と金額は必須です', 'error');
    return;
  }

  try {
    await gasPost('saveTransaction', data);
    closeModal();
    showToast(editId ? '更新しました' : '追加しました', 'success');
    await loadCashflowMonth(APP.currentMonth);
  } catch(e) {}
}

async function confirmTransaction(id) {
  const actualDate = document.getElementById('cf_actualDate').value;
  const actualAmount = Number(document.getElementById('cf_actualAmount').value);
  const status = document.getElementById('cf_status').value;

  if (!actualDate || document.getElementById('cf_actualAmount').value === '' || !Number.isSafeInteger(actualAmount) || actualAmount < 0) {
    showToast('実績日と実績金額は必須です', 'error');
    return;
  }

  const t = APP.currentMonthData.find(x => x.id === id);
  if (!t) return;

  try {
    await gasPost('saveTransaction', { ...t, actualDate, actualAmount, status, updatedAt: new Date().toISOString() });
    closeModal();
    showToast('実績を確定しました', 'success');
    await loadCashflowMonth(APP.currentMonth);
  } catch(e) {}
}

async function cancelTransaction(id) {
  if (!confirm('この取引を取消にしますか？')) return;
  const t = APP.currentMonthData.find(x => x.id === id);
  if (!t) return;
  try {
    await gasPost('saveTransaction', { ...t, status: '取消', updatedAt: new Date().toISOString() });
    closeModal();
    showToast('取消にしました');
    await loadCashflowMonth(APP.currentMonth);
  } catch(e) {}
}

async function deleteTransaction(id) {
  if (!confirm('この取引を削除しますか？この操作は取り消せません。')) return;
  try {
    await gasPost('deleteRecord', { sheet: 'cashflow_transactions', id });
    closeModal();
    showToast('削除しました');
    await loadCashflowMonth(APP.currentMonth);
  } catch(e) {}
}

// ========================================================
// 売掛管理
// ========================================================
let receivableFilter = 'all';

async function loadReceivables() {
  await loadMasterData();
  showLoading('receivablesList');
  const res = await gasApi('getReceivables');
  APP.receivables = res.data || [];
  renderReceivables();
  const total = APP.receivables
    .filter(r => r.status !== '回収済' && r.status !== '取消')
    .reduce((s, r) => s + (Number(r.amount) - Number(r.paidAmount||0)), 0);
  document.getElementById('receivableHeader').textContent = fmtMoney(total);
}

function filterReceivables(f) {
  receivableFilter = f;
  ['all','unpaid','overdue','partial','paid'].forEach(k => {
    const el = document.getElementById('rf' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.className = 'badge ' + (k === f ? 'badge-blue' : 'badge-gray');
  });
  renderReceivables();
}

function renderReceivables() {
  let data = APP.receivables;
  if (receivableFilter === 'unpaid') data = data.filter(r => r.status === '未回収');
  if (receivableFilter === 'overdue') data = data.filter(r => r.status === '遅延' || calcDelay(r.dueDate) > 0 && r.status !== '回収済' && r.status !== '取消');
  if (receivableFilter === 'partial') data = data.filter(r => r.status === '一部入金');
  if (receivableFilter === 'paid') data = data.filter(r => r.status === '回収済');

  const el = document.getElementById('receivablesList');
  if (data.length === 0) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">該当する売掛はありません</div>';
    return;
  }

  el.innerHTML = data.map(r => {
    const remaining = Number(r.amount) - Number(r.paidAmount || 0);
    const delay = calcDelay(r.dueDate);
    const statusMap = { '未回収': 'badge-blue', '回収済': 'badge-green', '一部入金': 'badge-amber', '遅延': 'badge-red' };
    const statusClass = statusMap[r.status] || (delay > 0 ? 'badge-red' : 'badge-gray');
    const actualStatus = delay > 0 && r.status !== '回収済' && r.status !== '取消' ? '遅延' : r.status;

    return `
      <div class="list-row" onclick="openReceivableDetail('${r.id}')">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.partner)}</span>
            <span class="badge ${statusClass}" style="flex-shrink:0">${actualStatus}</span>
            ${delay > 0 && r.status !== '回収済' && r.status !== '取消' ? `<span class="badge badge-red" style="flex-shrink:0">遅延${delay}日</span>` : ''}
          </div>
          <div style="display:flex;gap:12px;font-size:11px;color:var(--text-muted)">
            <span>請求日: ${escapeHtml(fmtDateShort(r.invoiceDate))}</span>
            <span>入金予定: ${escapeHtml(fmtDateShort(r.dueDate))}</span>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:6px;align-items:baseline">
            <span style="font-size:11px;color:var(--text-muted)">請求額 ${fmtMoney(r.amount)}</span>
            <span class="amount ${remaining > 0 ? 'expense' : 'income'}">
              未回収 ${fmtMoney(remaining)}
            </span>
          </div>
        </div>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:16px;color:var(--text-muted);flex-shrink:0"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>
      </div>
    `;
  }).join('');
}

function openReceivableDetail(id) {
  const r = APP.receivables.find(x => x.id === id);
  if (!r) return;
  const remaining = Number(r.amount) - Number(r.paidAmount || 0);
  const delay = calcDelay(r.dueDate);

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">売掛詳細</div>
    <div class="modal-body">
      <div style="margin-bottom:12px">
        <span class="badge ${delay>0&&r.status!=='回収済'&&r.status!=='取消'?'badge-red':'badge-blue'}">${delay>0&&r.status!=='回収済'&&r.status!=='取消'?'遅延'+delay+'日':r.status}</span>
      </div>
      <div class="detail-row"><span class="detail-label">取引先</span><span class="detail-value">${escapeHtml(r.partner)}</span></div>
      <div class="detail-row"><span class="detail-label">請求日</span><span class="detail-value">${escapeHtml(fmtDate(r.invoiceDate))}</span></div>
      <div class="detail-row"><span class="detail-label">請求額</span><span class="detail-value amount income">${fmtMoney(r.amount)}</span></div>
      <div class="detail-row"><span class="detail-label">入金予定日</span><span class="detail-value">${escapeHtml(fmtDate(r.dueDate))}</span></div>
      <div class="detail-row"><span class="detail-label">入金済額</span><span class="detail-value">${fmtMoney(r.paidAmount||0)}</span></div>
      <div class="detail-row"><span class="detail-label">${r.status==='取消'?'取消した未回収額':'未回収額'}</span><span class="detail-value amount ${remaining>0?'expense':'income'}">${fmtMoney(remaining)}</span></div>
      ${r.memo ? `<div style="margin-top:12px;padding:10px;background:var(--surface-2);border-radius:8px;font-size:13px">${escapeHtml(r.memo)}</div>` : ''}
      ${r.cfId ? `
      <div style="margin-top:12px">
        <button class="btn btn-outline w-full btn-sm" onclick="closeModal();navigate('cashflow');setTimeout(()=>openTransactionDetail('${r.cfId}'),500)">
          → 対応する日繰り明細を見る
        </button>
      </div>` : ''}
    </div>
    <div class="modal-footer" style="flex-wrap:wrap">
      ${r.status!=='取消'?`<button class="btn btn-outline btn-sm" onclick="closeModal();openReceivableForm('${id}')">編集</button>`:''}
      ${remaining > 0 && r.status!=='取消' ? `<button class="btn btn-success btn-sm" onclick="closeModal();openReceivableConfirm('${id}')">入金確定</button>` : ''}
      ${r.status!=='取消'?`<button class="btn btn-danger btn-sm" onclick="deleteReceivable('${id}')">削除</button>`:'<p>残予定取消済み。入金実績は保持しています。</p>'}
    </div>
  `);
}

function openReceivableForm(editId) {
  const r = editId ? APP.receivables.find(x => x.id === editId) : null;
  const todayStr = toDateKey(today);
  const partnerOptions = APP.partners.map(p =>
    `<option value="${escapeHtml(p.name)}" ${r?.partner===p.name?'selected':''}>${escapeHtml(p.name)}</option>`).join('');
  const accountOptions = APP.accounts.map(a =>
    `<option value="${a.id}" ${r?.account===a.id?'selected':''}>${escapeHtml(accountDisplayName(a))}</option>`).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${r ? '売掛を編集' : '売掛を追加'}</div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">取引先 *</label>
        <input list="partnerList_r" class="form-input" id="rf_partner" placeholder="取引先名" value="${escapeHtml(r?.partner||'')}">
        <datalist id="partnerList_r">${partnerOptions}</datalist>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">請求日 *</label>
          <input type="date" class="form-input" id="rf_invoiceDate" value="${escapeHtml(r?.invoiceDate || todayStr)}">
        </div>
        <div class="form-group">
          <label class="form-label">請求額 *</label>
          <input type="number" class="form-input" id="rf_amount" placeholder="0" value="${r?.amount||''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">入金予定日 *</label>
          <input type="date" class="form-input" id="rf_dueDate" value="${escapeHtml(r?.dueDate||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">入金口座</label>
          <select class="form-select" id="rf_account">${accountOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">メモ</label>
        <textarea class="form-textarea" id="rf_memo" rows="2">${escapeHtml(r?.memo||'')}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="saveReceivable(${editId?`'${editId}'`:'null'})">保存</button>
    </div>
  `);
}

function openReceivableConfirm(id) {
  const pending=APP.receivables.find(t=>t.id===id);
  if(pending&&pending.dueDate<toDateKey(today)&&typeof Overdue!=='undefined'){Overdue.openId(pending.cfId);return;}
  const r = APP.receivables.find(x => x.id === id);
  if (!r) return;
  const remaining = Number(r.amount) - Number(r.paidAmount||0);
  const todayStr = toDateKey(today);
  const accountOptions = APP.accounts.map(a => `<option value="${a.id}" ${r?.account===a.id?'selected':''}>${escapeHtml(accountDisplayName(a))}</option>`).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">入金確定</div>
    <div class="modal-body">
      <div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-bottom:16px">
        <div style="font-size:12px;color:var(--text-muted)">未回収額</div>
        <div class="amount income" style="font-size:20px;margin-top:4px">${fmtMoney(remaining)}</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">実績入金日 *</label>
          <input type="date" class="form-input" id="rc_date" value="${todayStr}">
        </div>
        <div class="form-group">
          <label class="form-label">入金額 *</label>
          <input type="number" class="form-input" id="rc_amount" value="${remaining}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">入金口座</label>
        <select class="form-select" id="rc_account">${accountOptions}</select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-success flex-1" onclick="confirmReceivable('${id}')">入金確定</button>
    </div>
  `);
}

async function saveReceivable(editId) {
  const data = {
    id: editId || formRecordId(), partner: document.getElementById('rf_partner').value,
    invoiceDate: document.getElementById('rf_invoiceDate').value,
    amount: Number(document.getElementById('rf_amount').value),
    dueDate: document.getElementById('rf_dueDate').value,
    account: document.getElementById('rf_account').value,
    memo: document.getElementById('rf_memo').value
  };
  try {
    await gasPost('saveReceivable', data);
    closeModal(); showToast('保存しました', 'success');
    await loadReceivables(); APP.currentMonthData = [];
  } catch (e) {}
}

async function confirmReceivable(id) {
  try {
    await gasPost('confirmReceivable', {
      id, paymentId: formRecordId(), date: document.getElementById('rc_date').value,
      amount: Number(document.getElementById('rc_amount').value),
      account: document.getElementById('rc_account').value
    });
    closeModal(); showToast('実績を保存しました', 'success');
    await loadReceivables(); APP.currentMonthData = [];
  } catch (e) {}
}

async function deleteReceivable(id) {
  if (!confirm('この売掛を削除しますか？')) return;
  try {
    await gasPost('deleteRecord', { sheet: 'receivables', id });
    closeModal();
    showToast('削除しました');
    await loadReceivables();
  } catch(e) {}
}

// ========================================================
// 買掛管理
// ========================================================
let payableFilter = 'all';

async function loadPayables() {
  await loadMasterData();
  showLoading('payablesList');
  const res = await gasApi('getPayables');
  APP.payables = res.data || [];
  renderPayables();
  const total = APP.payables
    .filter(p => p.status !== '支払済' && p.status !== '取消')
    .reduce((s, p) => s + (Number(p.amount) - Number(p.paidAmount||0)), 0);
  document.getElementById('payableHeader').textContent = fmtMoney(total);
}

function filterPayables(f) {
  payableFilter = f;
  ['all','unpaid','overdue','partial','paid'].forEach(k => {
    const el = document.getElementById('pf' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.className = 'badge ' + (k === f ? 'badge-blue' : 'badge-gray');
  });
  renderPayables();
}

function renderPayables() {
  let data = APP.payables;
  if (payableFilter === 'unpaid') data = data.filter(p => p.status === '未払');
  if (payableFilter === 'overdue') data = data.filter(p => calcDelay(p.dueDate) > 0 && p.status !== '支払済' && p.status !== '取消');
  if (payableFilter === 'partial') data = data.filter(p => p.status === '一部支払');
  if (payableFilter === 'paid') data = data.filter(p => p.status === '支払済');

  const el = document.getElementById('payablesList');
  if (data.length === 0) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">該当する買掛はありません</div>';
    return;
  }

  el.innerHTML = data.map(p => {
    const remaining = Number(p.amount) - Number(p.paidAmount || 0);
    const delay = calcDelay(p.dueDate);
    const actualStatus = delay > 0 && p.status !== '支払済' && p.status !== '取消' ? '遅延' : p.status;
    const statusMap = { '未払': 'badge-blue', '支払済': 'badge-green', '一部支払': 'badge-amber', '遅延': 'badge-red' };
    const statusClass = statusMap[actualStatus] || 'badge-gray';

    return `
      <div class="list-row" onclick="openPayableDetail('${p.id}')">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-weight:700;font-size:14px">${escapeHtml(p.partner)}</span>
            <span class="badge ${statusClass}">${actualStatus}</span>
            ${delay > 0 && p.status !== '支払済' && p.status !== '取消' ? `<span class="badge badge-red">遅延${delay}日</span>` : ''}
          </div>
          <div style="display:flex;gap:12px;font-size:11px;color:var(--text-muted)">
            <span>発生日: ${escapeHtml(fmtDateShort(p.occDate))}</span>
            <span>支払予定: ${escapeHtml(fmtDateShort(p.dueDate))}</span>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:6px;align-items:baseline">
            <span style="font-size:11px;color:var(--text-muted)">支払予定 ${fmtMoney(p.amount)}</span>
            <span class="amount ${remaining > 0 ? 'expense' : 'income'}">未払 ${fmtMoney(remaining)}</span>
          </div>
        </div>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:16px;color:var(--text-muted);flex-shrink:0"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>
      </div>
    `;
  }).join('');
}

function openPayableDetail(id) {
  const p = APP.payables.find(x => x.id === id);
  if (!p) return;
  const remaining = Number(p.amount) - Number(p.paidAmount||0);
  const delay = calcDelay(p.dueDate);

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">買掛詳細</div>
    <div class="modal-body">
      <div style="margin-bottom:12px">
        <span class="badge ${delay>0&&p.status!=='支払済'&&p.status!=='取消'?'badge-red':'badge-blue'}">${delay>0&&p.status!=='支払済'&&p.status!=='取消'?'遅延'+delay+'日':p.status}</span>
      </div>
      <div class="detail-row"><span class="detail-label">取引先</span><span class="detail-value">${escapeHtml(p.partner)}</span></div>
      <div class="detail-row"><span class="detail-label">発生日</span><span class="detail-value">${escapeHtml(fmtDate(p.occDate))}</span></div>
      <div class="detail-row"><span class="detail-label">支払予定額</span><span class="detail-value amount expense">${fmtMoney(p.amount)}</span></div>
      <div class="detail-row"><span class="detail-label">支払予定日</span><span class="detail-value">${escapeHtml(fmtDate(p.dueDate))}</span></div>
      <div class="detail-row"><span class="detail-label">支払済額</span><span class="detail-value">${fmtMoney(p.paidAmount||0)}</span></div>
      <div class="detail-row"><span class="detail-label">${p.status==='取消'?'取消した未払額':'未払額'}</span><span class="detail-value amount ${remaining>0?'expense':'income'}">${fmtMoney(remaining)}</span></div>
      ${p.memo ? `<div style="margin-top:12px;padding:10px;background:var(--surface-2);border-radius:8px;font-size:13px">${escapeHtml(p.memo)}</div>` : ''}
      ${p.cfId ? `
      <div style="margin-top:12px">
        <button class="btn btn-outline w-full btn-sm" onclick="closeModal();navigate('cashflow');setTimeout(()=>openTransactionDetail('${p.cfId}'),500)">
          → 対応する日繰り明細を見る
        </button>
      </div>` : ''}
    </div>
    <div class="modal-footer" style="flex-wrap:wrap">
      ${p.status!=='取消'?`<button class="btn btn-outline btn-sm" onclick="closeModal();openPayableForm('${id}')">編集</button>`:''}
      ${remaining > 0 && p.status!=='取消' ? `<button class="btn btn-danger btn-sm" onclick="closeModal();openPayableConfirm('${id}')">支払確定</button>` : ''}
      ${p.status!=='取消'?`<button class="btn btn-danger btn-sm" onclick="deletePayable('${id}')">削除</button>`:'<p>残予定取消済み。支払実績は保持しています。</p>'}
    </div>
  `);
}

function openPayableForm(editId) {
  const p = editId ? APP.payables.find(x => x.id === editId) : null;
  const todayStr = toDateKey(today);
  const partnerOptions = APP.partners.map(pt =>
    `<option value="${escapeHtml(pt.name)}" ${p?.partner===pt.name?'selected':''}>${escapeHtml(pt.name)}</option>`).join('');
  const accountOptions = APP.accounts.map(a => `<option value="${a.id}" ${p?.account===a.id?'selected':''}>${escapeHtml(accountDisplayName(a))}</option>`).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${p ? '買掛を編集' : '買掛を追加'}</div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">取引先 *</label>
        <input list="partnerList_p" class="form-input" id="pf_partner" placeholder="取引先名" value="${escapeHtml(p?.partner||'')}">
        <datalist id="partnerList_p">${partnerOptions}</datalist>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">発生日 *</label>
          <input type="date" class="form-input" id="pf_occDate" value="${escapeHtml(p?.occDate || todayStr)}">
        </div>
        <div class="form-group">
          <label class="form-label">支払予定額 *</label>
          <input type="number" class="form-input" id="pf_amount" placeholder="0" value="${p?.amount||''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">支払予定日 *</label>
          <input type="date" class="form-input" id="pf_dueDate" value="${escapeHtml(p?.dueDate||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">支払口座</label>
          <select class="form-select" id="pf_account">${accountOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">メモ</label>
        <textarea class="form-textarea" id="pf_memo" rows="2">${escapeHtml(p?.memo||'')}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="savePayable(${editId?`'${editId}'`:'null'})">保存</button>
    </div>
  `);
}

function openPayableConfirm(id) {
  const pending=APP.payables.find(t=>t.id===id);
  if(pending&&pending.dueDate<toDateKey(today)&&typeof Overdue!=='undefined'){Overdue.openId(pending.cfId);return;}
  const p = APP.payables.find(x => x.id === id);
  if (!p) return;
  const remaining = Number(p.amount) - Number(p.paidAmount||0);
  const todayStr = toDateKey(today);
  const accountOptions = APP.accounts.map(a => `<option value="${a.id}" ${p?.account===a.id?'selected':''}>${escapeHtml(accountDisplayName(a))}</option>`).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">支払確定</div>
    <div class="modal-body">
      <div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-bottom:16px">
        <div style="font-size:12px;color:var(--text-muted)">未払額</div>
        <div class="amount expense" style="font-size:20px;margin-top:4px">${fmtMoney(remaining)}</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">実績支払日 *</label>
          <input type="date" class="form-input" id="pc_date" value="${todayStr}">
        </div>
        <div class="form-group">
          <label class="form-label">支払額 *</label>
          <input type="number" class="form-input" id="pc_amount" value="${remaining}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">支払口座</label>
        <select class="form-select" id="pc_account">${accountOptions}</select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-danger flex-1" onclick="confirmPayable('${id}')">支払確定</button>
    </div>
  `);
}

async function savePayable(editId) {
  const data = {
    id: editId || formRecordId(), partner: document.getElementById('pf_partner').value,
    occDate: document.getElementById('pf_occDate').value,
    amount: Number(document.getElementById('pf_amount').value),
    dueDate: document.getElementById('pf_dueDate').value,
    account: document.getElementById('pf_account').value,
    memo: document.getElementById('pf_memo').value
  };
  try {
    await gasPost('savePayable', data);
    closeModal(); showToast('保存しました', 'success');
    await loadPayables(); APP.currentMonthData = [];
  } catch (e) {}
}

async function confirmPayable(id) {
  try {
    await gasPost('confirmPayable', {
      id, paymentId: formRecordId(), date: document.getElementById('pc_date').value,
      amount: Number(document.getElementById('pc_amount').value),
      account: document.getElementById('pc_account').value
    });
    closeModal(); showToast('実績を保存しました', 'success');
    await loadPayables(); APP.currentMonthData = [];
  } catch (e) {}
}

async function deletePayable(id) {
  if (!confirm('この買掛を削除しますか？')) return;
  try {
    await gasPost('deleteRecord', { sheet: 'payables', id });
    closeModal();
    showToast('削除しました');
    await loadPayables();
  } catch(e) {}
}

// ========================================================
// 口座管理
// ========================================================
async function loadAccounts() {
  await loadMasterData();
  const el = document.getElementById('accountList');
  if (APP.accounts.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">口座がありません</div>';
    return;
  }
  el.innerHTML = APP.accounts.map(a => `
    <div class="list-row">
      <div style="flex:1">
        <div style="font-weight:700;font-size:15px">${escapeHtml(accountDisplayName(a))}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${escapeHtml(a.type || '')}</div>
      </div>
      <div style="text-align:right">
        <div class="amount balance">${fmtMoney(a.balance)}</div><div style="font-size:11px">基準日：${escapeHtml(a.balanceDate || '未設定')}</div>
        <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end">
          <button class="btn btn-outline btn-xs" onclick="openAccountForm('${a.id}')">編集</button>
          <button class="btn btn-danger btn-xs" onclick="deleteAccount('${a.id}')">削除</button>
        </div>
      </div>
    </div>
  `).join('');
}

function openAccountForm(editId) {
  const a = editId ? APP.accounts.find(x => x.id === editId) : null;
  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${a ? '口座を編集' : '口座を追加'}</div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label" for="af_bank">銀行名 *</label>
        <input class="form-input" id="af_bank" required maxlength="120" placeholder="例：もみじ銀行" value="${escapeHtml(a?.bank||'')}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="af_branch">支店名</label>
          <input class="form-input" id="af_branch" maxlength="120" placeholder="例：西条支店" value="${escapeHtml(a?.branch||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">種別</label>
          <select class="form-select" id="af_type">
            <option value="普通" ${a?.type==='普通'?'selected':''}>普通預金</option>
            <option value="当座" ${a?.type==='当座'?'selected':''}>当座預金</option>
            <option value="現金" ${a?.type==='現金'?'selected':''}>現金</option>
            <option value="定期" ${a?.type==='定期'?'selected':''}>定期預金</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="af_accountNumber">口座番号</label>
        <input type="text" inputmode="numeric" maxlength="32" class="form-input" id="af_accountNumber" autocomplete="off" placeholder="例：0012345" value="${escapeHtml(a?.accountNumber||'')}">
      </div>
      <div class="form-group">
        <label class="form-label">基準日の終了時点の実績残高</label>
        <input type="number" class="form-input" id="af_balance" placeholder="0" value="${a?.balance||0}">
        <label class="form-label" style="margin-top:10px">残高基準日 *</label>
        <input type="date" class="form-input" id="af_balanceDate" max="${toDateKey(today)}" value="${escapeHtml(a?.balanceDate || '')}">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">基準日までの入出金を含む残高を入力します。以後の実績は日付ごとに加減します。通常は前日の終了残高から開始してください。</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="saveAccount(${editId?`'${editId}'`:'null'})">保存</button>
    </div>
  `);
}

async function saveAccount(editId) {
  const bank = document.getElementById('af_bank').value.trim();
  if (!bank) { showToast('銀行名は必須です', 'error'); return; }

  const data = {
    id: editId || formRecordId(),
    bank,
    branch: document.getElementById('af_branch').value.trim(),
    accountNumber: document.getElementById('af_accountNumber').value.trim(),
    type: document.getElementById('af_type').value,
    balance: Number(document.getElementById('af_balance').value),
    balanceDate: document.getElementById('af_balanceDate').value,
    sort: editId ? (APP.accounts.find(x=>x.id===editId)?.sort || APP.accounts.length+1) : APP.accounts.length+1,
    updatedAt: new Date().toISOString(),
    createdAt: editId ? (APP.accounts.find(x=>x.id===editId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
  };

  try {
    await gasPost('saveAccount', data);
    APP.accounts = []; // キャッシュクリア
    APP.selectedAccountIds = null; // 口座フィルターを再初期化（新口座も表示対象に含める）
    closeModal();
    showToast(editId ? '口座を更新しました' : '口座を追加しました', 'success');
    await loadMasterData();
    APP.selectedAccountIds = APP.accounts.map(a => a.id);
    await loadAccounts();
  } catch(e) {}
}

async function deleteAccount(id) {
  if (!confirm('この口座を削除しますか？')) return;
  try {
    await gasPost('deleteRecord', { sheet: 'accounts', id });
    APP.accounts = [];
    await loadMasterData();
    // 削除された口座をフィルター選択から除外
    if (APP.selectedAccountIds) {
      APP.selectedAccountIds = APP.selectedAccountIds.filter(aid => APP.accounts.some(a => a.id === aid));
      if (APP.selectedAccountIds.length === 0) APP.selectedAccountIds = APP.accounts.map(a => a.id);
    }
    await loadAccounts();
    showToast('削除しました');
  } catch(e) {}
}


// ========================================================
// 設定画面
// ========================================================
function loadSettings() {
  document.getElementById('companyNameInput').value = APP.companyName;
  return Promise.all([loadMasterData(), loadFixedExpenses(), refreshBackupStatus()]).then(() => {
    renderPartnerList();
  });
}

async function saveCompanyName() {
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
  try{const res=await fetch('/api/v1/backup-status');if(res.status===401){location.replace('/login.html');return;}if(!res.ok)throw new Error();const data=await res.json();
    const messages={ok:'VPS内バックアップは正常です',missing:'バックアップがまだ取得されていません',failed:'バックアップの取得に失敗しています。管理者に確認してください',stale:'バックアップが90分以上更新されていません。管理者に確認してください'};
    banner.textContent=data.state==='ok'?'':messages[data.state];banner.classList.toggle('hidden',data.state==='ok');
    detail.textContent=messages[data.state]+(data.lastSuccessAt?'。最終成功: '+new Date(data.lastSuccessAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+'（日本時間）':'')+'。外部バックアップは未導入です。';
  }catch{banner.textContent='バックアップ状態を確認できません。再読み込みしてください';banner.classList.remove('hidden');}
}

function renderPartnerList() {
  const el = document.getElementById('partnerList');
  el.innerHTML = APP.partners.map(p => `
    <div class="list-row" style="padding:10px 16px">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600">${escapeHtml(p.name)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(p.type||'')}</div>
      </div>
      <button class="btn btn-danger btn-xs" onclick="deletePartner('${p.id}')">削除</button>
    </div>
  `).join('') || '<div style="padding:12px 16px;font-size:13px;color:var(--text-muted)">取引先なし</div>';
}

function openPartnerForm() {
  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">取引先を追加</div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">取引先名 *</label>
        <input class="form-input" id="pt_name" placeholder="株式会社〇〇">
      </div>
      <div class="form-group">
        <label class="form-label">種別</label>
        <select class="form-select" id="pt_type">
          <option value="売掛">売掛先</option>
          <option value="買掛">買掛先</option>
          <option value="両方">両方</option>
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="savePartner()">追加</button>
    </div>
  `);
}

async function savePartner() {
  const name = document.getElementById('pt_name').value.trim();
  if (!name) { showToast('取引先名は必須です', 'error'); return; }
  const data = { id: formRecordId(), name, type: document.getElementById('pt_type').value, createdAt: new Date().toISOString() };
  try {
    await gasPost('savePartner', data);
    APP.partners = [];
    await loadMasterData();
    closeModal();
    renderPartnerList();
    showToast('取引先を追加しました', 'success');
  } catch(e) {}
}

async function deletePartner(id) {
  if (!confirm('この取引先を削除しますか？')) return;
  try {
    await gasPost('deleteRecord', { sheet: 'partners', id });
    APP.partners = [];
    await loadMasterData();
    renderPartnerList();
    showToast('削除しました');
  } catch(e) {}
}


// ========================================================
// 固定支出マスタ
// ========================================================
async function loadFixedExpenses() {
  const res = await gasApi('getFixedExpenses');
  APP.fixedExpenses = res.data || [];
  renderFixedExpenseList();
}

function fixedExpenseRuleLabel(rule) {
  return { next: '翌営業日', previous: '前営業日', none: '当日そのまま' }[rule] || '当日そのまま';
}

function fixedExpenseAccountLabel(accountId) {
  const account = APP.accounts.find(item => item.id === accountId);
  if (!account) return accountId || '口座未設定';
  return accountDisplayName(account);
}

function renderFixedExpenseList() {
  const el = document.getElementById('fixedExpenseList');
  if (!el) return;

  if (APP.fixedExpenses.length === 0) {
    el.innerHTML = '<div class="empty-master">固定支出はまだ登録されていません</div>';
    return;
  }

  el.innerHTML = APP.fixedExpenses
    .slice()
    .sort((a, b) => Number(a.day) - Number(b.day) || String(a.name).localeCompare(String(b.name), 'ja'))
    .map(item => `
      <div class="master-row">
        <div class="master-row-main">
          <div class="master-row-title">
            <span>${escapeHtml(item.name)}</span>
            <span class="badge badge-red">毎月 ${Number(item.day)}日</span>
          </div>
          <div class="master-row-sub">${escapeHtml(item.payee)} ・ ${escapeHtml(fixedExpenseAccountLabel(item.account))}</div>
          <div class="master-row-meta">
            <span class="amount expense">${fmtMoney(item.amount)}</span>
            <span>${escapeHtml(item.startMonth)}〜${escapeHtml(item.endMonth || '継続')}</span>
            <span>休日: ${fixedExpenseRuleLabel(item.holidayRule)}</span>
          </div>
          ${item.memo ? `<div class="master-row-memo">${escapeHtml(item.memo)}</div>` : ''}
        </div>
        <div class="master-row-actions">
          <button class="btn btn-outline btn-xs" onclick="openFixedExpenseForm('${item.id}')">編集</button>
          <button class="btn btn-danger btn-xs" onclick="openFixedExpenseDeleteDialog('${item.id}')">削除</button>
        </div>
      </div>
    `).join('');
}

function openFixedExpenseForm(editId) {
  const item = editId ? APP.fixedExpenses.find(value => value.id === editId) : null;
  const startDefault = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const endDate = new Date(today.getFullYear(), today.getMonth() + 11, 1);
  const endDefault = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`;

  const accountOptions = APP.accounts.map(account => {
    const label = accountDisplayName(account);
    return `<option value="${account.id}" ${item?.account === account.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${item ? '固定支出を編集' : '固定支出を追加'}</div>
    <div class="modal-body">
      <div class="alert-banner alert-blue" style="margin-bottom:16px">
        当月から12か月先まで保存し、それより先は表示時に計算します。確定済み実績・取消は保持します。
      </div>
      <div class="form-group">
        <label class="form-label">支出名 *</label>
        <input class="form-input" id="fe_name" placeholder="例：事務所家賃" value="${escapeHtml(item?.name || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">支払先 *</label>
        <input class="form-input" id="fe_payee" placeholder="例：株式会社〇〇不動産" value="${escapeHtml(item?.payee || '')}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">金額 *</label>
          <input type="number" min="1" class="form-input" id="fe_amount" placeholder="0" value="${item?.amount || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">基本引き落とし日 *</label>
          <input type="number" min="1" max="31" class="form-input" id="fe_day" value="${item?.day || 25}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">開始月 *</label>
          <input type="month" class="form-input" id="fe_startMonth" value="${escapeHtml(item?.startMonth || startDefault)}">
        </div>
        <div class="form-group">
          <label class="form-label">終了月</label>
          <label><input type="checkbox" id="fe_continuous" ${item && item.endMonth === null ? 'checked' : ''}> 終了月なし（継続）</label>
          <input type="month" class="form-input" id="fe_endMonth" ${item && item.endMonth === null ? 'disabled' : ''} value="${escapeHtml(item?.endMonth || endDefault)}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">支払口座／金融機関 *</label>
        <select class="form-select" id="fe_account">${accountOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label">休日時の処理方法</label>
        <select class="form-select" id="fe_holidayRule">
          <option value="next" ${item?.holidayRule === 'next' ? 'selected' : ''}>翌営業日</option>
          <option value="previous" ${item?.holidayRule === 'previous' ? 'selected' : ''}>前営業日</option>
          <option value="none" ${!item || item.holidayRule === 'none' ? 'selected' : ''}>当日そのまま</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">備考</label>
        <textarea class="form-textarea" id="fe_memo" rows="2">${escapeHtml(item?.memo || '')}</textarea>
      </div>
      ${item ? `
      <div class="form-group">
        <label class="form-label">変更を反映する範囲</label>
        <select class="form-select" id="fe_scope">
          <option value="future">今後の予定だけ変更</option>
          <option value="all">登録済みの全期間を変更</option>
        </select>
        <div class="form-help">確定済みの実績は、どちらを選んでも保護されます。</div>
      </div>` : ''}
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="saveFixedExpenseForm(${editId ? `'${editId}'` : 'null'})">保存して予定へ反映</button>
    </div>
  `);
}

async function saveFixedExpenseForm(editId) {
  const existing = editId ? APP.fixedExpenses.find(item => item.id === editId) : null;
  const data = {
    id: editId || formRecordId(),
    name: document.getElementById('fe_name').value.trim(),
    payee: document.getElementById('fe_payee').value.trim(),
    amount: Number(document.getElementById('fe_amount').value),
    day: Number(document.getElementById('fe_day').value),
    startMonth: document.getElementById('fe_startMonth').value,
    endMonth: document.getElementById('fe_continuous').checked ? null : document.getElementById('fe_endMonth').value,
    account: document.getElementById('fe_account').value,
    holidayRule: document.getElementById('fe_holidayRule').value,
    memo: document.getElementById('fe_memo').value.trim(),
    scope: editId ? document.getElementById('fe_scope').value : 'all',
    createdAt: existing?.createdAt || new Date().toISOString()
  };

  if (!data.name || !data.payee || !(data.amount > 0) || !(data.day >= 1 && data.day <= 31) ||
      !data.startMonth || (data.endMonth !== null && !data.endMonth) || !data.account) {
    showToast('必須項目を確認してください', 'error');
    return;
  }
  if (data.endMonth && data.startMonth > data.endMonth) {
    showToast('終了月は開始月以降にしてください', 'error');
    return;
  }

  try {
    const result = await gasPost('saveFixedExpense', data);
    closeModal();
    APP.currentMonthData = [];
    APP.transactions = [];
    await loadFixedExpenses();
    const changed = Number(result.generated || 0) + Number(result.updated || 0);
    showToast(`固定支出を保存し、${changed}件の予定を反映しました`, 'success');
  } catch (e) {}
}

function openFixedExpenseDeleteDialog(id) {
  const item = APP.fixedExpenses.find(value => value.id === id);
  if (!item) return;

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">固定支出を削除</div>
    <div class="modal-body">
      <div style="font-weight:700;margin-bottom:8px">${escapeHtml(item.name)}</div>
      <div style="font-size:13px;color:var(--text-muted);line-height:1.7">
        削除する予定の範囲を選んでください。確定済み実績は保護されます。
      </div>
    </div>
    <div class="modal-footer" style="display:grid;grid-template-columns:1fr;gap:8px">
      <button class="btn btn-outline" onclick="deleteFixedExpenseMaster('${id}', 'future')">今後の予定だけ削除</button>
      <button class="btn btn-danger" onclick="deleteFixedExpenseMaster('${id}', 'all')">登録済みの全期間を削除</button>
      <button class="btn btn-outline" onclick="closeModal()">キャンセル</button>
    </div>
  `);
}

async function deleteFixedExpenseMaster(id, scope) {
  try {
    const result = await gasPost('deleteFixedExpense', { id, scope });
    closeModal();
    APP.currentMonthData = [];
    APP.transactions = [];
    await loadFixedExpenses();
    showToast(`固定支出と未確定予定${Number(result.removed || 0)}件を削除しました`, 'success');
  } catch (e) {}
}

// ========================================================
// モーダル制御
// ========================================================
function showModal(html, isCenter = false) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay' + (isCenter ? ' center' : '');
  overlay.id = 'activeModal';
  overlay.innerHTML = `<div class="${isCenter ? 'modal-dialog' : 'modal-sheet'}">${html}</div>`;
  // 背景タップで閉じる
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.getElementById('modalContainer').appendChild(overlay);
}

function closeModal() {
  const m = document.getElementById('activeModal');
  if (m) m.remove();
}

// ========================================================
// 初期化
// ========================================================
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res=await fetch('/auth/session');if(!res.ok){location.replace('/login.html');return;}
    const session=await res.json();APP.csrf=session.csrf;
    const settings=await gasApi('getSettings');APP.companyName=settings.companyName;
    document.getElementById('companyNameNav').textContent=APP.companyName;
    navigate('home');await refreshBackupStatus();await refreshFixedMaintenance();setInterval(()=>{refreshBackupStatus();refreshFixedMaintenance();if(toDateKey(today)!==toDateKey(getJstToday())&&!APP.writeBusy&&!document.getElementById('activeModal')){if(APP.currentPage==='home')loadHome().catch(()=>showToast('日付更新のため再読み込みしてください','error'));else if(APP.currentPage==='cashflow')loadCashflowMonth(APP.currentMonth).catch(()=>showToast('日付更新のため再読み込みしてください','error'));}},60000);
  }catch(e){showToast('読み込めませんでした。画面を再読み込みしてください','error');}
});

// New controls use event listeners rather than inline script attributes.
document.addEventListener('change',event=>{
  if(event.target.id==='fe_continuous')document.getElementById('fe_endMonth').disabled=event.target.checked;
});
document.addEventListener('DOMContentLoaded',()=>{
  const move=delta=>switchMonth(CashflowMath.shiftMonth(APP.currentMonth,delta)).catch(e=>showToast(e.message,'error'));
  document.getElementById('cashflowPrevious').addEventListener('click',()=>move(-1));
  document.getElementById('cashflowNext').addEventListener('click',()=>move(1));
  document.getElementById('cashflowToday').addEventListener('click',()=>switchMonth(toDateKey(getJstToday()).slice(0,7)));
  document.getElementById('cashflowMonth').addEventListener('change',e=>switchMonth(e.target.value).catch(error=>showToast(error.message,'error')));
  document.getElementById('periodExport').addEventListener('click',openPeriodExport);
});

async function refreshFixedMaintenance(){
  try{const state=await gasApi('getFixedExpenseMaintenance');document.getElementById('fixedMaintenanceStatus').textContent=state.state==='ok'?'固定支出の自動補充：正常（'+state.lastSuccessDay+'）':'固定支出の自動補充を確認してください：'+state.state;}catch{document.getElementById('fixedMaintenanceStatus').textContent='固定支出の自動補充状態を取得できません';}
}

function overdueExcelValues(period,a){const d=CashflowMath.overdue(period.overdue.data,[a.id],period.day);return [d.income.count,d.income.amount,d.expense.count,d.expense.amount,period.totals[a.id].reference];}
function overdueExcelRows(period,accounts){return [['判定日',period.day],['計算方法','基本予測＋期限超過未確定入金－期限超過未確定出金。過去月・実績モードの参考値は表示しません。'],['銀行名・支店名','月末基本予測／実績','期限超過入金件数','期限超過入金額','期限超過出金件数','期限超過出金額','すべて今後発生すると仮定した参考値'],...accounts.map(a=>[accountDisplayName(a),period.totals[a.id].closing,...overdueExcelValues(period,a)]),[],['元予定日','区分','取引先','摘要','未確定額'],...period.overdue.data.map(t=>[t.plannedDate,t.type,t.partner,t.description,Number(t.plannedAmount)])];}
