'use strict';
const SHEETS = {
  TRANSACTIONS: 'cashflow_transactions', // 資金繰り取引データ
  RECEIVABLES:  'receivables',           // 売掛データ
  PAYABLES:     'payables',              // 買掛データ
  ACCOUNTS:     'accounts',             // 口座マスタ
  PARTNERS:     'partners',             // 取引先マスタ
  SETTINGS:     'settings',             // 設定データ
  FIXED_EXPENSES: 'fixed_expenses',      // 固定支出マスタ
};

// ===== シートのカラム定義 =====
const COLUMNS = {
  cashflow_transactions: [
    'id', 'source', 'sourceId', 'status', 'type',
    'partner', 'description', 'account',
    'plannedDate', 'plannedAmount', 'actualDate', 'actualAmount',
    'memo', 'createdAt', 'updatedAt'
  ],
  receivables: [
    'id', 'partner', 'invoiceDate', 'amount', 'dueDate',
    'paidAmount', 'status', 'cfId', 'memo', 'createdAt', 'updatedAt', 'account'
  ],
  payables: [
    'id', 'partner', 'occDate', 'amount', 'dueDate',
    'paidAmount', 'status', 'cfId', 'memo', 'createdAt', 'updatedAt', 'account'
  ],
  accounts: [
    'id', 'bank', 'branch', 'type', 'accountNumber', 'balance', 'sort', 'createdAt', 'updatedAt', 'balanceDate'
  ],
  partners: [
    'id', 'name', 'type', 'createdAt', 'updatedAt'
  ],
  settings: [
    'key', 'value', 'updatedAt'
  ],
  fixed_expenses: [
    'id', 'name', 'payee', 'amount', 'day', 'startMonth', 'endMonth',
    'account', 'holidayRule', 'memo', 'active', 'createdAt', 'updatedAt'
  ],
};


module.exports = { SHEETS, COLUMNS };
