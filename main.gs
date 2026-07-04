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
    'paidAmount', 'status', 'cfId', 'memo', 'createdAt', 'updatedAt'
  ],
  payables: [
    'id', 'partner', 'occDate', 'amount', 'dueDate',
    'paidAmount', 'status', 'cfId', 'memo', 'createdAt', 'updatedAt'
  ],
  accounts: [
    'id', 'name', 'bank', 'type', 'balance', 'sort', 'createdAt', 'updatedAt'
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
        ensureFixedExpenseTransactionsForMonth(e.parameter.month);
        result = getTransactions(e.parameter.month);
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
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    // POSTボディをJSONとして解析
    const body = JSON.parse(e.postData.contents);
    const action = body.action || '';
    let result = {};

    switch (action) {
      case 'saveTransaction':
        result = saveRecord(SHEETS.TRANSACTIONS, body);
        break;
      case 'saveReceivable':
        result = saveRecord(SHEETS.RECEIVABLES, body);
        break;
      case 'savePayable':
        result = saveRecord(SHEETS.PAYABLES, body);
        break;
      case 'saveAccount':
        result = saveRecord(SHEETS.ACCOUNTS, body);
        break;
      case 'savePartner':
        result = saveRecord(SHEETS.PARTNERS, body);
        break;
      case 'saveFixedExpense':
        result = saveFixedExpense(body);
        break;
      case 'deleteFixedExpense':
        result = deleteFixedExpense(body.id, body.scope);
        break;
      case 'deleteRecord':
        result = deleteRecord(body.sheet, body.id);
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
