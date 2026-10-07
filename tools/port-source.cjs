// One-time migration of reviewed storage-neutral business code; no VM at runtime.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
fs.mkdirSync(path.join(root, 'src/domain'), { recursive: true });
const main = read('main.gs');
const contract = main.slice(main.indexOf('const SHEETS ='), main.indexOf('// ============================================================\n// GET'.replaceAll('\n','\r\n')) > -1 ? main.indexOf('// ============================================================\r\n// GET') : main.indexOf('// ============================================================\n// GET'));
fs.writeFileSync(path.join(root, 'src/contract.cjs'), "'use strict';\n" + contract + '\nmodule.exports = { SHEETS, COLUMNS };\n');
let ledger = read('ledger.gs').replace("getAllRecords(name).data.find(row => row.id === id) || null", 'repository.find(name, id)');
let fixed = read('fixedExpense.gs')
  .replace("Utilities.getUuid()", 'randomUUID()')
  .replace("Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd')", 'today()')
  .replace("Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd')", "new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(value)")
  .replace("const records = getAllRecords(SHEETS.FIXED_EXPENSES).data || [];\n  return records.find(record => String(record.id) === String(id)) || null;", 'return repository.find(SHEETS.FIXED_EXPENSES, id);');
const actions = `
function post(body, actor = 'system') {
  validateInput(body);
  return repository.transaction(() => {
    let result;
    switch(body.action) {
      case 'saveTransaction': result = saveManualTransaction(body); break;
      case 'saveReceivable': result = saveDebt('receivable',body); break;
      case 'savePayable': result = saveDebt('payable',body); break;
      case 'confirmReceivable': result = confirmDebt('receivable',body); break;
      case 'confirmPayable': result = confirmDebt('payable',body); break;
      case 'saveAccount': result = saveAccountRecord(body); break;
      case 'savePartner':
        assertVersion(findRecord(SHEETS.PARTNERS,body.id),body);
        if(!String(body.name||'').trim()) throw new Error('取引先名は必須です');
        if(!['売掛','買掛','両方'].includes(body.type)) throw new Error('取引先の種別が不正です');
        result = saveRecord(SHEETS.PARTNERS,body); break;
      case 'saveFixedExpense':
        assertVersion(getFixedExpenseById(body.id),body); requireAccount(body.account);
        result=saveFixedExpense(body); break;
      case 'deleteFixedExpense':
        assertVersion(getFixedExpenseById(body.id),body);
        result=deleteFixedExpense(body.id,body.scope);break;
      case 'deleteRecord': result=deleteBusinessRecord(body);break;
      case 'saveSettings':
        if(typeof body.companyName!=='string'||body.companyName.trim().length<1||body.companyName.length>120) throw new Error('会社名を1〜120文字で入力してください');
        repository.saveSetting('companyName',body.companyName.trim());result={success:true};break;
      default: throw new Error('未対応の操作です');
    }
    if(result?.error) throw new Error(result.error);
    repository.audit(actor,body.action,body.id||'settings');
    return result;
  });
}
function get(action,params={}) {
  const tables={getReceivables:SHEETS.RECEIVABLES,getPayables:SHEETS.PAYABLES,getAccounts:SHEETS.ACCOUNTS,getPartners:SHEETS.PARTNERS,getFixedExpenses:SHEETS.FIXED_EXPENSES};
  if(tables[action]) return getAllRecords(tables[action]);
  if(action==='getSettings') return {companyName:repository.setting('companyName')||'資金繰りシステム'};
  if(action==='getTransactions') {
    const month=params.all==='true'?null:params.month;
    if(month&&!/^\\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('不正な月です');
    return {data:repository.transactionsForMonth(month)};
  }
  if(action==='testConnection') return {success:true,message:'保存先に接続されています'};
  throw new Error('未対応の操作です');
}
return {post,get};
`;
const validation = `
function validateInput(body) {
  if(!body||typeof body!=='object'||Array.isArray(body)) throw new Error('入力形式が不正です');
  if(typeof body.action!=='string') throw new Error('操作が指定されていません');
  if(body.action!=='saveSettings'&&!/^[A-Za-z0-9_-]{1,80}$/.test(String(body.id||''))) throw new Error('不正なIDです');
  const numeric=new Set(['amount','paidAmount','plannedAmount','actualAmount','balance','day','sort']);
  for(const [key,value] of Object.entries(body)) {
    if(['__proto__','prototype','constructor'].includes(key)) throw new Error('入力形式が不正です');
    if(value!==null&&typeof value==='object') throw new Error('入力値が不正です');
    if(typeof value==='string'&&value.length>(key==='memo'?4000:1000)) throw new Error('入力が長すぎます');
    if(numeric.has(key)&&value!==null&&value!==''&&(typeof value==='boolean'||!Number.isSafeInteger(Number(value)))) throw new Error('数値は整数円で入力してください');
  }
}
`;
fs.writeFileSync(path.join(root,'src/domain/ledger.cjs'), "'use strict';\nconst {randomUUID}=require('node:crypto');\nconst {SHEETS}=require('../contract.cjs');\nmodule.exports=function createLedgerService(repository,{today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}={}) {\nconst getAllRecords=name=>({data:repository.all(name)});\nconst saveRecord=(name,data)=>repository.save(name,data);\nconst deleteRecord=(name,id)=>repository.remove(name,id);\n" + ledger + '\n' + read('holiday.gs') + '\n' + fixed + '\n' + validation + actions + '\n};\n');
console.log('Ported contract and business service; original reviewed sources retained.');
