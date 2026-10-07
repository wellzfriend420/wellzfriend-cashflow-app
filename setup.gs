// Explicit setup only. Never seed fictitious operational accounts.
function setupSpreadsheet() {
  const ss = getSpreadsheet();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // Validate all existing headers before changing anything. Only append-only upgrades.
    Object.keys(COLUMNS).forEach(name => {
      const sheet = ss.getSheetByName(name);
      if (!sheet || sheet.getLastRow() === 0) return;
      const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (header.some((key, i) => key !== COLUMNS[name][i])) throw new Error('列定義を確認してください: ' + name);
      if (sheet.getLastRow() > 1 && header.length !== COLUMNS[name].length) throw new Error('既存データがあります。列移行を個別に確認してください: ' + name);
    });
    ss.setSpreadsheetTimeZone('Asia/Tokyo');
    Object.keys(COLUMNS).forEach(name => {
      const sheet = getOrCreateSheet(name);
      sheet.getRange(1, 1, 1, COLUMNS[name].length).setValues([COLUMNS[name]]);
      sheet.setFrozenRows(1);
    });
  } finally { lock.releaseLock(); }
}
