// Storage adapter: stage all changes, then commit in one atomic Sheets batch.
let storeDraft = null;

function getSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

function getOrCreateSheet(name) {
  if (!COLUMNS[name]) throw new Error('Unknown sheet: ' + name);
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, COLUMNS[name].length).setValues([COLUMNS[name]]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readSheetRecords(sheet, name) {
  const values = sheet.getDataRange().getValues();
  if (JSON.stringify(values[0]) !== JSON.stringify(COLUMNS[name])) {
    throw new Error(name + ': 列定義が異なります。先にsetupSpreadsheetを実行してください');
  }
  return values.slice(1).filter(row => row[0] !== '' && row[0] != null).map(row => {
    const record = {};
    COLUMNS[name].forEach((key, i) => {
      const value = row[i];
      record[key] = value instanceof Date
        ? Utilities.formatDate(value, 'Asia/Tokyo', key.endsWith('At') ? "yyyy-MM-dd'T'HH:mm:ssXXX" : 'yyyy-MM-dd')
        : value === '' || value === undefined ? null : value;
    });
    return record;
  });
}

function getAllRecords(name) {
  if (!COLUMNS[name]) throw new Error('Unknown sheet: ' + name);
  if (storeDraft) return { data: JSON.parse(JSON.stringify(storeDraft[name].records)) };
  const sheet = getSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('初期設定が必要です: ' + name);
  return { data: readSheetRecords(sheet, name) };
}

function withStoreTransaction(work) {
  if (storeDraft) return work();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSpreadsheet();
    storeDraft = {};
    Object.keys(COLUMNS).forEach(name => {
      const sheet = ss.getSheetByName(name);
      if (!sheet) throw new Error('初期設定が必要です: ' + name);
      const records = readSheetRecords(sheet, name);
      storeDraft[name] = { sheet, records, original: JSON.stringify(records), originalLength: sheet.getLastRow() - 1 };
    });
    const result = work();
    if (result && result.error) throw new Error(result.error);
    const requests = [];
    Object.keys(storeDraft).forEach(name => {
      const entry = storeDraft[name];
      if (JSON.stringify(entry.records) === entry.original) return;
      const rowCount = Math.max(entry.originalLength, entry.records.length) + 1;
      const sheetId = entry.sheet.getSheetId();
      if (rowCount > entry.sheet.getMaxRows()) {
        requests.push({ appendDimension: { sheetId, dimension: 'ROWS', length: rowCount - entry.sheet.getMaxRows() } });
      }
      const rows = entry.records.map(record => ({ values: COLUMNS[name].map(key => {
        const value = record[key];
        if (value === null || value === undefined || value === '') return {};
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) throw new Error('不正な数値: ' + key);
          return { userEnteredValue: { numberValue: value } };
        }
        // Explicit strings prevent formula injection from names and memos.
        return { userEnteredValue: typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) } };
      }) }));
      requests.push({ updateCells: { range: { sheetId, startRowIndex: 1, endRowIndex: rowCount,
        startColumnIndex: 0, endColumnIndex: COLUMNS[name].length }, rows, fields: 'userEnteredValue' } });
    });
    if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests }, ss.getId());
    return result;
  } finally {
    storeDraft = null;
    lock.releaseLock();
  }
}

function saveRecord(name, data) {
  if (!storeDraft) throw new Error('保存はwithStoreTransaction内で実行してください');
  if (!COLUMNS[name] || name === SHEETS.SETTINGS) throw new Error('Invalid writable sheet');
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(data.id || ''))) throw new Error('不正なIDです');
  const records = storeDraft[name].records;
  const index = records.findIndex(row => String(row.id) === String(data.id));
  const previous = index < 0 ? {} : records[index];
  const record = {};
  COLUMNS[name].forEach(key => { record[key] = data[key] === undefined ? (previous[key] ?? null) : data[key]; });
  record.createdAt = previous.createdAt || data.createdAt || new Date().toISOString();
  record.updatedAt = new Date(Math.max(Date.now(), (Date.parse(previous.updatedAt) || 0) + 1)).toISOString();
  if (index < 0) records.push(record); else records[index] = record;
  return { success: true, id: record.id, updatedAt: record.updatedAt };
}

function deleteRecord(name, id) {
  if (!storeDraft || !storeDraft[name]) throw new Error('Invalid delete transaction');
  const records = storeDraft[name].records;
  const index = records.findIndex(row => String(row.id) === String(id));
  if (index < 0) return { success: true, id, alreadyDeleted: true };
  records.splice(index, 1);
  return { success: true, id };
}
