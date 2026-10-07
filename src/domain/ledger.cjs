'use strict';
const {randomUUID}=require('node:crypto');
const {SHEETS}=require('../contract.cjs');
const calendar=require('../../assets/cashflow-math.js');
module.exports=function createLedgerService(repository,{companyName=process.env.APP_COMPANY_NAME||'資金繰りシステム',today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}={}) {
const getAllRecords=name=>({data:repository.all(name)});
const saveRecord=(name,data)=>repository.save(name,data);
const deleteRecord=(name,id)=>repository.remove(name,id);
// Business operations. No SpreadsheetApp calls; reusable with a VPS storage adapter.
function findRecord(name, id) {
  return repository.find(name, id);
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
  const cancelled = !!repository.setting('pending_cancel_'+debt.cfId);
  if(cancelled && debt.status!=='取消') saveRecord(config.sheet,{...debt,status:'取消'});
  const previous = getTransactionById(debt.cfId);
  if (previous && (previous.source !== kind || previous.sourceId !== debt.id)) throw new Error('関連明細IDが重複しています');
  if (previous && hasActualResult(previous)) throw new Error('旧形式の実績があります。履歴の移行が必要です');
  saveRecord(SHEETS.TRANSACTIONS, {
    id: debt.cfId, source: kind, sourceId: debt.id, type: config.type,
    status: cancelled ? '取消' : remaining === 0 ? '完了' : '予定', partner: debt.partner,
    description: config.label + '予定（未決済分）', account: debt.account,
    plannedDate: debt.dueDate, plannedAmount: remaining, actualDate: null, actualAmount: null, memo: debt.memo
  });
}

function saveDebt(kind, data) {
  const config = debtConfig(kind);
  const existing = findRecord(config.sheet, data.id);
  if(existing && repository.setting('pending_cancel_'+existing.cfId)) throw Error('残予定を取消済みです。新しい予定として登録してください');
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
  if(repository.setting('pending_cancel_'+debt.cfId)) throw Error('残予定を取消済みです');
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
  if(!getTransactionById(data.id) && data.source==='fixed_expense') {
    const match=/^fx_(.+)_(\d{4})(\d{2})$/.exec(data.id);
    const master=match && getFixedExpenseById(match[1]);
    const month=match && match[2]+'-'+match[3];
    if(!master || master.active===false || month<master.startMonth || (master.endMonth && month>master.endMonth)) throw new Error('対象の固定支出予定がありません');
    calendar.months(month,month,1); assertVersion(master,data);
    saveRecord(SHEETS.TRANSACTIONS,buildFixedExpenseTransaction(master,month));
    data={...data,expectedUpdatedAt:getTransactionById(data.id).updatedAt};
  }
  const previous = getTransactionById(data.id);
  assertVersion(previous, data);
  if (previous && ['manual', 'fixed_expense'].indexOf(previous.source) < 0) throw new Error('売掛・買掛の画面から操作してください');
  if (!previous && data.source && data.source !== 'manual') throw new Error('自動生成元は指定できません');
  const merged = Object.assign({}, previous || { source: 'manual', sourceId: '', status: '予定' }, data);
  if (previous) { merged.source = previous.source; merged.sourceId = previous.sourceId; }
  if (previous && hasActualResult(previous)) throw new Error('確定済み実績は編集・取消できません');
  if (previous?.status === '取消' && corrections.tracked(previous.id)) throw new Error('取消済み実績は履歴として保護されています');
  if(previous?.status==='取消'&&repository.setting('pending_history_'+previous.id))throw Error('取消済み予定は履歴として保護されています');
  if(previous&&corrections.tracked(previous.id)&&['type','account','partner','description','plannedDate','plannedAmount','memo'].some(k=>(merged[k]??'')!==(previous[k]??'')))throw new Error('実績履歴のある元予定は保持します。再確定後に実績訂正を使用してください');
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
  const result=saveRecord(SHEETS.TRANSACTIONS, merged);
  if(merged.status==='確定')corrections.remember(getTransactionById(merged.id),previous?.status==='予定'?previous:null);
  return result;
}

function saveAccountRecord(data) {
  const previous = findRecord(SHEETS.ACCOUNTS, data.id);
  assertVersion(previous, data);
  if (typeof data.bank !== 'string' || !data.bank.trim()) throw new Error('銀行名は必須です');
  if (data.bank.length > 120 || (data.branch != null && (typeof data.branch !== 'string' || data.branch.length > 120))) throw new Error('銀行名・支店名は120文字以内で入力してください');
  if (data.accountNumber != null && (typeof data.accountNumber !== 'string' || !/^[0-9]{0,32}$/.test(data.accountNumber))) throw new Error('口座番号は半角数字32桁以内の文字列で入力してください');
  if (!['普通','当座','現金','定期'].includes(data.type)) throw new Error('口座の種別を選択してください');
  if (Object.hasOwn(data,'name')) throw new Error('口座名は廃止されました。銀行名・支店名を入力してください');
  if (!validDay(data.balanceDate) || data.balanceDate > getTodayKey()) throw new Error('今日以前の残高基準日を入力してください');
  if (data.balance === '' || data.balance == null || !Number.isSafeInteger(Number(data.balance))) throw new Error('残高は整数円で入力してください');
  return saveRecord(SHEETS.ACCOUNTS, Object.assign({}, data, { bank: data.bank.trim(), branch: data.branch?.trim() || '', accountNumber: data.accountNumber || '', balance: Number(data.balance) }));
}

function deleteBusinessRecord(data) {
  const name = data.sheet;
  if ([SHEETS.TRANSACTIONS, SHEETS.RECEIVABLES, SHEETS.PAYABLES, SHEETS.ACCOUNTS, SHEETS.PARTNERS].indexOf(name) < 0) throw new Error('削除できない対象です');
  const previous = findRecord(name, data.id);
  if (!previous) return { success: true, alreadyDeleted: true };
  assertVersion(previous, data);
  const transactions = getAllRecords(SHEETS.TRANSACTIONS).data;
  if(name===SHEETS.TRANSACTIONS&&(corrections.tracked(data.id)||repository.setting('pending_history_'+data.id)))throw new Error('履歴のある明細は物理削除できません');
  if (name === SHEETS.RECEIVABLES || name === SHEETS.PAYABLES) {
    const kind = name === SHEETS.RECEIVABLES ? 'receivable' : 'payable';
    const linked = transactions.filter(t => t.sourceId === data.id && (t.source === kind || t.source === kind + '_payment'));
    if(repository.setting('pending_history_'+previous.cfId))throw Error('予定の処理履歴がある売掛・買掛は物理削除できません');
    if (Number(previous.paidAmount) || linked.some(t=>hasActualResult(t)||corrections.tracked(t.id))) throw new Error('決済実績のある売掛・買掛は削除できません');
    linked.forEach(t => deleteRecord(SHEETS.TRANSACTIONS, t.id));
  }
  if (name === SHEETS.TRANSACTIONS && (previous.source !== 'manual' || hasActualResult(previous))) throw new Error('自動生成明細・確定実績は直接削除できません');
  if (name === SHEETS.ACCOUNTS && (transactions.some(t => t.account === data.id) || getAllRecords(SHEETS.FIXED_EXPENSES).data.some(t => t.account === data.id))) throw new Error('取引で使用中の口座は削除できません');
  return deleteRecord(name, data.id);
}

/**
 * 日本の祝日・営業日判定
 *
 * 現行の祝日法に基づく定例祝日、振替休日、国民の休日を計算する。
 * 2020年・2021年の特例移動にも対応する。春分・秋分の計算対象は1980〜2099年。
 * 法改正や臨時祝日が発表された場合は、このファイルだけを更新する。
 */

const JAPAN_HOLIDAY_CACHE = {};

/** 土日祝日でなければtrue */
function isBusinessDay(date) {
  const md=formatDateKey(date).slice(5);
  if (['12-31','01-02','01-03'].includes(md)) return false;
  const day = date.getDay();
  return day !== 0 && day !== 6 && !isJapaneseHoliday(date);
}

/** 日本の祝日ならtrue */
function isJapaneseHoliday(date) {
  const holidays = getJapaneseHolidays(date.getFullYear());
  return !!holidays[formatDateKey(date)];
}

/**
 * 休日調整
 * rule: next=翌営業日 / previous=前営業日 / none=当日
 */
function adjustToBusinessDay(date, rule) {
  const adjusted = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (rule === 'none' || isBusinessDay(adjusted)) return adjusted;

  const direction = rule === 'previous' ? -1 : 1;
  for (let i = 0; i < 20 && !isBusinessDay(adjusted); i++) {
    adjusted.setDate(adjusted.getDate() + direction);
  }
  return adjusted;
}

/** 指定年月の日付を作成。31日指定などはその月の末日に丸める。 */
function createClampedDate(year, month, day) {
  const lastDay = new Date(year, month, 0).getDate();
  return new Date(year, month - 1, Math.min(Number(day), lastDay));
}

/** YYYY-MM-DD */
function formatDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

/** 年ごとの祝日マップを返す */
function getJapaneseHolidays(year) {
  if (JAPAN_HOLIDAY_CACHE[year]) return JAPAN_HOLIDAY_CACHE[year];

  const holidays = {};
  const add = (month, day, name) => {
    holidays[
      year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0')
    ] = name;
  };

  add(1, 1, '元日');
  add(1, nthWeekdayOfMonth(year, 1, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (year >= 2020) add(2, 23, '天皇誕生日');

  const vernal = getVernalEquinoxDay(year);
  if (vernal) add(3, vernal, '春分の日');

  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');

  if (year === 2020) {
    add(7, 23, '海の日');
    add(7, 24, 'スポーツの日');
    add(8, 10, '山の日');
  } else if (year === 2021) {
    add(7, 22, '海の日');
    add(7, 23, 'スポーツの日');
    add(8, 8, '山の日');
  } else {
    add(7, nthWeekdayOfMonth(year, 7, 1, 3), '海の日');
    if (year >= 2016) add(8, 11, '山の日');
    add(10, nthWeekdayOfMonth(year, 10, 1, 2), 'スポーツの日');
  }

  add(9, nthWeekdayOfMonth(year, 9, 1, 3), '敬老の日');
  const autumnal = getAutumnalEquinoxDay(year);
  if (autumnal) add(9, autumnal, '秋分の日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');

  // 国民の休日：祝日に挟まれた日
  const first = new Date(year, 0, 2);
  const last = new Date(year, 11, 30);
  for (let date = first; date <= last; date.setDate(date.getDate() + 1)) {
    const key = formatDateKey(date);
    if (holidays[key]) continue;
    const prev = new Date(date);
    const next = new Date(date);
    prev.setDate(prev.getDate() - 1);
    next.setDate(next.getDate() + 1);
    if (holidays[formatDateKey(prev)] && holidays[formatDateKey(next)]) {
      holidays[key] = '国民の休日';
    }
  }

  // 振替休日：日曜の祝日後、最初の祝日でない日
  Object.keys(holidays).sort().forEach(key => {
    const parts = key.split('-').map(Number);
    const holiday = new Date(parts[0], parts[1] - 1, parts[2]);
    if (holiday.getDay() !== 0) return;
    const substitute = new Date(holiday);
    do {
      substitute.setDate(substitute.getDate() + 1);
    } while (holidays[formatDateKey(substitute)]);
    holidays[formatDateKey(substitute)] = '振替休日';
  });

  JAPAN_HOLIDAY_CACHE[year] = holidays;
  return holidays;
}

/** 指定月の第n月曜日等を返す。weekday: 日=0、月=1... */
function nthWeekdayOfMonth(year, month, weekday, nth) {
  const first = new Date(year, month - 1, 1);
  return 1 + ((7 + weekday - first.getDay()) % 7) + (nth - 1) * 7;
}

function getVernalEquinoxDay(year) {
  if (year < 1980 || year > 2099) return null;
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function getAutumnalEquinoxDay(year) {
  if (year < 1980 || year > 2099) return null;
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

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

  {
    const existing = getFixedExpenseById(normalized.id);
    if (existing) materializeMaster(existing);
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
  }
}

/** 固定支出マスタと未確定の生成予定を削除する */
function deleteFixedExpense(id, scope) {
  if (!id) return { error: '固定支出IDがありません' };

  {
    const previous = getFixedExpenseById(id);
    if (previous) materializeMaster(previous);
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
  }
}

/** マスタの期間内に予定を生成 */
function generateFixedExpenseTransactions(master, scope) {
  const result = { generated: 0, updated: 0, protected: 0 };
  const todayKey = getTodayKey();

  const horizon=calendar.shiftMonth(getTodayKey().slice(0,7),12);
  enumerateMonths(master.startMonth, master.endMonth && master.endMonth < horizon ? master.endMonth : horizon).forEach(month => {
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

  if (existing && (existing.source !== FIXED_EXPENSE_SOURCE || existing.sourceId !== master.id)) throw new Error('関連明細IDが重複しています');
  if (existing && (hasActualResult(existing) || existing.status === '取消' || corrections.tracked(existing.id) || repository.setting('pending_history_'+existing.id))) return 'protected';
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
  let removed = 0, protectedCount = 0;
  getAllRecords(SHEETS.TRANSACTIONS).data.forEach(t => {
    if (t.source !== FIXED_EXPENSE_SOURCE || t.sourceId !== masterId) return;
    if (hasActualResult(t) || t.status === '取消' || corrections.tracked(t.id) || repository.setting('pending_history_'+t.id)) { protectedCount++; return; }
    if (scope === 'future' && t.plannedDate < getTodayKey()) return;
    deleteRecord(SHEETS.TRANSACTIONS, t.id);
    removed++;
  });
  return { removed, protected: protectedCount };
}

function normalizeFixedExpense(data) {
  return {
    id: String(data.id || ('fe_' + randomUUID().replace(/-/g, '').slice(0, 16))),
    name: String(data.name || '').trim(),
    payee: String(data.payee || '').trim(),
    amount: Number(data.amount),
    day: Number(data.day),
    startMonth: String(data.startMonth || ''),
    endMonth: data.endMonth == null ? null : String(data.endMonth),
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
  if (!Number.isSafeInteger(data.amount) || !(data.amount > 0)) return '金額は1円以上で入力してください';
  if (!Number.isInteger(data.day) || !(data.day >= 1 && data.day <= 31)) return '基本引き落とし日は1〜31で入力してください';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(data.startMonth) || (data.endMonth !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.endMonth))) {
    return '開始月と終了月を入力してください';
  }
  if (data.endMonth && data.startMonth > data.endMonth) return '終了月は開始月以降にしてください';
  if (!data.account) return '支払口座を選択してください';

  return '';
}

function getFixedExpenseById(id) {
  return repository.find(SHEETS.FIXED_EXPENSES, id);
}

function getTransactionById(id) {
  return repository.find(SHEETS.TRANSACTIONS, id);
}

function hasActualResult(transaction) {
  return !!transaction.actualDate ||
    transaction.actualAmount !== null &&
    transaction.actualAmount !== undefined &&
    transaction.actualAmount !== '';
}

function enumerateMonths(startMonth,endMonth) {
  if(!startMonth || !endMonth || startMonth>endMonth) return [];
  return calendar.months(startMonth,endMonth);
}

function getTodayKey() {
  return today();
}

function sheetValueToDateKey(value) {
  if (value instanceof Date) return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
  return String(value || '').slice(0, 10);
}


function validateInput(body) {
  if(!body||typeof body!=='object'||Array.isArray(body)) throw new Error('入力形式が不正です');
  if(typeof body.action!=='string') throw new Error('操作が指定されていません');
  if(body.action!=='saveSettings'&&!new RegExp('^[A-Za-z0-9_-]{1,'+(['saveTransaction','deleteRecord'].includes(body.action)?160:80)+'}$').test(String(body.id||''))) throw new Error('不正なIDです');
  const numeric=new Set(['amount','paidAmount','plannedAmount','actualAmount','balance','day','sort']);
  for(const [key,value] of Object.entries(body)) {
    if(['__proto__','prototype','constructor'].includes(key)) throw new Error('入力形式が不正です');
    if(value!==null&&typeof value==='object') throw new Error('入力値が不正です');
    if(typeof value==='string'&&value.length>(key==='memo'?4000:1000)) throw new Error('入力が長すぎます');
    if(numeric.has(key)&&value!==null&&value!==''&&(typeof value==='boolean'||!Number.isSafeInteger(Number(value)))) throw new Error('数値は整数円で入力してください');
  }
}

function post(body, actor = 'system') {
  if(body?.action==='resolveOverdue') return resolveOverdue(body,actor);
  if(corrections.actions.has(body?.action))return corrections.post(body,actor);
  if (String(body?.action||'').startsWith('schedule')) return schedules.post(body,actor);
  validateInput(body);
  return repository.transaction(() => {
    let result;
    switch(body.action) {
      case 'saveTransaction': result = saveManualTransaction(body); break;
      case 'saveReceivable': result = saveDebt('receivable',body); break;
      case 'savePayable': result = saveDebt('payable',body); break;
      case 'confirmReceivable': result = confirmDebt('receivable',body); break;
      case 'confirmPayable': result = confirmDebt('payable',body); break;
      case 'saveAccount': result = saveAccountRecord(body); break;
      case 'savePartner':
        assertVersion(findRecord(SHEETS.PARTNERS,body.id),body);
        if(!String(body.name||'').trim()) throw new Error('取引先名は必須です');
        if(!['売掛','買掛','両方'].includes(body.type)) throw new Error('取引先の種別が不正です');
        result = saveRecord(SHEETS.PARTNERS,body); break;
      case 'saveFixedExpense':
        assertVersion(getFixedExpenseById(body.id),body); requireAccount(body.account);
        result=saveFixedExpense(body); break;
      case 'deleteFixedExpense':
        assertVersion(getFixedExpenseById(body.id),body);
        result=deleteFixedExpense(body.id,body.scope);break;
      case 'deleteRecord': result=deleteBusinessRecord(body);break;
      case 'saveSettings':
        if(typeof body.companyName!=='string'||body.companyName.trim().length<1||body.companyName.length>120) throw new Error('会社名を1〜120文字で入力してください');
        repository.saveSetting('companyName',body.companyName.trim());result={success:true};break;
      default: throw new Error('未対応の操作です');
    }
    if(result?.error) throw new Error(result.error);
    repository.audit(actor,body.action,body.id||'settings');
    return result;
  });
}

function projectedTransactions(through) {
  calendar.months(through,through,1);
  const records=repository.all(SHEETS.TRANSACTIONS), existing=new Set(records.map(t=>t.id));
  const limit=through==='9999-12'?through:calendar.shiftMonth(through,1); // next month's previous-business-day payment can fall in this month
  for(const master of repository.all(SHEETS.FIXED_EXPENSES)) {
    if(master.active===false) continue;
    const end=master.endMonth && master.endMonth<limit?master.endMonth:limit;
    for(const month of enumerateMonths(master.startMonth,end)) {
      const id=fixedExpenseTransactionId(master.id,month);
      if(!existing.has(id)) records.push({...buildFixedExpenseTransaction(master,month),virtual:true,createdAt:master.createdAt,updatedAt:master.updatedAt});
    }
  }
  return records;
}
function materializeMaster(master) {
  if(master.active===false) return 0;
  const horizon=calendar.shiftMonth(getTodayKey().slice(0,7),12);
  const end=master.endMonth && master.endMonth<horizon?master.endMonth:horizon;
  let added=0;
  for(const month of enumerateMonths(master.startMonth,end)) {
    const t=buildFixedExpenseTransaction(master,month);
    const existing=getTransactionById(t.id);
    if(existing && (existing.source!==FIXED_EXPENSE_SOURCE || existing.sourceId!==master.id)) throw new Error('関連明細IDが重複しています');
    if(!existing){saveRecord(SHEETS.TRANSACTIONS,t);added++;}
  }
  return added;
}
function replenish() {
  try { return repository.transaction(()=>{
    let added=0; for(const master of repository.all(SHEETS.FIXED_EXPENSES)) added+=materializeMaster(master);
    repository.saveSetting('fixedExpenseMaintenance',JSON.stringify({state:'ok',lastSuccessDay:getTodayKey(),added}));
    return {state:'ok',added};
  }); } catch(error) {
    try { repository.transaction(()=>repository.saveSetting('fixedExpenseMaintenance',JSON.stringify({...JSON.parse(repository.setting('fixedExpenseMaintenance')||'{}'),state:'failed'}))); } catch {}
    throw error;
  }
}

function get(action,params={}) {
  if(action==='getOverdue') return repository.readTransaction(()=>{
    const day=getTodayKey(),data=calendar.overdue(projectedTransactions(day.slice(0,7)),repository.all(SHEETS.ACCOUNTS).map(a=>a.id),day);
    const related=new Map();
    for(const m of schedules.get().data)for(const o of m.occurrences)for(const l of o.legs)related.set(l.transactionId,{...m,occurrences:[o]});
    return {...data,day,data:data.data.sort((a,b)=>a.plannedDate.localeCompare(b.plannedDate)||a.id.localeCompare(b.id)).map(t=>({...t,history:JSON.parse(repository.setting('pending_history_'+t.id)||'[]'),schedule:related.get(t.id)||null}))};
  });
  if(action==='getActualDetail')return repository.readTransaction(()=>corrections.get(params.id));
  if(action==='getActualHistory')return corrections.list();
  if (action==='getPaymentSchedules') return schedules.get(params.id,params.day);
  if (action==='previewScheduleDates') return schedules.dates(params);
  const tables={getReceivables:SHEETS.RECEIVABLES,getPayables:SHEETS.PAYABLES,getAccounts:SHEETS.ACCOUNTS,getPartners:SHEETS.PARTNERS,getFixedExpenses:SHEETS.FIXED_EXPENSES};
  if(tables[action]) return getAllRecords(tables[action]);
  if(action==='getCashflowPeriod') {
    calendar.months(params.start,params.end,60);
    if(!['actual','predict','diff'].includes(params.mode)) throw new Error('表示モードが不正です');
    if(!validDay(params.day)) throw new Error('基準日が不正です');
    return repository.readTransaction(()=>{
      const selected=String(params.accounts||'').split(',');
      const accounts=repository.all(SHEETS.ACCOUNTS).filter(a=>selected.includes(a.id));
      if(!accounts.length) throw new Error('出力する口座を選択してください');
      const transactions=projectedTransactions(params.end<getTodayKey().slice(0,7)?getTodayKey().slice(0,7):params.end);
      return {accounts,periods:calendar.period(accounts,transactions,params.start,params.end,params.mode,params.day)};
    });
  }
  if(action==='getFixedExpenseMaintenance') return JSON.parse(repository.setting('fixedExpenseMaintenance')||'{"state":"missing"}');
  if(action==='getSettings') return {companyName:repository.setting('companyName')||companyName};
  if(action==='getTransactions') {
    const month=params.all==='true'?null:params.month;
    if(month&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('不正な月です');
    const through=params.through || month || calendar.shiftMonth(getTodayKey().slice(0,7),12);
    const data=projectedTransactions(through<getTodayKey().slice(0,7)?getTodayKey().slice(0,7):through);
    return {day:getTodayKey(),data:month?data.filter(t=>(t.actualDate||t.plannedDate||'').slice(0,7)===month):data};
  }
  if(action==='testConnection') return {success:true,message:'保存先に接続されています'};
  throw new Error('未対応の操作です');
}
const schedules=require('./schedules.cjs')(repository,{today,adjustDate:(day,rule)=>formatDateKey(adjustToBusinessDay(new Date(day+'T12:00:00'),rule))});
const corrections=require('./corrections.cjs')(repository,{today,syncDebtSchedule});
function resolveOverdue(b,actor){
  const allowed=new Set(['action','id','requestId','operation','expectedUpdatedAt','expectedVersion','date','amount','actualPrincipal','actualInterest','settled','acknowledgeBaseline']);
  if(Object.keys(b).some(k=>!allowed.has(k))||!/^[A-Za-z0-9_-]{1,160}$/.test(b.id||''))throw Error('入力項目を確認してください');
  for(const field of ['amount','actualPrincipal','actualInterest'])if(b[field]!=null&&(typeof b[field]!=='number'||!Number.isSafeInteger(b[field])||b[field]<0))throw Error('金額は0以上の整数円で入力してください');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(b.requestId||''))throw Error('操作IDが必要です');
  const digest=require('node:crypto').createHash('sha256').update(JSON.stringify([actor,b])).digest('hex');
  return repository.transaction(()=>{
    const key='pending_request_'+b.requestId,prior=repository.setting(key);
    if(prior){const p=JSON.parse(prior);if(p.digest!==digest)throw Error('同じ再送IDで内容が異なります');return {...p.result,duplicate:true};}
    let t=projectedTransactions(getTodayKey().slice(0,7)).find(t=>t.id===b.id);
    if(!t||!calendar.isOverdue(t,getTodayKey()))throw Error('対象は期限超過した未確定予定ではありません。再読込してください');
    assertVersion(t,b);
    if(!['scheduled','actual','reschedule','cancel'].includes(b.operation))throw Error('処理方法を明示的に選択してください');
    const before={...t};delete before.virtual;
    if(t.virtual){saveRecord(SHEETS.TRANSACTIONS,before);t=getTransactionById(t.id);}
    const date=b.operation==='scheduled'?t.plannedDate:b.date;
    if(b.operation!=='cancel' && (!validDay(date)||(b.operation!=='reschedule'&&date>getTodayKey())))throw Error('有効な日付を指定してください');
    const account=findRecord(SHEETS.ACCOUNTS,t.account);
    if(['scheduled','actual'].includes(b.operation)&&date<=account.balanceDate&&b.acknowledgeBaseline!==true)throw Error('残高基準日以前の実績です。基準残高に含まれることを確認してください');
    if(b.operation==='reschedule'&&corrections.tracked(t.id))throw Error('実績訂正履歴のある元予定は保持します。実績訂正から処理してください');
    let result;
    if(t.source==='payment_schedule'){
      const m=schedules.get().data.find(m=>m.occurrences.some(o=>o.legs.some(l=>l.transactionId===t.id)));
      const o=m?.occurrences.find(o=>o.legs.some(l=>l.transactionId===t.id)),l=o?.legs.find(l=>l.transactionId===t.id);
      if(!l)throw Error('関連予定が見つかりません');
      if(b.expectedVersion!==m.version)throw Error('他の操作で更新されています。再読込してください');
      if(['scheduled','actual'].includes(b.operation)&&m.kind==='loan'&&date<=m.principalBalanceDate&&b.acknowledgeBaseline!==true)throw Error('借入の残元本基準日以前です。基準残元本に含まれることを確認してください');
      const common={id:l.id,requestId:b.requestId,expectedVersion:m.version};
      if(b.operation==='reschedule')result=schedules.post({...common,action:'scheduleReschedule',plannedDate:date},actor);
      else if(b.operation==='cancel')result=schedules.post({...common,action:'scheduleCancelLeg'},actor);
      else result=schedules.post({...common,action:'scheduleConfirm',settled:b.settled===true,actualDate:date,actualAmount:b.operation==='scheduled'?Number(t.plannedAmount):b.amount,actualPrincipal:b.operation==='scheduled'?(l.component==='interest'?0:o.plannedPrincipal):b.actualPrincipal,actualInterest:b.operation==='scheduled'?(l.component==='principal'?0:o.plannedInterest):b.actualInterest},actor);
    }else if(['receivable','payable'].includes(t.source)){
      const c=debtConfig(t.source),d=findRecord(c.sheet,t.sourceId);
      if(!d||d.cfId!==t.id||d.dueDate!==t.plannedDate||Number(d.amount)-Number(d.paidAmount||0)!==Number(t.plannedAmount))throw Error('元データとの整合性を確認してください');
      if(b.operation==='cancel'){repository.saveSetting('pending_cancel_'+t.id,JSON.stringify({date:getTodayKey(),actor}));syncDebtSchedule(t.source,d);result={success:true};}
      else if(b.operation==='reschedule')result=saveDebt(t.source,{...d,expectedUpdatedAt:d.updatedAt,dueDate:date});
      else result=confirmDebt(t.source,{id:d.id,expectedUpdatedAt:d.updatedAt,paymentId:b.requestId,date,amount:b.operation==='scheduled'?t.plannedAmount:b.amount,account:t.account});
    }else if(['manual','fixed_expense'].includes(t.source)){
      if(b.operation==='reschedule')result=saveRecord(SHEETS.TRANSACTIONS,{...t,plannedDate:date});
      else result=saveManualTransaction({...t,expectedUpdatedAt:t.updatedAt,status:b.operation==='cancel'?'取消':'確定',actualDate:b.operation==='cancel'?null:date,actualAmount:b.operation==='cancel'?null:b.operation==='scheduled'?t.plannedAmount:b.amount});
    }else throw Error('この予定種別には対応していません');
    const historyKey='pending_history_'+t.id,history=JSON.parse(repository.setting(historyKey)||'[]');
    history.push({operation:b.operation,actor,at:new Date().toISOString(),before,after:getTransactionById(t.id)});
    repository.saveSetting(historyKey,JSON.stringify(history));
    repository.saveSetting(key,JSON.stringify({digest,result}));repository.audit(actor,'resolveOverdue:'+b.operation,t.id);
    return result;
  });
}
return {post,get,replenish};

};
