/**
 * 固定支出マスタと資金繰り予定の同期
 *
 * 生成取引IDを「固定支出ID＋対象月」で固定し、再実行時はupsertする。
 * 確定実績がある生成取引は、マスタ編集・削除から保護する。
 */

const FIXED_EXPENSE_SOURCE = 'fixed_expense';

/** 固定支出を保存し、対象期間の予定を同期する */
function saveFixedExpense(data) {
  const normalized = normalizeFixedExpense(data);
  const validationError = validateFixedExpense(normalized);
  if (validationError) return { error: validationError };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existing = getFixedExpenseById(normalized.id);
    const now = new Date().toISOString();
    normalized.createdAt = existing && existing.createdAt ? existing.createdAt : (data.createdAt || now);
    normalized.updatedAt = now;
    normalized.active = true;

    saveRecord(SHEETS.FIXED_EXPENSES, normalized);

    const scope = data.scope === 'all' ? 'all' : 'future';
    const removed = removeGeneratedFixedExpenseTransactions(normalized.id, scope);
    const generated = generateFixedExpenseTransactions(normalized, scope);

    return {
      success: true,
      id: normalized.id,
      generated: generated.generated,
      updated: generated.updated,
      protected: removed.protected + generated.protected,
      removed: removed.removed
    };
  } finally {
    lock.releaseLock();
  }
}

/** 固定支出マスタと未確定の生成予定を削除する */
function deleteFixedExpense(id, scope) {
  if (!id) return { error: '固定支出IDがありません' };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const removed = removeGeneratedFixedExpenseTransactions(id, scope === 'all' ? 'all' : 'future');
    const masterResult = deleteRecord(SHEETS.FIXED_EXPENSES, id);
    if (masterResult.error && masterResult.error.indexOf('Record not found') !== 0) {
      return masterResult;
    }
    return {
      success: true,
      id: id,
      removed: removed.removed,
      protected: removed.protected
    };
  } finally {
    lock.releaseLock();
  }
}

/** 月表示時の自己修復用。該当月の固定支出予定がなければ生成する。 */
function ensureFixedExpenseTransactionsForMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return;

  const masters = getAllRecords(SHEETS.FIXED_EXPENSES).data || [];
  masters.forEach(master => {
    if (master.active === false || String(master.active).toLowerCase() === 'false') return;
    if (month < master.startMonth || month > master.endMonth) return;
    const transaction = buildFixedExpenseTransaction(master, month);
    if (!getTransactionById(transaction.id)) saveRecord(SHEETS.TRANSACTIONS, transaction);
  });
}

/** マスタの期間内に予定を生成 */
function generateFixedExpenseTransactions(master, scope) {
  const result = { generated: 0, updated: 0, protected: 0 };
  const todayKey = getTodayKey();

  enumerateMonths(master.startMonth, master.endMonth).forEach(month => {
    const transaction = buildFixedExpenseTransaction(master, month);
    if (scope === 'future' && transaction.plannedDate < todayKey) return;

    const upsertResult = upsertFixedExpenseTransaction(master, month);
    result[upsertResult] += 1;
  });

  return result;
}

/** 1か月分を重複なくupsert */
function upsertFixedExpenseTransaction(master, month) {
  const transaction = buildFixedExpenseTransaction(master, month);
  const existing = getTransactionById(transaction.id);

  if (existing && hasActualResult(existing)) return 'protected';
  if (existing && existing.createdAt) transaction.createdAt = existing.createdAt;

  saveRecord(SHEETS.TRANSACTIONS, transaction);
  return existing ? 'updated' : 'generated';
}

/** 固定支出から資金繰り予定を組み立てる */
function buildFixedExpenseTransaction(master, month) {
  const parts = month.split('-').map(Number);
  const baseDate = createClampedDate(parts[0], parts[1], Number(master.day));
  const adjustedDate = adjustToBusinessDay(baseDate, master.holidayRule || 'none');
  const now = new Date().toISOString();

  return {
    id: fixedExpenseTransactionId(master.id, month),
    source: FIXED_EXPENSE_SOURCE,
    sourceId: master.id,
    status: '予定',
    type: '出金',
    partner: master.payee || '',
    description: '【固定支出】' + master.name,
    account: master.account,
    plannedDate: formatDateKey(adjustedDate),
    plannedAmount: Number(master.amount),
    actualDate: null,
    actualAmount: null,
    memo: '[固定支出マスタ自動生成]' + (master.memo ? ' ' + master.memo : ''),
    createdAt: now,
    updatedAt: now
  };
}

/** 自動生成取引のID。マスタ×月で常に同一になる。 */
function fixedExpenseTransactionId(masterId, month) {
  return 'fx_' + masterId + '_' + month.replace('-', '');
}

/** 指定範囲の未確定生成予定を削除。確定実績は保護する。 */
function removeGeneratedFixedExpenseTransactions(masterId, scope) {
  const sheet = getOrCreateSheet(SHEETS.TRANSACTIONS);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { removed: 0, protected: 0 };

  const headers = values[0];
  const sourceIdx = headers.indexOf('source');
  const sourceIdIdx = headers.indexOf('sourceId');
  const plannedDateIdx = headers.indexOf('plannedDate');
  const actualDateIdx = headers.indexOf('actualDate');
  const actualAmountIdx = headers.indexOf('actualAmount');
  const todayKey = getTodayKey();
  let removed = 0;
  let protectedCount = 0;

  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    if (String(row[sourceIdx]) !== FIXED_EXPENSE_SOURCE || String(row[sourceIdIdx]) !== String(masterId)) continue;

    const hasActual = !!row[actualDateIdx] || row[actualAmountIdx] !== '' && row[actualAmountIdx] !== null;
    if (hasActual) {
      protectedCount += 1;
      continue;
    }

    const plannedDate = sheetValueToDateKey(row[plannedDateIdx]);
    if (scope === 'future' && plannedDate < todayKey) continue;

    sheet.deleteRow(i + 1);
    removed += 1;
  }

  return { removed: removed, protected: protectedCount };
}

function normalizeFixedExpense(data) {
  return {
    id: String(data.id || ('fe_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16))),
    name: String(data.name || '').trim(),
    payee: String(data.payee || '').trim(),
    amount: Number(data.amount),
    day: Number(data.day),
    startMonth: String(data.startMonth || ''),
    endMonth: String(data.endMonth || ''),
    account: String(data.account || ''),
    holidayRule: ['next', 'previous', 'none'].indexOf(data.holidayRule) >= 0 ? data.holidayRule : 'none',
    memo: String(data.memo || '').trim(),
    active: true,
    createdAt: data.createdAt || '',
    updatedAt: data.updatedAt || ''
  };
}

function validateFixedExpense(data) {
  if (!data.name) return '支出名は必須です';
  if (!data.payee) return '支払先は必須です';
  if (!(data.amount > 0)) return '金額は1円以上で入力してください';
  if (!(data.day >= 1 && data.day <= 31)) return '基本引き落とし日は1〜31で入力してください';
  if (!/^\d{4}-\d{2}$/.test(data.startMonth) || !/^\d{4}-\d{2}$/.test(data.endMonth)) {
    return '開始月と終了月を入力してください';
  }
  if (data.startMonth > data.endMonth) return '終了月は開始月以降にしてください';
  if (!data.account) return '支払口座を選択してください';
  if (enumerateMonths(data.startMonth, data.endMonth).length > 60) return '登録期間は最大60か月です';
  return '';
}

function getFixedExpenseById(id) {
  const records = getAllRecords(SHEETS.FIXED_EXPENSES).data || [];
  return records.find(record => String(record.id) === String(id)) || null;
}

function getTransactionById(id) {
  const records = getAllRecords(SHEETS.TRANSACTIONS).data || [];
  return records.find(record => String(record.id) === String(id)) || null;
}

function hasActualResult(transaction) {
  return !!transaction.actualDate ||
    transaction.actualAmount !== null &&
    transaction.actualAmount !== undefined &&
    transaction.actualAmount !== '';
}

function enumerateMonths(startMonth, endMonth) {
  if (!/^\d{4}-\d{2}$/.test(startMonth) || !/^\d{4}-\d{2}$/.test(endMonth)) return [];

  const start = startMonth.split('-').map(Number);
  const end = endMonth.split('-').map(Number);
  const months = [];
  let cursor = new Date(start[0], start[1] - 1, 1);
  const last = new Date(end[0], end[1] - 1, 1);

  while (cursor <= last && months.length <= 60) {
    months.push(cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0'));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function getTodayKey() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function sheetValueToDateKey(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(value || '').slice(0, 10);
}
