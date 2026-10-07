const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('./helpers.cjs');
const debt = (kind, id = 'd') => ({ action: kind === 'receivable' ? 'saveReceivable' : 'savePayable', id,
  partner: '合成取引先', invoiceDate: '2026-09-01', occDate: '2026-09-01', amount: 100, dueDate: '2026-09-30', account: 'a', memo: '合成メモ' });
const table = kind => kind === 'receivable' ? 'receivables' : 'payables';
const payment = (b, kind, amount, paymentId, date = '2026-09-15', account = 'a') => ({
  action: kind === 'receivable' ? 'confirmReceivable' : 'confirmPayable', id: 'd', amount, paymentId, date, account,
  expectedUpdatedAt: b.records(table(kind))[0].updatedAt
});

for (const kind of ['receivable', 'payable']) {
  test(kind + ': save and schedule commit once; API does not trust paidAmount', () => {
    const b = createBackend(), before = b.batchCount;
    assert.equal(b.post({ ...debt(kind), paidAmount: 100, status: '回収済', cfId: 'forged' }).success, true);
    assert.equal(b.batchCount, before + 1);
    assert.equal(b.records(table(kind))[0].paidAmount, 0);
    const t = b.records('cashflow_transactions')[0];
    assert.equal(t.id, 'cf_d'); assert.equal(t.plannedAmount, 100); assert.equal(t.account, 'a');
  });
  test(kind + ': storage failure leaves neither half of the save', () => {
    const b = createBackend(), before = b.snapshot(); b.failNext();
    assert.match(b.post(debt(kind)).error, /storage failure/);
    assert.deepEqual(b.snapshot(), before); assert.equal(b.locked, false);
    assert.equal(b.post(debt(kind)).success, true);
  });
  test(kind + ': split payments on separate dates/accounts retain history and remaining plan', () => {
    const b = createBackend(); b.post(debt(kind));
    assert.equal(b.post(payment(b, kind, 40, 'first', '2026-09-10', 'a')).success, true);
    assert.equal(b.records('cashflow_transactions').find(t => t.id === 'cf_d').plannedAmount, 60);
    assert.equal(b.post(payment(b, kind, 60, 'second', '2026-09-15', 'b')).success, true);
    const rows = b.records('cashflow_transactions');
    assert.equal(rows.length, 3); assert.equal(rows.find(t => t.id === 'cf_d').status, '完了');
    assert.deepEqual(rows.filter(t => t.source.endsWith('_payment')).map(t => [t.actualDate, t.actualAmount, t.account]), [['2026-09-10', 40, 'a'], ['2026-09-15', 60, 'b']]);
    assert.equal(b.records(table(kind))[0].paidAmount, 100);
  });
  test(kind + ': retry after lost response cannot duplicate a payment', () => {
    const b = createBackend(); b.post(debt(kind)); const p = payment(b, kind, 40, 'retry');
    b.loseNextResponse(); assert.match(b.post(p).error, /lost response/);
    assert.equal(b.post(p).duplicate, true);
    assert.equal(b.records(table(kind))[0].paidAmount, 40);
    assert.match(b.post({ ...p, amount: 50 }).error, /同じ決済ID/);
  });
  test(kind + ': payment failure preserves original debt and plan', () => {
    const b = createBackend(); b.post(debt(kind)); const before = b.snapshot(); b.failNext();
    assert.match(b.post(payment(b, kind, 40, 'failed')).error, /storage failure/);
    assert.deepEqual(b.snapshot(), before);
  });
  test(kind + ': stale edit, excess payment and future actual are rejected', () => {
    const b = createBackend(); b.post(debt(kind));
    assert.match(b.post(debt(kind)).error, /更新/);
    assert.match(b.post(payment(b, kind, 101, 'excess')).error, /残額/);
    assert.match(b.post(payment(b, kind, 10, 'future', '2026-09-18')).error, /今日以前/);
    assert.equal(b.records('cashflow_transactions').length, 1);
  });
  test(kind + ': deleting unpaid debt deletes its linked schedule; paid debt is protected', () => {
    const b = createBackend(); b.post(debt(kind));
    let d = b.records(table(kind))[0];
    b.failNext(); assert.ok(b.post({ action: 'deleteRecord', sheet: table(kind), id: 'd', expectedUpdatedAt: d.updatedAt }).error);
    assert.equal(b.records('cashflow_transactions').length, 1);
    assert.equal(b.post({ action: 'deleteRecord', sheet: table(kind), id: 'd', expectedUpdatedAt: d.updatedAt }).success, true);
    assert.equal(b.records('cashflow_transactions').length, 0);
    b.post(debt(kind)); b.post(payment(b, kind, 40, 'paid'));
    d = b.records(table(kind))[0];
    assert.match(b.post({ action: 'deleteRecord', sheet: table(kind), id: 'd', expectedUpdatedAt: d.updatedAt }).error, /実績/);
  });
  test(kind + ': editing partially paid debt preserves payment and prevents lowering below paid amount', () => {
    const b = createBackend(); b.post(debt(kind)); b.post(payment(b, kind, 40, 'paid'));
    const before = b.records('cashflow_transactions').find(t => t.id === 'pay_paid');
    const version = b.records(table(kind))[0].updatedAt;
    assert.match(b.post({ ...debt(kind), amount: 30, expectedUpdatedAt: version }).error, /確定済み/);
    assert.equal(b.post({ ...debt(kind), amount: 120, dueDate: '2026-10-01', expectedUpdatedAt: version }).success, true);
    assert.deepEqual(b.records('cashflow_transactions').find(t => t.id === 'pay_paid'), before);
    assert.equal(b.records('cashflow_transactions').find(t => t.id === 'cf_d').plannedAmount, 80);
  });
}

test('partial internal updates preserve untouched columns; public confirmations preserve source data', () => {
  const b = createBackend();
  b.post({ action: 'saveTransaction', id: 'm', type: '出金', account: 'a', plannedDate: '2026-09-01', plannedAmount: 40, partner: '合成', memo: 'keep' });
  const old = b.records('cashflow_transactions')[0];
  assert.equal(b.post({ action: 'saveTransaction', id: 'm', actualDate: '2026-09-02', actualAmount: 0, status: '確定', expectedUpdatedAt: old.updatedAt }).success, true);
  const now = b.records('cashflow_transactions')[0];
  assert.equal(now.memo, 'keep'); assert.equal(now.source, 'manual'); assert.equal(now.plannedAmount, 40); assert.equal(now.actualAmount, 0);
  assert.match(b.post({ action: 'saveTransaction', id: 'm', status: '予定', expectedUpdatedAt: now.updatedAt }).error, /確定済み/);
});
test('unknown tables, invalid dates, nonfinite/negative amounts and referenced account deletion are rejected', () => {
  const b = createBackend();
  assert.ok(b.post({ action: 'deleteRecord', sheet: 'unknown', id: 'a' }).error);
  assert.ok(b.post({ ...debt('receivable'), dueDate: '2026-02-30' }).error);
  assert.ok(b.post({ ...debt('receivable'), amount: -10 }).error);
  assert.ok(b.post({ ...debt('receivable'), amount: 'Infinity' }).error);
  b.post(debt('receivable'));
  assert.match(b.post({ action: 'deleteRecord', sheet: 'accounts', id: 'a', expectedUpdatedAt: b.records('accounts')[0].updatedAt }).error, /使用中/);
});
test('formula-like text is written as literal text', () => {
  const b = createBackend(); b.post({ ...debt('receivable'), partner: '=1+1' });
  assert.ok(JSON.stringify(b.lastRequests).includes('"stringValue":"=1+1"'));
  assert.ok(!JSON.stringify(b.lastRequests).includes('formulaValue'));
});
test('fixed expense master and generated plans are atomic; confirmed history survives editing', () => {
  const b = createBackend();
  const input = { action: 'saveFixedExpense', id: 'fx', name: '合成定期費用', payee: '合成先', amount: 30, day: 31,
    startMonth: '2026-05', endMonth: '2026-09', account: 'a', holidayRule: 'next', scope: 'all' };
  const before = b.snapshot(); b.failNext(); assert.ok(b.post(input).error); assert.deepEqual(b.snapshot(), before);
  assert.equal(b.post(input).success, true);
  const transaction = b.records('cashflow_transactions').find(t => t.id === 'fx_fx_202605');
  assert.equal(transaction.plannedDate, '2026-06-01');
  assert.equal(b.post({ action: 'saveTransaction', id: transaction.id, actualDate: '2026-06-01', actualAmount: 30, status: '確定', expectedUpdatedAt: transaction.updatedAt }).success, true);
  assert.equal(b.post({ ...input, amount: 50, expectedUpdatedAt: b.records('fixed_expenses')[0].updatedAt }).success, true);
  assert.equal(b.records('cashflow_transactions').find(t => t.id === transaction.id).actualAmount, 30);
  assert.equal(b.records('cashflow_transactions').length, 5);
});
test('GET connection checks storage and full transaction read is side-effect free', () => {
  const b = createBackend(); b.post(debt('receivable')); const count = b.batchCount;
  assert.equal(b.get('testConnection').success, true);
  assert.equal(b.get('getTransactions', { all: 'true' }).data.length, 1);
  assert.equal(b.batchCount, count);
});
