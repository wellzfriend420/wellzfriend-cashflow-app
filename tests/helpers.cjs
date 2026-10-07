const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = x => JSON.parse(JSON.stringify(x));

function createBackend() {
  let tables = {}, definitions = {}, batchCount = 0, failNext = false, loseResponse = false, locked = false, lastRequests = [];
  const sheets = {};
  const ss = { getId: () => 'synthetic-sheet', getSheetByName: name => sheets[name] };
  const context = vm.createContext({ Date, console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'synthetic-sheet' }) },
    SpreadsheetApp: { openById: () => ss },
    Utilities: { getUuid: () => 'synthetic-uuid', formatDate: date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) },
    LockService: { getScriptLock: () => ({ waitLock() { if (locked) throw new Error('Nested lock'); locked = true; }, releaseLock() { locked = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: () => ({ text: '', setMimeType() { return this; }, setContent(text) { this.text = text; return this; } }) },
    Sheets: { Spreadsheets: { batchUpdate({ requests }) {
      lastRequests = clone(requests);
      if (failNext) { failNext = false; throw new Error('Injected storage failure'); }
      const next = clone(tables);
      for (const request of requests) {
        if (!request.updateCells) continue;
        const { range, rows } = request.updateCells;
        const name = Object.keys(definitions)[range.sheetId - 1];
        const target = next[name];
        for (let row = range.startRowIndex; row < range.endRowIndex; row++) {
          target[row] = Array.from({ length: range.endColumnIndex }, (_, col) => {
            const value = rows[row - 1]?.values[col]?.userEnteredValue;
            return value ? (value.stringValue ?? value.numberValue ?? value.boolValue) : '';
          });
        }
        while (target.length > 1 && target.at(-1).every(value => value === '')) target.pop();
      }
      tables = next; batchCount++;
      if (loseResponse) { loseResponse = false; throw new Error('Injected lost response after commit'); }
    } } }
  });
  for (const name of ['main.gs', 'spreadsheet.gs', 'transactions.gs', 'holiday.gs', 'fixedExpense.gs', 'ledger.gs', 'setup.gs']) {
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name });
  }
  definitions = clone(vm.runInContext('COLUMNS', context));
  Object.entries(definitions).forEach(([name, cols], i) => {
    tables[name] = [cols];
    sheets[name] = { getDataRange: () => ({ getValues: () => clone(tables[name]) }), getSheetId: () => i + 1,
      getMaxRows: () => 1000, getLastRow: () => tables[name].length };
  });
  vm.runInContext("getTodayKey = () => '2026-09-17'", context);
  const api = {
    context,
    post(body) { return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text); },
    get(action, parameters = {}) { return JSON.parse(context.doGet({ parameter: { action, ...parameters } }).text); },
    records(name) { return clone(context.getAllRecords(name).data); },
    failNext() { failNext = true; }, loseNextResponse() { loseResponse = true; },
    get batchCount() { return batchCount; }, get lastRequests() { return lastRequests; },
    get locked() { return locked; }, snapshot: () => clone(tables),
    seed(name, record) { tables[name].push(definitions[name].map(key => record[key] ?? '')); }
  };
  api.post({ action: 'saveAccount', id: 'a', name: '合成口座A', type: '普通', balance: 1000, balanceDate: '2026-08-31' });
  api.post({ action: 'saveAccount', id: 'b', name: '合成口座B', type: '現金', balance: 2000, balanceDate: '2026-08-31' });
  return api;
}

function createFrontend(backend) {
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-09-17T03:00:00Z'])); }
    static now() { return Date.parse('2026-09-17T03:00:00Z'); }
  }
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', innerHTML: '', dataset: {}, style: {},
      classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], appendChild() {}, remove() {}, addEventListener() {} });
    return nodes.get(id);
  };
  const document = { getElementById: node, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => node('new-' + nodes.size), body: node('body'), addEventListener() {} };
  const captured = {};
  const context = vm.createContext({ Date: ClockDate, Intl, URL, console, document, setTimeout: () => 0,
    location: {origin:'http://127.0.0.1:3310',replace() {}}, localStorage: { getItem: () => '', setItem() {} }, confirm: () => true,
    CashflowMath: require('../assets/cashflow-math.js'),
    XLSX: { utils: { aoa_to_sheet: rows => (captured.rows = rows, {}), book_new: () => ({}), book_append_sheet() {} }, writeFile: (_, name) => { captured.filename = name; } },
    fetch: async (url, options = {}) => {
      if (!backend) throw new Error('No backend');
      const result = options.method === 'POST' ? backend.post(JSON.parse(options.body)) : backend.get(new URL(url).searchParams.get('action'), Object.fromEntries(new URL(url).searchParams));
      return { ok: true, json: async () => result };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8'), context, { filename: 'assets/app.js' });
  const app = vm.runInContext('APP', context);
  if (backend) {app.gasUrl = 'https://synthetic.invalid/api';app.csrf='synthetic-csrf';}
  return { context, app, node, captured, run: code => vm.runInContext(code, context) };
}
module.exports = { createBackend, createFrontend, clone };
