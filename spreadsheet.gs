// ============================================================
// スプレッドシート操作 ユーティリティ
// ============================================================

/**
 * スプレッドシートを取得（キャッシュ付き）
 */
function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/**
 * 指定シートを取得（存在しない場合は作成）
 */
function getOrCreateSheet(sheetName) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    // シートが存在しない場合は新規作成してヘッダーを設定
    sheet = ss.insertSheet(sheetName);
    const cols = COLUMNS[sheetName];
    if (cols) {
      sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
      // ヘッダー行のスタイル設定
      sheet.getRange(1, 1, 1, cols.length)
        .setBackground('#1A2D45')
        .setFontColor('#FFFFFF')
        .setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }

  return sheet;
}

/**
 * シートの全データを取得してオブジェクト配列に変換
 */
function getAllRecords(sheetName) {
  const sheet = getOrCreateSheet(sheetName);
  const data = sheet.getDataRange().getValues();

  if (data.length <= 1) return { data: [] }; // ヘッダーのみ

  const headers = data[0];
  const records = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // 空行スキップ
    if (!row[0]) continue;

    const record = {};
    headers.forEach((header, j) => {
      let val = row[j];
      // 日付オブジェクトを文字列に変換
      if (val instanceof Date) {
        val = Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd');
      }
      record[header] = val === '' ? null : val;
    });
    records.push(record);
  }

  return { data: records };
}

/**
 * レコードを保存（upsert: 存在すれば更新、なければ追加）
 */
function saveRecord(sheetName, data) {
  const sheet = getOrCreateSheet(sheetName);
  const cols = COLUMNS[sheetName];
  if (!cols) return { error: 'Unknown sheet: ' + sheetName };

  const allData = sheet.getDataRange().getValues();
  const headers = allData[0];

  // IDでの行検索
  const idIdx = headers.indexOf('id');
  let targetRow = -1;

  if (idIdx >= 0 && data.id) {
    for (let i = 1; i < allData.length; i++) {
      if (String(allData[i][idIdx]) === String(data.id)) {
        targetRow = i + 1; // スプレッドシートの行番号（1始まり）
        break;
      }
    }
  }

  // 書き込む値の配列を作成
  const rowData = cols.map(col => {
    const val = data[col];
    // null/undefinedは空文字に
    return val === null || val === undefined ? '' : val;
  });

  if (targetRow > 0) {
    // 既存行を更新
    sheet.getRange(targetRow, 1, 1, rowData.length).setValues([rowData]);
  } else {
    // 新規行を末尾に追加
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, 1, rowData.length).setValues([rowData]);
  }

  return { success: true, id: data.id };
}

/**
 * レコードを削除（IDで行を特定して削除）
 */
function deleteRecord(sheetName, id) {
  const sheet = getOrCreateSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idIdx = headers.indexOf('id');

  if (idIdx < 0) return { error: 'id column not found' };

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }

  return { error: 'Record not found: ' + id };
}
