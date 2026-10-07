// Shared by the screen and Excel export. Calendar keys avoid timezone conversion.
(function (root) {
  const accountLabel = account => [account.bank, account.branch].filter(Boolean).join(' ');
  const hasActual = t => Boolean(t.actualDate) && t.actualAmount !== null && t.actualAmount !== undefined && t.actualAmount !== '';
  const active = t => t.status !== '取消' && t.status !== '完了';
  const signed = (t, amount) => (t.type === '入金' ? 1 : -1) * Number(amount || 0);
  function snapshotDay(account) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(account.balanceDate || '')) throw new Error('口座「' + accountLabel(account) + '」の残高基準日を設定してください');
    return account.balanceDate;
  }
  function actualAt(account, transactions, target) {
    const baseline = snapshotDay(account);
    let value = Number(account.balance || 0);
    transactions.filter(t => active(t) && t.account === account.id && hasActual(t)).forEach(t => {
      if (t.actualDate > baseline && t.actualDate <= target) value += signed(t, t.actualAmount);
      if (t.actualDate > target && t.actualDate <= baseline) value -= signed(t, t.actualAmount);
    });
    return value;
  }
  function effectiveDate(t, today) {
    if (hasActual(t)) return t.actualDate;
    return t.plannedDate || '';
  }
  const isOverdue = (t, today) => active(t) && !hasActual(t) && Boolean(t.plannedDate) && t.plannedDate < today;
  function overdue(transactions, accountIds, today) {
    const data = transactions.filter(t => accountIds.includes(t.account) && isOverdue(t, today));
    const income = {count:0,amount:0}, expense = {count:0,amount:0};
    for (const t of data) {
      const amount = Number(t.plannedAmount), group = t.type === '入金' ? income : expense;
      if (!['入金','出金'].includes(t.type) || t.plannedAmount == null || !Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(group.amount + amount)) throw Error('期限超過予定の金額を確認してください');
      group.count++; group.amount += amount;
    }
    return {data, income, expense};
  }
  function balanceAt(account, transactions, target, mode, today) {
    let value = actualAt(account, transactions, target);
    if (mode !== 'actual') transactions.filter(t => active(t) && t.account === account.id && !hasActual(t)).forEach(t => {
      const date = effectiveDate(t, today);
      if (date && date >= today && date <= target) value += signed(t, t.plannedAmount);
    });
    return value;
  }
  function previousDay(month) {
    const date = new Date(month + '-01T00:00:00Z');
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
  function opening(accounts, transactions, month, mode, today) {
    return Object.fromEntries(accounts.map(a => [a.id, balanceAt(a, transactions, previousDay(month), mode, today)]));
  }
  function rows(transactions, accountIds, month, mode, today) {
    return transactions.filter(t => active(t) && accountIds.includes(t.account) && (mode !== 'actual' || hasActual(t)))
      .map(t => Object.assign({}, t, { cashDate: effectiveDate(t, today), cashAmount: hasActual(t) ? Number(t.actualAmount) : Number(t.plannedAmount), overdue: isOverdue(t,today), balanceAmount: isOverdue(t,today) ? 0 : Number(hasActual(t) ? t.actualAmount : t.plannedAmount) }))
      .filter(t => t.cashDate && t.cashDate.slice(0, 7) === month)
      .sort((a, b) => a.cashDate.localeCompare(b.cashDate) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
  }

  function monthIndex(value) {
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value||'') || value.slice(0,4)==='0000') throw new Error('有効な年月を選択してください');
    const [y,m]=value.split('-').map(Number); return y*12+m-1;
  }
  function shiftMonth(month,delta) {
    const n=monthIndex(month)+delta;
    if(n<12||n>=120000) throw new Error('指定できる年月の範囲を超えています');
    return String(Math.floor(n/12)).padStart(4,'0')+'-'+String(n%12+1).padStart(2,'0');
  }
  function months(start,end,max=120000) {
    const a=monthIndex(start),b=monthIndex(end);
    if(b<a||b-a+1>max) throw new Error('開始・終了年月を確認してください（期間出力は最大60か月）');
    return Array.from({length:b-a+1},(_,i)=>shiftMonth(start,i));
  }
  function period(accounts,transactions,start,end,mode,today,max=60) {
    const ids=accounts.map(a=>a.id);
    return months(start,end,max).map(month=>{
      const openingBalances=opening(accounts,transactions,month,mode,today);
      const movements=rows(transactions,ids,month,mode,today);
      const totals=Object.fromEntries(accounts.map(a=>[a.id,{opening:openingBalances[a.id],income:0,expense:0,closing:openingBalances[a.id]}]));
      for(const t of movements){const v=totals[t.account];v[t.type==='入金'?'income':'expense']+=t.balanceAmount;v.closing+=signed(t,t.balanceAmount);}
      const outstanding=overdue(transactions,ids,today);
      for(const a of accounts){const d=overdue(transactions,[a.id],today);totals[a.id].reference=mode==='actual'||month<today.slice(0,7)?null:totals[a.id].closing+d.income.amount-d.expense.amount;}
      return {month,day:today,opening:openingBalances,rows:movements,totals,overdue:outstanding};
    });
  }

  const api = { monthIndex, shiftMonth, months, period, accountLabel, hasActual, isOverdue, overdue, actualAt, effectiveDate, balanceAt, opening, rows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CashflowMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
