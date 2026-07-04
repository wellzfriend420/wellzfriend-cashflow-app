/**
 * 資金繰り取引の取得処理
 *
 * Apps Scriptでは同一プロジェクト内の .gs ファイルが共通名前空間で動作するため、
 * main.gs の SHEETS と spreadsheet.gs の共通関数をそのまま参照する。
 */

/**
 * 月指定で資金繰りトランザクションを取得
 * 予定日または実績日がその月に含まれるレコードを返す
 */
function getTransactions(month) {
  if (!month) {
    // monthが未指定なら全件返す
    return getAllRecords(SHEETS.TRANSACTIONS);
  }

  const [y, m] = month.split('-').map(Number);
  const startDate = new Date(y, m - 1, 1);
  const endDate = new Date(y, m, 0); // 月末

  const sheet = getOrCreateSheet(SHEETS.TRANSACTIONS);
  const data = sheet.getDataRange().getValues();

  if (data.length <= 1) return { data: [] };

  const headers = data[0];
  const records = [];

  // カラムインデックスを事前取得（高速化）
  const plannedDateIdx = headers.indexOf('plannedDate');
  const actualDateIdx  = headers.indexOf('actualDate');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;

    const plannedDate = row[plannedDateIdx];
    const actualDate  = row[actualDateIdx];

    // 予定日または実績日がその月に含まれるかチェック
    const pd = plannedDate instanceof Date ? plannedDate : (plannedDate ? new Date(plannedDate) : null);
    const ad = actualDate  instanceof Date ? actualDate  : (actualDate  ? new Date(actualDate)  : null);

    const inMonth = (pd && pd >= startDate && pd <= endDate) ||
                    (ad && ad >= startDate && ad <= endDate);

    if (!inMonth) continue;

    const record = {};
    headers.forEach((header, j) => {
      let val = row[j];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd');
      }
      record[header] = val === '' ? null : val;
    });
    records.push(record);
  }

  return { data: records };
}
