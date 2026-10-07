/**
 * ============================================================
 * 日繰り資金繰り管理システム - Google Apps Script バックエンド
 * ============================================================
 * 設定方法：
 *   1. このコードをGASエディタに貼り付け
 *   2. スプレッドシートIDを SPREADSHEET_ID に設定
 *   3. 「デプロイ」→「新しいデプロイ」→「ウェブアプリ」
 *   4. アクセスできるユーザー：「全員」または「組織内全員」
 *   5. デプロイされたURLをHTMLの設定画面に入力
 * ============================================================
 */

// ===== スプレッドシートID設定 =====
// ここにGoogleスプレッドシートのIDを設定してください
// URL: https://docs.google.com/spreadsheets/d/【このID】/edit
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';

// ===== シート名定義 =====
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
    'id', 'name', 'bank', 'type', 'balance', 'sort', 'createdAt', 'updatedAt', 'balanceDate'
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

// ============================================================
// GETリクエストハンドラー
// ============================================================
function doGet(e) {
  // CORS対応ヘッダー
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    const action = e.parameter.action || '';
    let result = {};

    switch (action) {
      case 'getTransactions':
        result = getTransactions(e.parameter.all === 'true' ? null : e.parameter.month);
        break;
      case 'getReceivables':
        result = getAllRecords(SHEETS.RECEIVABLES);
        break;
      case 'getPayables':
        result = getAllRecords(SHEETS.PAYABLES);
        break;
      case 'getAccounts':
        result = getAllRecords(SHEETS.ACCOUNTS);
        break;
      case 'getPartners':
        result = getAllRecords(SHEETS.PARTNERS);
        break;
      case 'getFixedExpenses':
        result = getAllRecords(SHEETS.FIXED_EXPENSES);
        break;
      case 'testConnection':
        getAllRecords(SHEETS.ACCOUNTS);
        result = { success: true, message: 'スプレッドシートに接続されました' };
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }

    output.setContent(JSON.stringify(result));
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }

  return output;
}

// ============================================================
// POSTリクエストハンドラー
// ============================================================
function doPost(e) {
  const output = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);
  try {
    const body = JSON.parse(e.postData.contents);
    const result = withStoreTransaction(() => {
      switch (body.action) {
        case 'saveTransaction': return saveManualTransaction(body);
        case 'saveReceivable': return saveDebt('receivable', body);
        case 'savePayable': return saveDebt('payable', body);
        case 'confirmReceivable': return confirmDebt('receivable', body);
        case 'confirmPayable': return confirmDebt('payable', body);
        case 'saveAccount': return saveAccountRecord(body);
        case 'savePartner':
          assertVersion(findRecord(SHEETS.PARTNERS, body.id), body);
          if (!String(body.name || '').trim()) throw new Error('取引先名は必須です');
          return saveRecord(SHEETS.PARTNERS, body);
        case 'saveFixedExpense':
          assertVersion(getFixedExpenseById(body.id), body);
          requireAccount(body.account);
          return saveFixedExpense(body);
        case 'deleteFixedExpense':
          assertVersion(getFixedExpenseById(body.id), body);
          return deleteFixedExpense(body.id, body.scope);
        case 'deleteRecord': return deleteBusinessRecord(body);
        default: throw new Error('Unknown action');
      }
    });
    output.setContent(JSON.stringify(result));
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }
  return output;
}
