// ============================================================
// スプレッドシート初期セットアップ
// ============================================================
/**
 * 初回セットアップ関数
 * GASエディタから手動で一度だけ実行してください
 */
function setupSpreadsheet() {
  // 全シートを初期化
  Object.values(SHEETS).forEach(name => {
    getOrCreateSheet(name);
  });

  // 初期口座データを挿入
  const accountSheet = getOrCreateSheet(SHEETS.ACCOUNTS);
  const existingAccounts = accountSheet.getLastRow();

  if (existingAccounts <= 1) {
    // ヘッダーのみの場合は初期データを挿入
    const now = new Date().toISOString();
    const initialAccounts = [
      ['acc1', 'メイン口座',  '〇〇銀行', '普通', 0, 1, now, now],
      ['acc2', '補助口座',    '△△銀行', '普通', 0, 2, now, now],
      ['acc3', '小口現金①', '',          '現金', 0, 3, now, now],
      ['acc4', '小口現金②', '',          '現金', 0, 4, now, now],
    ];
    accountSheet.getRange(2, 1, initialAccounts.length, initialAccounts[0].length)
      .setValues(initialAccounts);
  }

  // 列幅の自動調整
  Object.values(SHEETS).forEach(name => {
    const sheet = getOrCreateSheet(name);
    sheet.autoResizeColumns(1, sheet.getLastColumn());
  });

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'セットアップが完了しました。GAS WebアプリとしてデプロイしてURLをコピーしてください。',
    '✅ セットアップ完了', 10
  );

  Logger.log('Setup completed. Sheets created:');
  Object.values(SHEETS).forEach(name => Logger.log(' - ' + name));
}

// ============================================================
// デバッグ用ユーティリティ
// ============================================================

/**
 * テスト用：全シートのレコード数をログ出力
 */
function debugSheetStats() {
  Object.values(SHEETS).forEach(name => {
    const sheet = getOrCreateSheet(name);
    Logger.log(`${name}: ${Math.max(0, sheet.getLastRow() - 1)} records`);
  });
}

/**
 * テスト用：GETパラメータをシミュレートしてテスト
 */
function testGetTransactions() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const result = getTransactions(month);
  Logger.log(JSON.stringify(result, null, 2));
}
