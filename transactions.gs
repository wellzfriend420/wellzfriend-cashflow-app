// All records are returned for cross-month balance reconstruction when month is absent.
function getTransactions(month) {
  const records = getAllRecords(SHEETS.TRANSACTIONS).data;
  if (!month) return { data: records };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('不正な月です');
  return { data: records.filter(t => String(t.actualDate || t.plannedDate || '').slice(0, 7) === month) };
}
