// Business operations. No SpreadsheetApp calls; reusable with a VPS storage adapter.
function findRecord(name, id) {
  return getAllRecords(name).data.find(row => row.id === id) || null;
}

function assertVersion(existing, data) {
  if (existing && String(existing.updatedAt || '') !== String(data.expectedUpdatedAt || '')) {
    throw new Error('他の操作で更新されています。画面を再読込してから操作してください');
  }
  if (!existing && data.expectedUpdatedAt) throw new Error('対象が削除されています。再読込してください');
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !isNaN(date) && date.toISOString().slice(0, 10) === value;
}

function requireMoney(value, allowZero) {
  if (value === null || value === undefined || value === '' || !Number.isSafeInteger(Number(value)) || Number(value) < (allowZero ? 0 : 1)) {
    throw new Error('金額は有効な整数円で入力してください');
  }
  return Number(value);
}

function requireAccount(id) {
  if (!findRecord(SHEETS.ACCOUNTS, id)) throw new Error('有効な口座を選択してください');
}

function debtConfig(kind) {
  if (kind === 'receivable') return { sheet: SHEETS.RECEIVABLES, type: '入金', date: 'invoiceDate', pending: '未回収', partial: '一部入金', done: '回収済', label: '売掛回収' };
  if (kind === 'payable') return { sheet: SHEETS.PAYABLES, type: '出金', date: 'occDate', pending: '未払', partial: '一部支払', done: '支払済', label: '買掛支払' };
  throw new Error('Invalid debt kind');
}

function syncDebtSchedule(kind, debt) {
  const config = debtConfig(kind);
  const remaining = Number(debt.amount) - Number(debt.paidAmount || 0);
  const previous = getTransactionById(debt.cfId);
  if (previous && (previous.source !== kind || previous.sourceId !== debt.id)) throw new Error('関連明細IDが重複しています');
  if (previous && hasActualResult(previous)) throw new Error('旧形式の実績があります。履歴の移行が必要です');
  saveRecord(SHEETS.TRANSACTIONS, {
    id: debt.cfId, source: kind, sourceId: debt.id, type: config.type,
    status: remaining === 0 ? '完了' : '予定', partner: debt.partner,
    description: config.label + '予定（未決済分）', account: debt.account,
    plannedDate: debt.dueDate, plannedAmount: remaining, actualDate: null, actualAmount: null, memo: debt.memo
  });
}

function saveDebt(kind, data) {
  const config = debtConfig(kind);
  const existing = findRecord(config.sheet, data.id);
  assertVersion(existing, data);
  const amount = requireMoney(data.amount, false);
  const paid = Number(existing?.paidAmount || 0);
  if (amount < paid) throw new Error('確定済み額より少ない請求・支払額には変更できません');
  if (!String(data.partner || '').trim() || !validDay(data[config.date]) || !validDay(data.dueDate)) throw new Error('取引先と有効な日付を入力してください');
  requireAccount(data.account);
  const debt = Object.assign({}, existing || {}, data, {
    amount, paidAmount: paid, cfId: existing?.cfId || ('cf_' + data.id),
    status: paid === amount ? config.done : paid ? config.partial : config.pending
  });
  const result = saveRecord(config.sheet, debt);
  syncDebtSchedule(kind, debt);
  return result;
}

function confirmDebt(kind, data) {
  const config = debtConfig(kind);
  const debt = findRecord(config.sheet, data.id);
  if (!debt) throw new Error('対象の売掛・買掛がありません');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(data.paymentId || ''))) throw new Error('決済IDが必要です');
  const paymentId = 'pay_' + data.paymentId;
  const previous = getTransactionById(paymentId);
  const amount = requireMoney(data.amount, false);
  if (!validDay(data.date) || data.date > getTodayKey()) throw new Error('実績日は今日以前の有効な日付にしてください');
  requireAccount(data.account);
  if (previous) {
    if (previous.source !== kind + '_payment' || previous.sourceId !== debt.id || previous.actualDate !== data.date || Number(previous.actualAmount) !== amount || previous.account !== data.account) {
      throw new Error('同じ決済IDで内容を変更して再送できません');
    }
    return { success: true, id: debt.id, duplicate: true };
  }
  assertVersion(debt, data);
  const paid = Number(debt.paidAmount || 0) + amount;
  if (paid > Number(debt.amount)) throw new Error('残額を超える入金・支払は登録できません');
  saveRecord(SHEETS.TRANSACTIONS, {
    id: paymentId, source: kind + '_payment', sourceId: debt.id,
    status: '確定', type: config.type, partner: debt.partner, description: config.label + '実績',
    account: data.account, plannedDate: null, plannedAmount: null,
    actualDate: data.date, actualAmount: amount, memo: debt.memo
  });
  const updated = Object.assign({}, debt, { paidAmount: paid, status: paid === Number(debt.amount) ? config.done : config.partial });
  const result = saveRecord(config.sheet, updated);
  syncDebtSchedule(kind, updated);
  return result;
}

function saveManualTransaction(data) {
  const previous = getTransactionById(data.id);
  assertVersion(previous, data);
  if (previous && ['manual', 'fixed_expense'].indexOf(previous.source) < 0) throw new Error('売掛・買掛の画面から操作してください');
  if (!previous && data.source && data.source !== 'manual') throw new Error('自動生成元は指定できません');
  const merged = Object.assign({}, previous || { source: 'manual', sourceId: '', status: '予定' }, data);
  if (previous) { merged.source = previous.source; merged.sourceId = previous.sourceId; }
  if (previous && hasActualResult(previous)) throw new Error('確定済み実績は編集・取消できません');
  if (previous?.source === 'fixed_expense' && ['account', 'plannedDate', 'plannedAmount', 'type'].some(key => merged[key] !== previous[key])) {
    throw new Error('固定支出の予定はマスタから変更してください');
  }
  if (['予定', '確定', '取消'].indexOf(merged.status) < 0) throw new Error('分割決済は売掛・買掛で登録してください');
  if (['入金', '出金'].indexOf(merged.type) < 0 || !validDay(merged.plannedDate)) throw new Error('区分と予定日を確認してください');
  merged.plannedAmount = requireMoney(merged.plannedAmount, true);
  requireAccount(merged.account);
  if (merged.status === '確定') {
    if (!validDay(merged.actualDate) || merged.actualDate > getTodayKey()) throw new Error('実績日は今日以前にしてください');
    merged.actualAmount = requireMoney(merged.actualAmount, true);
  } else {
    if (hasActualResult(merged)) throw new Error('実績がある取引は取消・予定化できません');
    merged.actualDate = null; merged.actualAmount = null;
  }
  return saveRecord(SHEETS.TRANSACTIONS, merged);
}

function saveAccountRecord(data) {
  const previous = findRecord(SHEETS.ACCOUNTS, data.id);
  assertVersion(previous, data);
  if (!String(data.name || '').trim() || !validDay(data.balanceDate) || data.balanceDate > getTodayKey()) throw new Error('口座名と今日以前の残高基準日を入力してください');
  if (data.balance === '' || data.balance == null || !Number.isSafeInteger(Number(data.balance))) throw new Error('残高は整数円で入力してください');
  return saveRecord(SHEETS.ACCOUNTS, Object.assign({}, data, { balance: Number(data.balance) }));
}

function deleteBusinessRecord(data) {
  const name = data.sheet;
  if ([SHEETS.TRANSACTIONS, SHEETS.RECEIVABLES, SHEETS.PAYABLES, SHEETS.ACCOUNTS, SHEETS.PARTNERS].indexOf(name) < 0) throw new Error('削除できない対象です');
  const previous = findRecord(name, data.id);
  if (!previous) return { success: true, alreadyDeleted: true };
  assertVersion(previous, data);
  const transactions = getAllRecords(SHEETS.TRANSACTIONS).data;
  if (name === SHEETS.RECEIVABLES || name === SHEETS.PAYABLES) {
    const kind = name === SHEETS.RECEIVABLES ? 'receivable' : 'payable';
    const linked = transactions.filter(t => t.sourceId === data.id && (t.source === kind || t.source === kind + '_payment'));
    if (Number(previous.paidAmount) || linked.some(hasActualResult)) throw new Error('決済実績のある売掛・買掛は削除できません');
    linked.forEach(t => deleteRecord(SHEETS.TRANSACTIONS, t.id));
  }
  if (name === SHEETS.TRANSACTIONS && (previous.source !== 'manual' || hasActualResult(previous))) throw new Error('自動生成明細・確定実績は直接削除できません');
  if (name === SHEETS.ACCOUNTS && (transactions.some(t => t.account === data.id) || getAllRecords(SHEETS.FIXED_EXPENSES).data.some(t => t.account === data.id))) throw new Error('取引で使用中の口座は削除できません');
  return deleteRecord(name, data.id);
}
