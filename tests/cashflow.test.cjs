const { test } = require('node:test');
const assert = require('node:assert/strict');
const math = require('../assets/cashflow-math.js');
const { createFrontend, clone } = require('./helpers.cjs');
const { createBackend } = require('./sqlite-helpers.cjs');
const account = { id: 'a', bank: '合成銀行', balance: 1000, balanceDate: '2026-08-31' };
const actual = (id, date, amount, type = '入金', extra = {}) => ({ id, source: 'manual', account: 'a', type, status: '確定', plannedDate: date, plannedAmount: amount, actualDate: date, actualAmount: amount, ...extra });
const plan = (id, date, amount, type = '出金', extra = {}) => ({ id, source: 'manual', account: 'a', type, status: '予定', plannedDate: date, plannedAmount: amount, ...extra });
const rows = [actual('spent', '2026-09-05', 100, '出金'), actual('received', '2026-09-10', 200),
  plan('today', '2026-09-17', 50), plan('eom', '2026-09-30', 400, '入金'), plan('next', '2026-10-05', 300)];

test('30-day forecast includes next month and today outstanding; actual is not counted twice', () => {
  assert.equal(math.actualAt(account, rows, '2026-09-17'), 1100);
  assert.equal(math.balanceAt(account, rows, '2026-09-30', 'predict', '2026-09-17'), 1450);
  assert.equal(math.balanceAt(account, rows, '2026-10-17', 'predict', '2026-09-17'), 1150);
});
test('future month opening includes earlier future movements; actual mode excludes plans', () => {
  assert.equal(math.opening([account], rows, '2026-10', 'predict', '2026-09-17').a, 1450);
  assert.equal(math.opening([account], rows, '2026-10', 'actual', '2026-09-17').a, 1100);
});
test('past month opening reconstructs all intervening months', () => {
  const a = { ...account, balanceDate: '2026-09-17', balance: 1100 };
  const data = [...rows, actual('august', '2026-08-20', 100)];
  assert.equal(math.opening([a], data, '2026-08', 'actual', '2026-09-17').a, 900);
});
test('zero actual is an actual value, not the planned amount', () => {
  const zero = actual('zero', '2026-09-10', 0, '出金', { plannedAmount: 999 });
  assert.equal(math.hasActual(zero), true);
  assert.equal(math.balanceAt(account, [zero], '2026-09-30', 'predict', '2026-09-17'), 1000);
  assert.equal(math.rows([zero], ['a'], '2026-09', 'actual', '2026-09-17')[0].cashAmount, 0);
});
test('planned and actual month mismatch appears only in the actual month', () => {
  const data = [actual('cross', '2026-10-01', 100, '入金', { plannedDate: '2026-09-30' })];
  assert.equal(math.rows(data, ['a'], '2026-09', 'predict', '2026-10-17').length, 0);
  assert.equal(math.rows(data, ['a'], '2026-10', 'predict', '2026-10-17').length, 1);
});
test('overdue outstanding stays on original date and is excluded from base forecast', () => {
  const data = [plan('overdue', '2026-08-20', 100), plan('cancel', '2026-09-20', 100, '入金', { status: '取消' }), plan('done', '2026-09-20', 100, '入金', { status: '完了' })];
  assert.equal(math.balanceAt(account, data, '2026-09-30', 'predict', '2026-09-17'), 1000);
  assert.equal(math.rows(data, ['a'], '2026-09', 'predict', '2026-09-17').length, 0);
  assert.equal(math.rows(data, ['a'], '2026-08', 'predict', '2026-09-17')[0].cashDate, '2026-08-20');
});
test('missing balance date fails visibly instead of inventing an opening balance', () => {
  assert.throws(() => math.actualAt({ ...account, balanceDate: '' }, rows, '2026-09-17'), /残高基準日/);
});
test('separate account balances do not leak into selected account rows', () => {
  const b = { ...account, id: 'b', balance: 500 };
  const data = [...rows, actual('other', '2026-09-15', 200, '出金', { account: 'b' })];
  assert.equal(math.actualAt(b, data, '2026-09-17'), 300);
  assert.equal(math.rows(data, ['a'], '2026-09', 'actual', '2026-09-17').length, 2);
});

for (const mode of ['predict', 'actual', 'diff']) {
  test('screen and Excel share opening, rows and closing: ' + mode, () => {
    const f = createFrontend();
    f.app.accounts = [account]; f.app.currentMonthData = rows;
    f.app.currentMonth = '2026-09'; f.app.currentMode = mode;
    f.context.renderCashflowTable(); f.context.exportCashflowToExcel();
    const sheet = clone(f.captured.rows);
    assert.equal(sheet[1][6], 1000);
    const expected = mode === 'actual' ? 1100 : 1450;
    assert.equal(sheet.at(-1)[6], expected);
    assert.equal(f.node('monthCloseBalance').textContent, expected.toLocaleString('ja-JP') + '円');
    assert.equal((f.node('cashflowTableBody').innerHTML.match(/onclick="openTransactionDetail/g) || []).length, sheet.length - 3);
    assert.match(f.captured.filename, /\.xlsx$/);
  });
}

test('UI saves and confirms receivable without loading cashflow first', async () => {
  const b = createBackend(), f = createFrontend(b);
  for (const [id, value] of Object.entries({ rf_partner: '合成取引先', rf_invoiceDate: '2026-09-01', rf_amount: '100', rf_dueDate: '2026-09-30', rf_account: 'a', rf_memo: 'retain' })) f.node(id).value = value;
  await f.context.saveReceivable(null);
  assert.equal(b.records('receivables').length, 1);
  const debt = b.records('receivables')[0];
  assert.equal(f.app.currentMonthData.length, 0);
  f.node('activeModal').dataset = {};
  for (const [id, value] of Object.entries({ rc_date: '2026-09-15', rc_amount: '40', rc_account: 'b' })) f.node(id).value = value;
  await f.context.confirmReceivable(debt.id);
  const payment = b.records('cashflow_transactions').find(t => t.source === 'receivable_payment');
  assert.equal(payment.type, '入金'); assert.equal(payment.account, 'b'); assert.equal(payment.memo, 'retain');
  assert.equal(payment.actualAmount, 40); assert.equal(b.records('receivables')[0].paidAmount, 40);
});
test('UI loads all transactions for home and for next month', async () => {
  const b = createBackend(), f = createFrontend(b);
  for (const transaction of rows) {
    assert.equal(b.post({ action: 'saveTransaction', ...transaction }).success, true);
  }
  await f.context.loadHome();
  // Account B has an additional untouched synthetic balance of 2000.
  assert.equal(f.node('day30Forecast').textContent, '3,150円');
  f.app.currentMonth = '2026-10'; f.app.selectedAccountIds = ['a'];
  await f.context.loadCashflowMonth('2026-10');
  assert.equal(f.node('monthOpenBalance').textContent, '1,450円');
  assert.equal(f.node('monthCloseBalance').textContent, '1,150円');
});
test('unauthenticated writes are rejected instead of reporting false save success', async () => {
  const f = createFrontend();
  await assert.rejects(f.context.gasPost('saveAccount', { id: 'a' }), /ログイン/);
});
test('a second write cannot unlock an in-flight request', async () => {
  const f = createFrontend(); f.app.gasUrl = 'https://synthetic.invalid/api';
  f.app.csrf='synthetic-csrf';
  let complete;
  f.context.fetch = () => new Promise(resolve => { complete = resolve; });
  const first = f.context.gasPost('saveAccount', { id: 'a' });
  await assert.rejects(f.context.gasPost('saveAccount', { id: 'b' }), /保存中/);
  assert.equal(f.app.writeBusy, true);
  complete({ ok: true, json: async () => ({ success: true }) }); await first;
  assert.equal(f.app.writeBusy, false);
});
