const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFrontend}=require('./helpers.cjs');
const {createBackend}=require('./sqlite-helpers.cjs');
test('untrusted names and form values are escaped; Excel preserves literal strings',()=>{
  const f=createFrontend(),name='<img src=x onerror=alert(1)>',partner='\"><svg onload=alert(1)>';
  f.app.accounts=[{id:'a',bank:name,type:'普通',balance:1000,balanceDate:'2026-08-31'}];
  f.app.partners=[{id:'p',name:partner,type:'両方'}];
  f.app.currentMonth='2026-09';f.app.currentMonthData=[{id:'m',type:'入金',source:'manual',status:'予定',account:'a',partner,description:'<script>bad</script>',plannedDate:'2026-09-30',plannedAmount:100}];
  f.context.renderCashflowTable();assert.ok(!f.node('cashflowTableBody').innerHTML.includes('<svg'));assert.match(f.node('cashflowTableHead').innerHTML,/&lt;img/);
  f.context.openTransactionForm('m');
  f.context.renderPartnerList();assert.ok(!f.node('partnerList').innerHTML.includes('<svg'));assert.match(f.node('partnerList').innerHTML,/&lt;svg/);
  f.context.exportCashflowToExcel();
  const XLSX=require('../assets/vendor/xlsx.full.min.js'),sheet=XLSX.utils.aoa_to_sheet(f.captured.rows),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,sheet,'合成');
  const encoded=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),read=XLSX.read(encoded,{type:'buffer'}),rows=XLSX.utils.sheet_to_json(read.Sheets['合成'],{header:1});
  assert.ok(JSON.stringify(rows).includes(partner));
});
test('fixed expense IDs cannot overwrite an unrelated manual record and rollback the master',()=>{
  const b=createBackend();assert.ok(b.post({action:'saveTransaction',id:'fx_master_202609',source:'manual',type:'出金',account:'a',plannedDate:'2026-09-30',plannedAmount:5}).success);
  const result=b.post({action:'saveFixedExpense',id:'master',name:'合成',payee:'合成',amount:10,day:30,startMonth:'2026-09',endMonth:'2026-09',account:'a',holidayRule:'none'});
  assert.match(result.error,/重複/);assert.equal(b.records('fixed_expenses').length,0);assert.equal(b.records('cashflow_transactions')[0].plannedAmount,5);
});
