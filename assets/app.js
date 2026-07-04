// ========================================================
// グローバル状態管理
// ========================================================
const APP = {
  gasUrl: localStorage.getItem('gasUrl') || '',
  companyName: localStorage.getItem('companyName') || '資金繰りシステム',
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
  demoFixedExpenses: null,    // デモモード用の固定支出マスタ
  selectedAccountIds: null, // 日繰りで表示する口座ID配列（null=未初期化、初期化後は全口座IDの配列）
};

// 今日の日付（JST基準）
const today = getJstToday();

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
// GAS API通信
// ========================================================
async function gasApi(action, params = {}) {
  if (!APP.gasUrl) {
    // GAS未設定時はデモデータを返す
    return getDemoData(action, params);
  }
  try {
    const url = new URL(APP.gasUrl);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([k, v]) => {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
    });
    const res = await fetch(url.toString(), { method: 'GET' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (e) {
    console.error('GAS API Error:', e);
    showToast('通信エラー: ' + e.message, 'error');
    throw e;
  }
}

async function gasPost(action, body = {}) {
  if (!APP.gasUrl) {
    return getDemoData(action, body);
  }
  try {
    const res = await fetch(APP.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (e) {
    console.error('GAS POST Error:', e);
    showToast('保存エラー: ' + e.message, 'error');
    throw e;
  }
}

// ========================================================
// デモデータ（GAS未設定時のサンプル）
// ========================================================
function getDemoData(action, params) {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();

  // サンプル口座
  const accounts = [
    { id: 'acc1', name: 'メイン口座', bank: '〇〇銀行', type: '普通', balance: 5280000, sort: 1 },
    { id: 'acc2', name: '補助口座', bank: '△△銀行', type: '普通', balance: 1200000, sort: 2 },
    { id: 'acc3', name: '小口現金①', bank: '', type: '現金', balance: 85000, sort: 3 },
    { id: 'acc4', name: '小口現金②', bank: '', type: '現金', balance: 30000, sort: 4 },
  ];

  // サンプル取引先
  const partners = [
    { id: 'p1', name: '株式会社ABC商事', type: '売掛' },
    { id: 'p2', name: '有限会社XYZ工業', type: '買掛' },
    { id: 'p3', name: 'DEFサービス株式会社', type: '両方' },
    { id: 'p4', name: '〇〇電力', type: '買掛' },
  ];

  // サンプル売掛
  const receivables = [
    { id: 'r1', partner: '株式会社ABC商事', invoiceDate: fmt(y,m,5), amount: 1200000, dueDate: fmt(y,m,25), paidAmount: 0, status: '未回収', cfId: 'cf_r1' },
    { id: 'r2', partner: 'DEFサービス株式会社', invoiceDate: fmt(y,m,1), amount: 550000, dueDate: fmt(y,m,15), paidAmount: 550000, status: '回収済', cfId: 'cf_r2' },
    { id: 'r3', partner: '株式会社ABC商事', invoiceDate: fmt(y,m-1,20), amount: 880000, dueDate: fmt(y,m,10), paidAmount: 0, status: '遅延', cfId: 'cf_r3' },
  ];

  // サンプル買掛
  const payables = [
    { id: 'py1', partner: '有限会社XYZ工業', occDate: fmt(y,m,1), amount: 650000, dueDate: fmt(y,m,28), paidAmount: 0, status: '未払', cfId: 'cf_py1' },
    { id: 'py2', partner: '〇〇電力', occDate: fmt(y,m,1), amount: 48000, dueDate: fmt(y,m,27), paidAmount: 0, status: '未払', cfId: 'cf_py2' },
    { id: 'py3', partner: 'DEFサービス株式会社', occDate: fmt(y,m-1,15), amount: 230000, dueDate: fmt(y,m-1,28), paidAmount: 230000, status: '支払済', cfId: 'cf_py3' },
  ];

  // サンプル固定支出
  if (!APP.demoFixedExpenses) {
    APP.demoFixedExpenses = [
      { id: 'fe_demo_rent', name: '事務所家賃', payee: '〇〇不動産株式会社', amount: 300000, day: 25,
        startMonth: `${y}-01`, endMonth: `${y}-12`, account: 'acc1', holidayRule: 'next', memo: 'デモ固定支出' }
    ];
  }
  const fixedExpenses = APP.demoFixedExpenses;

  // サンプル取引データ（現在月）
  const month = params.month || `${y}-${String(m+1).padStart(2,'0')}`;
  const [ym, mm] = month.split('-').map(Number);
  const transactions = generateDemoTransactions(ym, mm-1);
  transactions.push(...generateDemoFixedExpenseTransactions(ym, mm - 1, fixedExpenses));

  function fmt(yr, mo, d) {
    const dt = new Date(yr, mo, d);
    return dt.toISOString().slice(0,10);
  }

  switch(action) {
    case 'getAccounts': return { data: accounts };
    case 'getPartners': return { data: partners };
    case 'getReceivables': return { data: receivables };
    case 'getPayables': return { data: payables };
    case 'getFixedExpenses': return { data: fixedExpenses };
    case 'getTransactions': return { data: transactions };
    case 'saveAccount': return { success: true, id: genId() };
    case 'saveTransaction': return { success: true, id: genId() };
    case 'saveReceivable': return { success: true, id: genId() };
    case 'savePayable': return { success: true, id: genId() };
    case 'saveFixedExpense': {
      const record = { ...params, id: params.id || genId(), updatedAt: new Date().toISOString() };
      const index = APP.demoFixedExpenses.findIndex(item => item.id === record.id);
      if (index >= 0) APP.demoFixedExpenses[index] = record;
      else APP.demoFixedExpenses.push(record);
      const months = Math.max(1, (Number(record.endMonth.slice(0,4)) - Number(record.startMonth.slice(0,4))) * 12 + Number(record.endMonth.slice(5,7)) - Number(record.startMonth.slice(5,7)) + 1);
      return { success: true, id: record.id, generated: months, updated: 0, removed: 0, protected: 0 };
    }
    case 'deleteFixedExpense':
      APP.demoFixedExpenses = APP.demoFixedExpenses.filter(item => item.id !== params.id);
      return { success: true, id: params.id, removed: 1, protected: 0 };
    case 'deleteRecord': return { success: true };
    case 'testConnection': return { success: true, message: 'デモモードで動作中' };
    default: return { data: [] };
  }
}

function generateDemoTransactions(y, m) {
  const data = [];
  const days = new Date(y, m+1, 0).getDate();

  // 月初残高（口座ごと）
  const openBalances = { acc1: 5280000, acc2: 1200000, acc3: 85000, acc4: 30000 };

  // 固定取引パターン
  const fixed = [
    { day: 5, partner: 'DEFサービス株式会社', desc: '売上入金', type: '入金', account: 'acc1', planned: 550000, actual: 550000, status: '確定' },
    { day: 10, partner: '株式会社ABC商事', desc: '売掛回収（遅延）', type: '入金', account: 'acc1', planned: 880000, actual: null, status: '予定' },
    { day: 15, partner: '〇〇電力', desc: '電気代', type: '出金', account: 'acc1', planned: 48000, actual: 48000, status: '確定' },
    { day: 20, partner: '有限会社XYZ工業', desc: '仕入支払', type: '出金', account: 'acc1', planned: 325000, actual: null, status: '予定' },
    { day: 25, partner: '株式会社ABC商事', desc: '売掛回収予定', type: '入金', account: 'acc1', planned: 1200000, actual: null, status: '予定' },
    { day: 27, partner: '〇〇電力', desc: '電気代支払', type: '出金', account: 'acc1', planned: 48000, actual: null, status: '予定' },
    { day: 28, partner: '有限会社XYZ工業', desc: '買掛支払予定', type: '出金', account: 'acc1', planned: 650000, actual: null, status: '予定' },
    { day: 10, partner: '', desc: '小口補充', type: '出金', account: 'acc2', planned: 50000, actual: 50000, status: '確定' },
    { day: 10, partner: '', desc: '小口補充', type: '入金', account: 'acc3', planned: 50000, actual: 50000, status: '確定' },
  ];

  fixed.forEach((f, i) => {
    const planned = new Date(y, m, f.day);
    const actual = f.actual !== null ? new Date(y, m, f.day) : null;
    data.push({
      id: 'demo_' + i,
      source: 'manual',
      sourceId: '',
      status: f.status,
      type: f.type,
      partner: f.partner,
      description: f.desc,
      account: f.account,
      plannedDate: planned.toISOString().slice(0,10),
      plannedAmount: f.planned,
      actualDate: actual ? actual.toISOString().slice(0,10) : null,
      actualAmount: f.actual,
      memo: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });
  return data;
}


// ----------------------------------------------------------
// デモモード用の固定支出予定生成
// 実運用ではGASの holiday.gs / fixedExpense.gs が正本。
// ----------------------------------------------------------
const DEMO_HOLIDAY_CACHE = {};

function generateDemoFixedExpenseTransactions(year, monthIndex, masters) {
  const month = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  return masters
    .filter(item => item.startMonth <= month && item.endMonth >= month)
    .map(item => {
      const lastDay = new Date(year, monthIndex + 1, 0).getDate();
      const baseDate = new Date(year, monthIndex, Math.min(Number(item.day), lastDay));
      const plannedDate = adjustDemoBusinessDate(baseDate, item.holidayRule);
      return {
        id: `fx_${item.id}_${month.replace('-', '')}`,
        source: 'fixed_expense',
        sourceId: item.id,
        status: '予定',
        type: '出金',
        partner: item.payee,
        description: '【固定支出】' + item.name,
        account: item.account,
        plannedDate: toDateKey(plannedDate),
        plannedAmount: Number(item.amount),
        actualDate: null,
        actualAmount: null,
        memo: '[固定支出マスタ自動生成]' + (item.memo ? ' ' + item.memo : ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });
}

function adjustDemoBusinessDate(date, rule) {
  const adjusted = new Date(date);
  if (rule === 'none') return adjusted;
  const direction = rule === 'previous' ? -1 : 1;
  while (!isDemoBusinessDay(adjusted)) adjusted.setDate(adjusted.getDate() + direction);
  return adjusted;
}

function isDemoBusinessDay(date) {
  return date.getDay() !== 0 && date.getDay() !== 6 &&
    !getDemoJapaneseHolidays(date.getFullYear()).has(toDateKey(date));
}

function getDemoJapaneseHolidays(year) {
  if (DEMO_HOLIDAY_CACHE[year]) return DEMO_HOLIDAY_CACHE[year];
  const holidays = new Set();
  const add = (month, day) => holidays.add(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  );
  const nthMonday = (month, nth) => {
    const first = new Date(year, month - 1, 1);
    return 1 + ((8 - first.getDay()) % 7) + (nth - 1) * 7;
  };

  add(1, 1); add(1, nthMonday(1, 2)); add(2, 11);
  if (year >= 2020) add(2, 23);
  if (year >= 1980 && year <= 2099) {
    add(3, Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4)));
  }
  add(4, 29); add(5, 3); add(5, 4); add(5, 5);
  if (year === 2020) { add(7, 23); add(7, 24); add(8, 10); }
  else if (year === 2021) { add(7, 22); add(7, 23); add(8, 8); }
  else { add(7, nthMonday(7, 3)); if (year >= 2016) add(8, 11); add(10, nthMonday(10, 2)); }
  add(9, nthMonday(9, 3));
  if (year >= 1980 && year <= 2099) {
    add(9, Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4)));
  }
  add(11, 3); add(11, 23);

  for (let date = new Date(year, 0, 2); date <= new Date(year, 11, 30); date.setDate(date.getDate() + 1)) {
    const key = toDateKey(date);
    if (holidays.has(key)) continue;
    const prev = new Date(date); prev.setDate(prev.getDate() - 1);
    const next = new Date(date); next.setDate(next.getDate() + 1);
    if (holidays.has(toDateKey(prev)) && holidays.has(toDateKey(next))) holidays.add(key);
  }

  Array.from(holidays).sort().forEach(key => {
    const holiday = parseDate(key);
    if (holiday.getDay() !== 0) return;
    const substitute = new Date(holiday);
    do substitute.setDate(substitute.getDate() + 1); while (holidays.has(toDateKey(substitute)));
    holidays.add(toDateKey(substitute));
  });

  DEMO_HOLIDAY_CACHE[year] = holidays;
  return holidays;
}

// ========================================================
// ナビゲーション
// ========================================================
function navigate(page) {
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
  switch(page) {
    case 'home': loadHome(); break;
    case 'cashflow': loadCashflow(); break;
    case 'receivables': loadReceivables(); break;
    case 'payables': loadPayables(); break;
    case 'accounts': loadAccounts(); break;
    case 'settings': loadSettings(); break;
  }
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
  document.getElementById('homeDate').textContent =
    `${today.getFullYear()}年${today.getMonth()+1}月${today.getDate()}日 現在`;

  // マスタデータ取得
  await Promise.all([loadMasterData()]);

  // 残高計算
  const [txRes, recRes, payRes] = await Promise.all([
    gasApi('getTransactions', { month: `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}` }),
    gasApi('getReceivables'),
    gasApi('getPayables'),
  ]);

  APP.transactions = txRes.data || [];
  APP.receivables = recRes.data || [];
  APP.payables = payRes.data || [];

  // 口座別現在残高
  const totalBalance = APP.accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  document.getElementById('totalBalance').textContent = fmtMoney(totalBalance);
  document.getElementById('balanceAsOf').textContent = `実績残高（口座合計）`;

  // 口座リスト
  const acEl = document.getElementById('accountBalanceList');
  acEl.innerHTML = APP.accounts.map(a => `
    <div class="list-row" style="cursor:default">
      <div style="flex:1">
        <div style="font-weight:600;font-size:14px">${a.name}</div>
        <div style="font-size:11px;color:var(--text-muted)">${a.bank || a.type || ''}</div>
      </div>
      <div class="amount" style="color:var(--primary)">${fmtMoney(a.balance)}</div>
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
    .filter(r => r.status !== '回収済')
    .reduce((s, r) => s + (Number(r.amount) - Number(r.paidAmount || 0)), 0);
  document.getElementById('totalReceivables').textContent = fmtMoney(totalRec);

  // 未払買掛
  const totalPay = APP.payables
    .filter(p => p.status !== '支払済')
    .reduce((s, p) => s + (Number(p.amount) - Number(p.paidAmount || 0)), 0);
  document.getElementById('totalPayables').textContent = fmtMoney(totalPay);

  // ヘッダー更新
  document.getElementById('receivableHeader').textContent = fmtMoney(totalRec);
  document.getElementById('payableHeader').textContent = fmtMoney(totalPay);

  // アラート
  renderAlerts(eom, d30);

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
  let base = accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  // 今日以降の予定取引を加算
  transactions.forEach(t => {
    if (t.status === '取消') return;
    // 予測モード: 確定は実績、未確定は予定
    let date, amount;
    if (t.actualDate && t.actualAmount) {
      date = parseDate(t.actualDate);
      amount = Number(t.actualAmount);
    } else {
      date = parseDate(t.plannedDate);
      amount = Number(t.plannedAmount);
    }
    if (!date || date > targetDate) return;
    if (date <= today) return; // 今日以前は残高に既に反映されている想定
    if (t.type === '入金') base += amount;
    else base -= amount;
  });
  return base;
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
    container.innerHTML = `<div class="alert-banner alert-blue"><span>✅</span><div>現在アラートはありません</div></div>`;
    return;
  }
  container.innerHTML = alerts.map(a => `
    <div class="alert-banner alert-${a.type}">
      <span style="font-size:18px;flex-shrink:0">${a.icon}</span>
      <div>
        <div style="font-weight:700;margin-bottom:2px">${a.title}</div>
        <div style="font-size:12px;opacity:0.85">${a.msg}</div>
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
    const amt = Number(t.actualAmount || t.plannedAmount);
    const isIncome = t.type === '入金';
    return `
      <div class="list-row">
        <div style="width:40px;text-align:center;flex-shrink:0">
          <div style="font-size:10px;color:var(--text-muted)">${String(d.getMonth()+1).padStart(2,'0')}月</div>
          <div style="font-size:18px;font-weight:700;line-height:1">${d.getDate()}</div>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.partner || t.description}</div>
          <div style="font-size:11px;color:var(--text-muted)">${t.description}</div>
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
  if (APP.accounts.length === 0) {
    const [acRes, ptRes] = await Promise.all([
      gasApi('getAccounts'),
      gasApi('getPartners'),
    ]);
    APP.accounts = acRes.data || [];
    APP.partners = ptRes.data || [];
  }
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
  APP.currentMonth = month;
  renderMonthTabs();
  await loadCashflowMonth(month);
}

async function loadCashflowMonth(month) {
  document.getElementById('cashflowTableBody').innerHTML =
    '<tr><td colspan="9" style="text-align:center;padding:40px"><div class="loading-spinner" style="margin:0 auto"></div></td></tr>';

  const res = await gasApi('getTransactions', { month });
  APP.currentMonthData = res.data || [];
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
        <span style="font-size:14px;font-weight:600">${a.name}</span>
        <span style="font-size:11px;color:var(--text-muted);margin-left:auto">${a.bank || a.type || ''}</span>
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
    <th colspan="2" style="text-align:center;min-width:170px;border-left:2px solid rgba(255,255,255,0.25)">${a.name}</th>
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
 * 考え方：口座マスタのbalanceは「現在（今日）の実績残高」を表す前提とし、
 * 今日から月初前日までの間に発生した確定済み取引を逆算して差し引く。
 * （今日より先の取引は将来分なので影響しない）
 */
function calcAccountOpeningBalances(monthStartDate) {
  const opening = {};
  APP.accounts.forEach(a => { opening[a.id] = Number(a.balance) || 0; });

  // 今日時点の残高から、月初〜今日の間に確定した取引を遡って差し引く
  // ＝ 月初残高 = 現在残高 - (月初〜今日に発生した確定済み入出金の合計)
  APP.currentMonthData.forEach(t => {
    if (t.status === '取消') return;
    if (!t.actualDate || !t.actualAmount) return; // 確定済みのみが現在残高に反映されている
    const ad = parseDate(t.actualDate);
    if (!ad) return;
    // 月初以降〜今日以前に確定した取引を差し引く対象とする
    if (ad >= monthStartDate && ad <= today) {
      const amt = Number(t.actualAmount) || 0;
      if (opening[t.account] === undefined) return;
      opening[t.account] += (t.type === '入金') ? -amt : amt;
    }
  });

  return opening;
}

/** 日繰りテーブル描画 */
function renderCashflowTable() {
  renderCashflowTableHead();

  const mode = APP.currentMode;
  const month = APP.currentMonth;
  const [y, m] = month.split('-').map(Number);
  const monthStartDate = new Date(y, m - 1, 1);
  const visibleAccounts = getVisibleAccounts();
  const visibleAccountIds = visibleAccounts.map(a => a.id);
  const colCount = 2 + visibleAccounts.length * 2 + 1; // 固定2列（日付・摘要）＋口座2列×N＋状態1列

  // フィルタリング：選択口座の取引のみ、モードに応じた絞り込み
  let rows = APP.currentMonthData.filter(t => {
    if (!visibleAccountIds.includes(t.account)) return false; // 選択口座外は非表示
    if (t.status === '取消') return mode !== 'actual'; // 取消は実績モードでは非表示
    if (mode === 'actual') {
      return t.actualDate && t.actualAmount; // 実績モード: 実績確定のみ
    }
    return true; // 予測・差異モードは全表示
  });

  // 日付＋作成順でソート（予測モードは確定済みなら実績日、未確定なら予定日／実績モードは実績日）
  rows.sort((a, b) => {
    const da = parseDate(mode === 'actual' ? a.actualDate : (a.actualDate || a.plannedDate));
    const db = parseDate(mode === 'actual' ? b.actualDate : (b.actualDate || b.plannedDate));
    if (!da && !db) return 0;
    if (!da) return 1; if (!db) return -1;
    if (da - db !== 0) return da - db;
    // 同日内は作成日時の昇順（入力順）で安定ソート
    return String(a.createdAt||'').localeCompare(String(b.createdAt||''));
  });

  // 口座ごとの月初残高（選択中の口座のみ計算すればよいが全口座分計算しておく）
  const runningBalances = calcAccountOpeningBalances(monthStartDate);

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
    const useActual = !!(t.actualDate && t.actualAmount);
    // 表示する金額・日付（モードにより分岐）
    const amount = Number(mode === 'actual' ? t.actualAmount : (useActual ? t.actualAmount : t.plannedAmount)) || 0;
    const dateKey = mode === 'actual' ? t.actualDate : (t.actualDate || t.plannedDate);
    const isIncome = t.type === '入金';
    const signedAmount = isIncome ? amount : -amount; // 出金はマイナス表示

    // この取引が動かす口座の残高を更新
    if (runningBalances[t.account] !== undefined && t.status !== '取消') {
      runningBalances[t.account] += signedAmount;
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
            <span style="font-weight:600;font-size:12px">${t.partner || ''}</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${t.description || ''}</div>
        </td>
        ${accountCells}
        <td>
          <span class="status-dot" style="background:${statusColor}"></span>
          <span style="font-size:10px">${t.status}</span>
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
function exportCashflowToExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('Excel出力ライブラリの読み込みに失敗しました', 'error');
    return;
  }

  const mode = APP.currentMode;
  const month = APP.currentMonth;
  const [y, m] = month.split('-').map(Number);
  const monthStartDate = new Date(y, m - 1, 1);
  const visibleAccounts = getVisibleAccounts();
  const visibleAccountIds = visibleAccounts.map(a => a.id);

  if (visibleAccounts.length === 0) {
    showToast('出力する口座が選択されていません', 'error');
    return;
  }

  // 画面表示と同じフィルタ・ソート条件で対象行を抽出
  let rows = APP.currentMonthData.filter(t => {
    if (!visibleAccountIds.includes(t.account)) return false;
    if (t.status === '取消') return mode !== 'actual';
    if (mode === 'actual') return t.actualDate && t.actualAmount;
    return true;
  });
  rows.sort((a, b) => {
    const da = parseDate(mode === 'actual' ? a.actualDate : (a.actualDate || a.plannedDate));
    const db = parseDate(mode === 'actual' ? b.actualDate : (b.actualDate || b.plannedDate));
    if (!da && !db) return 0;
    if (!da) return 1; if (!db) return -1;
    if (da - db !== 0) return da - db;
    return String(a.createdAt||'').localeCompare(String(b.createdAt||''));
  });

  // 口座ごとの月初残高から開始し、行ごとに残高を更新しながら配列を組み立てる
  const runningBalances = calcAccountOpeningBalances(monthStartDate);

  // ヘッダー行（口座ごとに「取引額・残高」2列）
  const header = ['日付', '取引先', '摘要', '区分', '状態'];
  visibleAccounts.forEach(a => { header.push(`${a.name} 取引額`, `${a.name} 残高`); });

  const sheetRows = [header];

  // 月初残高の行を先頭に追加（参考情報として）
  const openingRow = ['', '', '月初残高', '', ''];
  visibleAccounts.forEach(a => { openingRow.push('', runningBalances[a.id] || 0); });
  sheetRows.push(openingRow);

  rows.forEach(t => {
    const useActual = !!(t.actualDate && t.actualAmount);
    const amount = Number(mode === 'actual' ? t.actualAmount : (useActual ? t.actualAmount : t.plannedAmount)) || 0;
    const dateKey = mode === 'actual' ? t.actualDate : (t.actualDate || t.plannedDate);
    const isIncome = t.type === '入金';
    const signedAmount = isIncome ? amount : -amount;

    if (runningBalances[t.account] !== undefined && t.status !== '取消') {
      runningBalances[t.account] += signedAmount;
    }

    const d = parseDate(dateKey);
    const dateStr = d ? `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}` : '';

    const row = [dateStr, t.partner || '', t.description || '', isIncome ? '入金' : '出金', t.status];
    visibleAccounts.forEach(a => {
      const isThisAccount = (t.account === a.id) && t.status !== '取消';
      row.push(isThisAccount ? signedAmount : '', runningBalances[a.id] || 0);
    });
    sheetRows.push(row);
  });

  // 月末残高の行を末尾に追加
  const closingRow = ['', '', '月末予測残高', '', ''];
  visibleAccounts.forEach(a => { closingRow.push('', runningBalances[a.id] || 0); });
  sheetRows.push(closingRow);

  // シート生成
  const ws = XLSX.utils.aoa_to_sheet(sheetRows);

  // 列幅の調整（日付・取引先・摘要・区分・状態＋口座列）
  ws['!cols'] = [
    { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 8 }, { wch: 8 },
    ...visibleAccounts.flatMap(() => [{ wch: 13 }, { wch: 13 }]),
  ];

  const wb = XLSX.utils.book_new();
  const modeLabel = { predict: '予測', actual: '実績', diff: '差異' }[mode] || '';
  XLSX.utils.book_append_sheet(wb, ws, `日繰り_${modeLabel}`);

  const fileName = `日繰り_${month}_${modeLabel}.xlsx`;
  XLSX.writeFile(wb, fileName);
  showToast('Excelファイルを出力しました', 'success');
}

// ========================================================
// 取引詳細モーダル
// ========================================================
function openTransactionDetail(id) {
  const t = APP.currentMonthData.find(x => x.id === id);
  if (!t) return;

  const useActual = t.actualDate && t.actualAmount;
  const plannedAmt = Number(t.plannedAmount) || 0;
  const actualAmt = Number(t.actualAmount) || 0;
  const amtDiff = actualAmt - plannedAmt;
  const dateDiff = (t.actualDate && t.plannedDate)
    ? Math.round((parseDate(t.actualDate) - parseDate(t.plannedDate)) / 86400000)
    : null;
  const accountName = (APP.accounts.find(a => a.id === t.account) || {}).name || t.account || '';

  const statusColor = { '確定': 'green', '予定': 'blue', '一部確定': 'amber', '取消': 'gray' }[t.status] || 'gray';
  const isFixedExpense = t.source === 'fixed_expense';

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">取引詳細</div>
    <div class="modal-body">
      <div style="margin-bottom:12px">
        <span class="badge badge-${statusColor}">${t.status}</span>
        <span class="badge ${t.type === '入金' ? 'badge-green' : 'badge-red'}" style="margin-left:6px">${t.type}</span>
        ${isFixedExpense ? '<span class="badge badge-amber" style="margin-left:6px">固定支出から自動生成</span>' : ''}
      </div>

      <div class="detail-row">
        <span class="detail-label">取引先</span>
        <span class="detail-value">${t.partner || '―'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">摘要</span>
        <span class="detail-value">${t.description || '―'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">口座</span>
        <span class="detail-value">${accountName}</span>
      </div>

      <div style="margin:16px 0;padding:12px;background:var(--surface-2);border-radius:8px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px">予定</div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px">${fmtDate(t.plannedDate) || '未設定'}</span>
          <span class="amount ${t.type==='入金'?'income':'expense'}">${fmtMoney(plannedAmt)}</span>
        </div>
      </div>

      <div style="margin-bottom:16px;padding:12px;background:${useActual?'var(--accent-green-light)':'var(--surface-2)'};border-radius:8px;border:${useActual?'1px solid #86efac':''}" >
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px">実績</div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px">${fmtDate(t.actualDate) || '未確定'}</span>
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

      ${t.memo ? `<div style="padding:10px;background:var(--surface-2);border-radius:8px;font-size:13px;color:var(--text-muted)">${t.memo}</div>` : ''}
    </div>
    <div class="modal-footer" style="flex-wrap:wrap">
      ${isFixedExpense ? `<button class="btn btn-outline btn-sm" onclick="closeModal();navigate('settings')">固定支出マスタを開く</button>` : `<button class="btn btn-outline btn-sm" onclick="openTransactionForm('${id}')">編集</button>`}
      ${!useActual ? `<button class="btn btn-success btn-sm" onclick="closeModal();openConfirmForm('${id}')">実績確定</button>` : ''}
      ${!isFixedExpense && t.status !== '取消' ? `<button class="btn btn-outline btn-sm" onclick="cancelTransaction('${id}')">取消</button>` : ''}
      ${!isFixedExpense ? `<button class="btn btn-danger btn-sm" onclick="deleteTransaction('${id}')">削除</button>` : ''}
    </div>
  `);
}

// ========================================================
// 取引フォーム（新規・編集）
// ========================================================
function openTransactionForm(editId) {
  const t = editId ? APP.currentMonthData.find(x => x.id === editId) : null;
  const accountOptions = APP.accounts.map(a =>
    `<option value="${a.id}" ${t?.account===a.id?'selected':''}>${a.name}</option>`).join('');
  const partnerOptions = APP.partners.map(p =>
    `<option value="${p.name}" ${t?.partner===p.name?'selected':''}>${p.name}</option>`).join('');

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
        <input list="partnerList_dl" class="form-input" id="tf_partner" placeholder="取引先名" value="${t?.partner||''}">
        <datalist id="partnerList_dl">${partnerOptions}</datalist>
      </div>
      <div class="form-group">
        <label class="form-label">摘要</label>
        <input class="form-input" id="tf_description" placeholder="内容・摘要" value="${t?.description||''}">
      </div>
      <div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-bottom:14px">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:10px">予定</div>
        <div class="form-row">
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">予定日 *</label>
            <input type="date" class="form-input" id="tf_plannedDate" value="${t?.plannedDate || today2}">
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">予定金額 *</label>
            <input type="number" class="form-input" id="tf_plannedAmount" placeholder="0" value="${t?.plannedAmount||''}">
          </div>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">メモ</label>
        <textarea class="form-textarea" id="tf_memo" rows="2">${t?.memo||''}</textarea>
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
  const t = APP.currentMonthData.find(x => x.id === id);
  if (!t) return;
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
          <option value="一部確定">一部確定</option>
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
    id: editId || genId(),
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

  if (!data.plannedDate || !data.plannedAmount) {
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

  if (!actualDate || !actualAmount) {
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
    .filter(r => r.status !== '回収済')
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
  if (receivableFilter === 'overdue') data = data.filter(r => r.status === '遅延' || calcDelay(r.dueDate) > 0 && r.status !== '回収済');
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
    const actualStatus = delay > 0 && r.status !== '回収済' ? '遅延' : r.status;

    return `
      <div class="list-row" onclick="openReceivableDetail('${r.id}')">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.partner}</span>
            <span class="badge ${statusClass}" style="flex-shrink:0">${actualStatus}</span>
            ${delay > 0 && r.status !== '回収済' ? `<span class="badge badge-red" style="flex-shrink:0">遅延${delay}日</span>` : ''}
          </div>
          <div style="display:flex;gap:12px;font-size:11px;color:var(--text-muted)">
            <span>請求日: ${fmtDateShort(r.invoiceDate)}</span>
            <span>入金予定: ${fmtDateShort(r.dueDate)}</span>
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
        <span class="badge ${delay>0&&r.status!=='回収済'?'badge-red':'badge-blue'}">${delay>0&&r.status!=='回収済'?'遅延'+delay+'日':r.status}</span>
      </div>
      <div class="detail-row"><span class="detail-label">取引先</span><span class="detail-value">${r.partner}</span></div>
      <div class="detail-row"><span class="detail-label">請求日</span><span class="detail-value">${fmtDate(r.invoiceDate)}</span></div>
      <div class="detail-row"><span class="detail-label">請求額</span><span class="detail-value amount income">${fmtMoney(r.amount)}</span></div>
      <div class="detail-row"><span class="detail-label">入金予定日</span><span class="detail-value">${fmtDate(r.dueDate)}</span></div>
      <div class="detail-row"><span class="detail-label">入金済額</span><span class="detail-value">${fmtMoney(r.paidAmount||0)}</span></div>
      <div class="detail-row"><span class="detail-label">未回収額</span><span class="detail-value amount ${remaining>0?'expense':'income'}">${fmtMoney(remaining)}</span></div>
      ${r.memo ? `<div style="margin-top:12px;padding:10px;background:var(--surface-2);border-radius:8px;font-size:13px">${r.memo}</div>` : ''}
      ${r.cfId ? `
      <div style="margin-top:12px">
        <button class="btn btn-outline w-full btn-sm" onclick="closeModal();navigate('cashflow');setTimeout(()=>openTransactionDetail('${r.cfId}'),500)">
          → 対応する日繰り明細を見る
        </button>
      </div>` : ''}
    </div>
    <div class="modal-footer" style="flex-wrap:wrap">
      <button class="btn btn-outline btn-sm" onclick="closeModal();openReceivableForm('${id}')">編集</button>
      ${remaining > 0 ? `<button class="btn btn-success btn-sm" onclick="closeModal();openReceivableConfirm('${id}')">入金確定</button>` : ''}
      <button class="btn btn-danger btn-sm" onclick="deleteReceivable('${id}')">削除</button>
    </div>
  `);
}

function openReceivableForm(editId) {
  const r = editId ? APP.receivables.find(x => x.id === editId) : null;
  const todayStr = toDateKey(today);
  const partnerOptions = APP.partners.map(p =>
    `<option value="${p.name}" ${r?.partner===p.name?'selected':''}>${p.name}</option>`).join('');
  const accountOptions = APP.accounts.map(a =>
    `<option value="${a.id}">${a.name}</option>`).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${r ? '売掛を編集' : '売掛を追加'}</div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">取引先 *</label>
        <input list="partnerList_r" class="form-input" id="rf_partner" placeholder="取引先名" value="${r?.partner||''}">
        <datalist id="partnerList_r">${partnerOptions}</datalist>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">請求日 *</label>
          <input type="date" class="form-input" id="rf_invoiceDate" value="${r?.invoiceDate || todayStr}">
        </div>
        <div class="form-group">
          <label class="form-label">請求額 *</label>
          <input type="number" class="form-input" id="rf_amount" placeholder="0" value="${r?.amount||''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">入金予定日 *</label>
          <input type="date" class="form-input" id="rf_dueDate" value="${r?.dueDate||''}">
        </div>
        <div class="form-group">
          <label class="form-label">入金口座</label>
          <select class="form-select" id="rf_account">${accountOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">メモ</label>
        <textarea class="form-textarea" id="rf_memo" rows="2">${r?.memo||''}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="saveReceivable(${editId?`'${editId}'`:'null'})">保存</button>
    </div>
  `);
}

function openReceivableConfirm(id) {
  const r = APP.receivables.find(x => x.id === id);
  if (!r) return;
  const remaining = Number(r.amount) - Number(r.paidAmount||0);
  const todayStr = toDateKey(today);
  const accountOptions = APP.accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');

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
  const partner = document.getElementById('rf_partner').value;
  const invoiceDate = document.getElementById('rf_invoiceDate').value;
  const amount = Number(document.getElementById('rf_amount').value);
  const dueDate = document.getElementById('rf_dueDate').value;
  const account = document.getElementById('rf_account').value;
  const memo = document.getElementById('rf_memo').value;

  if (!partner || !invoiceDate || !amount || !dueDate) {
    showToast('必須項目を入力してください', 'error');
    return;
  }

  const cfId = editId ? (APP.receivables.find(x=>x.id===editId)?.cfId || genId()) : genId();
  const data = {
    id: editId || genId(),
    partner, invoiceDate, amount, dueDate, memo,
    paidAmount: editId ? (APP.receivables.find(x=>x.id===editId)?.paidAmount || 0) : 0,
    status: editId ? (APP.receivables.find(x=>x.id===editId)?.status || '未回収') : '未回収',
    cfId,
    updatedAt: new Date().toISOString(),
    createdAt: editId ? (APP.receivables.find(x=>x.id===editId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
  };

  // 対応する日繰りデータも作成/更新
  const cfData = {
    id: cfId, source: 'receivable', sourceId: data.id,
    status: '予定', type: '入金', partner,
    description: '売掛回収予定', account,
    plannedDate: dueDate, plannedAmount: amount,
    actualDate: null, actualAmount: null,
    memo, createdAt: data.createdAt, updatedAt: new Date().toISOString(),
  };

  try {
    await Promise.all([
      gasPost('saveReceivable', data),
      gasPost('saveTransaction', cfData),
    ]);
    closeModal();
    showToast(editId ? '更新しました' : '売掛を追加しました', 'success');
    await loadReceivables();
    APP.currentMonthData = []; // 日繰りキャッシュクリア
  } catch(e) {}
}

async function confirmReceivable(id) {
  const r = APP.receivables.find(x => x.id === id);
  if (!r) return;
  const date = document.getElementById('rc_date').value;
  const amount = Number(document.getElementById('rc_amount').value);
  const account = document.getElementById('rc_account').value;

  if (!date || !amount) {
    showToast('入金日と入金額は必須です', 'error');
    return;
  }

  const newPaid = Number(r.paidAmount || 0) + amount;
  const newStatus = newPaid >= Number(r.amount) ? '回収済' : '一部入金';

  // 日繰りデータも実績確定
  const cfTx = APP.currentMonthData.find(x => x.id === r.cfId) || { id: r.cfId };

  try {
    await Promise.all([
      gasPost('saveReceivable', { ...r, paidAmount: newPaid, status: newStatus, updatedAt: new Date().toISOString() }),
      gasPost('saveTransaction', { ...cfTx, actualDate: date, actualAmount: amount, status: newStatus === '回収済' ? '確定' : '一部確定', account, updatedAt: new Date().toISOString() }),
    ]);
    closeModal();
    showToast('入金を確定しました', 'success');
    await loadReceivables();
    APP.currentMonthData = [];
  } catch(e) {}
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
    .filter(p => p.status !== '支払済')
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
  if (payableFilter === 'overdue') data = data.filter(p => calcDelay(p.dueDate) > 0 && p.status !== '支払済');
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
    const actualStatus = delay > 0 && p.status !== '支払済' ? '遅延' : p.status;
    const statusMap = { '未払': 'badge-blue', '支払済': 'badge-green', '一部支払': 'badge-amber', '遅延': 'badge-red' };
    const statusClass = statusMap[actualStatus] || 'badge-gray';

    return `
      <div class="list-row" onclick="openPayableDetail('${p.id}')">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-weight:700;font-size:14px">${p.partner}</span>
            <span class="badge ${statusClass}">${actualStatus}</span>
            ${delay > 0 && p.status !== '支払済' ? `<span class="badge badge-red">遅延${delay}日</span>` : ''}
          </div>
          <div style="display:flex;gap:12px;font-size:11px;color:var(--text-muted)">
            <span>発生日: ${fmtDateShort(p.occDate)}</span>
            <span>支払予定: ${fmtDateShort(p.dueDate)}</span>
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
        <span class="badge ${delay>0&&p.status!=='支払済'?'badge-red':'badge-blue'}">${delay>0&&p.status!=='支払済'?'遅延'+delay+'日':p.status}</span>
      </div>
      <div class="detail-row"><span class="detail-label">取引先</span><span class="detail-value">${p.partner}</span></div>
      <div class="detail-row"><span class="detail-label">発生日</span><span class="detail-value">${fmtDate(p.occDate)}</span></div>
      <div class="detail-row"><span class="detail-label">支払予定額</span><span class="detail-value amount expense">${fmtMoney(p.amount)}</span></div>
      <div class="detail-row"><span class="detail-label">支払予定日</span><span class="detail-value">${fmtDate(p.dueDate)}</span></div>
      <div class="detail-row"><span class="detail-label">支払済額</span><span class="detail-value">${fmtMoney(p.paidAmount||0)}</span></div>
      <div class="detail-row"><span class="detail-label">未払額</span><span class="detail-value amount ${remaining>0?'expense':'income'}">${fmtMoney(remaining)}</span></div>
      ${p.memo ? `<div style="margin-top:12px;padding:10px;background:var(--surface-2);border-radius:8px;font-size:13px">${p.memo}</div>` : ''}
      ${p.cfId ? `
      <div style="margin-top:12px">
        <button class="btn btn-outline w-full btn-sm" onclick="closeModal();navigate('cashflow');setTimeout(()=>openTransactionDetail('${p.cfId}'),500)">
          → 対応する日繰り明細を見る
        </button>
      </div>` : ''}
    </div>
    <div class="modal-footer" style="flex-wrap:wrap">
      <button class="btn btn-outline btn-sm" onclick="closeModal();openPayableForm('${id}')">編集</button>
      ${remaining > 0 ? `<button class="btn btn-danger btn-sm" onclick="closeModal();openPayableConfirm('${id}')">支払確定</button>` : ''}
      <button class="btn btn-danger btn-sm" onclick="deletePayable('${id}')">削除</button>
    </div>
  `);
}

function openPayableForm(editId) {
  const p = editId ? APP.payables.find(x => x.id === editId) : null;
  const todayStr = toDateKey(today);
  const partnerOptions = APP.partners.map(pt =>
    `<option value="${pt.name}" ${p?.partner===pt.name?'selected':''}>${pt.name}</option>`).join('');
  const accountOptions = APP.accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${p ? '買掛を編集' : '買掛を追加'}</div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">取引先 *</label>
        <input list="partnerList_p" class="form-input" id="pf_partner" placeholder="取引先名" value="${p?.partner||''}">
        <datalist id="partnerList_p">${partnerOptions}</datalist>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">発生日 *</label>
          <input type="date" class="form-input" id="pf_occDate" value="${p?.occDate || todayStr}">
        </div>
        <div class="form-group">
          <label class="form-label">支払予定額 *</label>
          <input type="number" class="form-input" id="pf_amount" placeholder="0" value="${p?.amount||''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">支払予定日 *</label>
          <input type="date" class="form-input" id="pf_dueDate" value="${p?.dueDate||''}">
        </div>
        <div class="form-group">
          <label class="form-label">支払口座</label>
          <select class="form-select" id="pf_account">${accountOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">メモ</label>
        <textarea class="form-textarea" id="pf_memo" rows="2">${p?.memo||''}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="savePayable(${editId?`'${editId}'`:'null'})">保存</button>
    </div>
  `);
}

function openPayableConfirm(id) {
  const p = APP.payables.find(x => x.id === id);
  if (!p) return;
  const remaining = Number(p.amount) - Number(p.paidAmount||0);
  const todayStr = toDateKey(today);
  const accountOptions = APP.accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');

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
  const partner = document.getElementById('pf_partner').value;
  const occDate = document.getElementById('pf_occDate').value;
  const amount = Number(document.getElementById('pf_amount').value);
  const dueDate = document.getElementById('pf_dueDate').value;
  const account = document.getElementById('pf_account').value;
  const memo = document.getElementById('pf_memo').value;

  if (!partner || !occDate || !amount || !dueDate) {
    showToast('必須項目を入力してください', 'error');
    return;
  }

  const cfId = editId ? (APP.payables.find(x=>x.id===editId)?.cfId || genId()) : genId();
  const data = {
    id: editId || genId(),
    partner, occDate, amount, dueDate, memo,
    paidAmount: editId ? (APP.payables.find(x=>x.id===editId)?.paidAmount || 0) : 0,
    status: editId ? (APP.payables.find(x=>x.id===editId)?.status || '未払') : '未払',
    cfId,
    updatedAt: new Date().toISOString(),
    createdAt: editId ? (APP.payables.find(x=>x.id===editId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
  };

  const cfData = {
    id: cfId, source: 'payable', sourceId: data.id,
    status: '予定', type: '出金', partner,
    description: '買掛支払予定', account,
    plannedDate: dueDate, plannedAmount: amount,
    actualDate: null, actualAmount: null,
    memo, createdAt: data.createdAt, updatedAt: new Date().toISOString(),
  };

  try {
    await Promise.all([
      gasPost('savePayable', data),
      gasPost('saveTransaction', cfData),
    ]);
    closeModal();
    showToast(editId ? '更新しました' : '買掛を追加しました', 'success');
    await loadPayables();
    APP.currentMonthData = [];
  } catch(e) {}
}

async function confirmPayable(id) {
  const p = APP.payables.find(x => x.id === id);
  if (!p) return;
  const date = document.getElementById('pc_date').value;
  const amount = Number(document.getElementById('pc_amount').value);
  const account = document.getElementById('pc_account').value;

  if (!date || !amount) {
    showToast('支払日と支払額は必須です', 'error');
    return;
  }

  const newPaid = Number(p.paidAmount||0) + amount;
  const newStatus = newPaid >= Number(p.amount) ? '支払済' : '一部支払';

  const cfTx = APP.currentMonthData.find(x => x.id === p.cfId) || { id: p.cfId };

  try {
    await Promise.all([
      gasPost('savePayable', { ...p, paidAmount: newPaid, status: newStatus, updatedAt: new Date().toISOString() }),
      gasPost('saveTransaction', { ...cfTx, actualDate: date, actualAmount: amount, status: newStatus === '支払済' ? '確定' : '一部確定', account, updatedAt: new Date().toISOString() }),
    ]);
    closeModal();
    showToast('支払を確定しました', 'success');
    await loadPayables();
    APP.currentMonthData = [];
  } catch(e) {}
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
        <div style="font-weight:700;font-size:15px">${a.name}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${a.bank || ''} ${a.type || ''}</div>
      </div>
      <div style="text-align:right">
        <div class="amount balance">${fmtMoney(a.balance)}</div>
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
        <label class="form-label">口座名 *</label>
        <input class="form-input" id="af_name" placeholder="例：メイン口座" value="${a?.name||''}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">銀行名</label>
          <input class="form-input" id="af_bank" placeholder="〇〇銀行" value="${a?.bank||''}">
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
        <label class="form-label">現在残高（本日時点の実績残高）</label>
        <input type="number" class="form-input" id="af_balance" placeholder="0" value="${a?.balance||0}">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">日繰り表の月初残高はこの値から自動で逆算されます</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" onclick="saveAccount(${editId?`'${editId}'`:'null'})">保存</button>
    </div>
  `);
}

async function saveAccount(editId) {
  const name = document.getElementById('af_name').value.trim();
  if (!name) { showToast('口座名は必須です', 'error'); return; }

  const data = {
    id: editId || genId(),
    name,
    bank: document.getElementById('af_bank').value,
    type: document.getElementById('af_type').value,
    balance: Number(document.getElementById('af_balance').value) || 0,
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
  document.getElementById('gasUrlInput').value = APP.gasUrl;
  document.getElementById('companyNameInput').value = APP.companyName;
  Promise.all([loadMasterData(), loadFixedExpenses()]).then(() => {
    renderPartnerList();
  });
}

function saveGasUrl() {
  const url = document.getElementById('gasUrlInput').value.trim();
  APP.gasUrl = url;
  localStorage.setItem('gasUrl', url);
  if (url) {
    // 接続テスト
    gasApi('testConnection').then(res => {
      document.getElementById('connectionStatus').innerHTML =
        `<div class="alert-banner alert-blue">✅ 接続成功：${res.message||'スプレッドシートに接続されました'}</div>`;
      // キャッシュクリアして再読込
      APP.accounts = [];
      loadMasterData();
    }).catch(() => {
      document.getElementById('connectionStatus').innerHTML =
        `<div class="alert-banner alert-red">❌ 接続失敗：URLを確認してください</div>`;
    });
  } else {
    document.getElementById('connectionStatus').innerHTML =
      `<div class="alert-banner alert-amber">デモモードで動作します（スプレッドシートに保存されません）</div>`;
  }
  showToast('URLを保存しました', 'success');
}

function saveCompanyName() {
  const name = document.getElementById('companyNameInput').value.trim();
  APP.companyName = name;
  localStorage.setItem('companyName', name);
  document.getElementById('companyNameNav').textContent = name;
  showToast('会社名を保存しました', 'success');
}

function renderPartnerList() {
  const el = document.getElementById('partnerList');
  el.innerHTML = APP.partners.map(p => `
    <div class="list-row" style="padding:10px 16px">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600">${p.name}</div>
        <div style="font-size:11px;color:var(--text-muted)">${p.type||''}</div>
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
  const data = { id: genId(), name, type: document.getElementById('pt_type').value, createdAt: new Date().toISOString() };
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
  return account.name + (account.bank ? '（' + account.bank + '）' : '');
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
            <span>${escapeHtml(item.startMonth)}〜${escapeHtml(item.endMonth)}</span>
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
    const label = account.name + (account.bank ? '（' + account.bank + '）' : '');
    return `<option value="${account.id}" ${item?.account === account.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${item ? '固定支出を編集' : '固定支出を追加'}</div>
    <div class="modal-body">
      <div class="alert-banner alert-blue" style="margin-bottom:16px">
        保存すると対象期間の資金繰り予定へ自動反映します。確定済み実績は変更しません。
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
          <input type="month" class="form-input" id="fe_startMonth" value="${item?.startMonth || startDefault}">
        </div>
        <div class="form-group">
          <label class="form-label">終了月 *</label>
          <input type="month" class="form-input" id="fe_endMonth" value="${item?.endMonth || endDefault}">
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
    id: editId || genId(),
    name: document.getElementById('fe_name').value.trim(),
    payee: document.getElementById('fe_payee').value.trim(),
    amount: Number(document.getElementById('fe_amount').value),
    day: Number(document.getElementById('fe_day').value),
    startMonth: document.getElementById('fe_startMonth').value,
    endMonth: document.getElementById('fe_endMonth').value,
    account: document.getElementById('fe_account').value,
    holidayRule: document.getElementById('fe_holidayRule').value,
    memo: document.getElementById('fe_memo').value.trim(),
    scope: editId ? document.getElementById('fe_scope').value : 'all',
    createdAt: existing?.createdAt || new Date().toISOString()
  };

  if (!data.name || !data.payee || !(data.amount > 0) || !(data.day >= 1 && data.day <= 31) ||
      !data.startMonth || !data.endMonth || !data.account) {
    showToast('必須項目を確認してください', 'error');
    return;
  }
  if (data.startMonth > data.endMonth) {
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
document.addEventListener('DOMContentLoaded', () => {
  // 会社名をナビに表示
  document.getElementById('companyNameNav').textContent = APP.companyName;

  // 初期ページ（GAS未設定ならまず設定画面へのヒントを出す）
  navigate('home');

  if (!APP.gasUrl) {
    setTimeout(() => {
      showToast('設定画面でGAS URLを設定してください', 'default');
    }, 1000);
  }
});
