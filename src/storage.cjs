'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { COLUMNS } = require('./contract.cjs');
const numeric = new Set(['plannedAmount', 'actualAmount', 'amount', 'paidAmount', 'balance', 'sort', 'day', 'active']);
const SCHEMA_VERSION = 4;

function openStore(filename, { readOnly = false } = {}) {
  if (!readOnly && filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename, { readOnly, timeout: 5000, enableForeignKeyConstraints: true });
  try {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    migrate(db);
    require('./schedule-schema.cjs').migrateSchedules(db);
    require('./correction-schema.cjs').migrateCorrections(db);
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
  }
  } catch (error) { db.close(); throw error; }
  let depth = 0;
  const assertTable = name => { if (!Object.hasOwn(COLUMNS, name)) throw new Error('Invalid repository table'); };
  const decode = row => row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === 'active' && v !== null ? Boolean(v) : v])) : null;
  const api = {
    db, filename,
    all(name) { assertTable(name); return db.prepare(`SELECT * FROM "${name}" ORDER BY ${name === 'accounts' ? 'COALESCE(sort,0),createdAt,id' : name === 'settings' ? 'key' : 'createdAt,id'}`).all().map(decode); },
    find(name, id) { assertTable(name); return decode(db.prepare(`SELECT * FROM "${name}" WHERE ${name === 'settings' ? 'key' : 'id'}=?`).get(id ?? '')); },
    transactionsForMonth(month) {
      if (!month) return api.all('cashflow_transactions');
      return db.prepare(`SELECT * FROM cashflow_transactions WHERE (actualDate >= ? AND actualDate < ?) OR (actualDate IS NULL AND plannedDate >= ? AND plannedDate < ?) ORDER BY createdAt,id`).all(month + '-01', month + '-32', month + '-01', month + '-32').map(decode);
    },
    save(name, data) {
      assertTable(name);
      if (!depth || name === 'settings') throw new Error('Transactional write required');
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(String(data.id || ''))) throw new Error('不正なIDです');
      const previous = api.find(name, data.id) || {};
      const record = Object.fromEntries(COLUMNS[name].map(k => [k, data[k] === undefined ? (previous[k] ?? null) : data[k]]));
      record.createdAt = previous.createdAt || new Date().toISOString();
      record.updatedAt = new Date(Math.max(Date.now(), (Date.parse(previous.updatedAt) || 0) + 1)).toISOString();
      const cols = COLUMNS[name];
      db.prepare(`INSERT INTO "${name}" (${cols.map(k => `"${k}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter(k => k !== 'id').map(k => `"${k}"=excluded."${k}"`).join(',')}`).run(...cols.map(k => {
        const value = record[k];
        if (value == null || value === '') return null;
        return numeric.has(k) ? Number(value) : String(value);
      }));
      return { success: true, id: record.id, updatedAt: record.updatedAt };
    },
    remove(name, id) {
      assertTable(name); if (!depth || name === 'settings') throw new Error('Transactional write required');
      const result = db.prepare(`DELETE FROM "${name}" WHERE id=?`).run(id);
      return { success: true, id, alreadyDeleted: result.changes === 0 };
    },
    readTransaction(work) {
      if(depth || db.isTransaction) return work();
      db.exec('BEGIN');
      try {const result=work();db.exec('COMMIT');return result;}
      catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    },
    transaction(work) {
      if (depth) return work();
      db.exec('BEGIN IMMEDIATE'); depth++;
      try { const result = work(); if (result && typeof result.then === 'function') throw new Error('Repository transactions must be synchronous'); db.exec('COMMIT'); return result; }
      catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
      finally { depth--; }
    },
    setting(key) { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; },
    saveSetting(key, value) { if (!depth) throw new Error('Transactional write required'); db.prepare('INSERT INTO settings(key,value,updatedAt) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt').run(key, value, new Date().toISOString()); },
    audit(actor, action, target) { db.prepare('INSERT INTO audit_events(actor,action,target,createdAt) VALUES(?,?,?,?)').run(actor, action, target, new Date().toISOString()); },
    close() { db.close(); }
  };
  return api;
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) throw new Error('Database schema is newer than this application');
  if (version >= 2) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version === 1) {
      db.exec(`ALTER TABLE accounts ADD COLUMN branch TEXT;
        ALTER TABLE accounts ADD COLUMN accountNumber TEXT;
        UPDATE accounts SET bank=COALESCE(NULLIF(TRIM(bank),''),NULLIF(TRIM(name),''),'未設定');
        ALTER TABLE accounts DROP COLUMN name;
        PRAGMA user_version=2;`);
      db.exec('COMMIT');
      return;
    }
    for (const [name, cols] of Object.entries(COLUMNS)) {
      const definitions = cols.map(k => {
        if (k === 'id' || (name === 'settings' && k === 'key')) return `"${k}" TEXT PRIMARY KEY NOT NULL`;
        let part = `"${k}" ${numeric.has(k) ? 'INTEGER' : 'TEXT'}`;
        if (['createdAt', 'updatedAt'].includes(k)) part += ' NOT NULL';
        if (numeric.has(k)) part += ` CHECK("${k}" IS NULL OR "${k}" BETWEEN -9007199254740991 AND 9007199254740991)`;
        if (k === 'account') part += ' NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT';
        if (k === 'cfId') part += ' NOT NULL REFERENCES cashflow_transactions(id) DEFERRABLE INITIALLY DEFERRED';
        return part;
      });
      if (name === 'cashflow_transactions') {
        definitions.push("CHECK(source IN ('manual','receivable','payable','fixed_expense','receivable_payment','payable_payment'))", "CHECK(status IN ('予定','確定','取消','完了'))", "CHECK(type IN ('入金','出金'))", "CHECK(plannedAmount IS NULL OR plannedAmount>=0)", "CHECK(actualAmount IS NULL OR actualAmount>=0)", "CHECK((actualDate IS NULL AND actualAmount IS NULL) OR (actualDate IS NOT NULL AND actualAmount IS NOT NULL AND status='確定'))");
      }
      if (['receivables','payables'].includes(name)) definitions.push('CHECK(amount>0)', 'CHECK(paidAmount>=0 AND paidAmount<=amount)');
      if (name === 'fixed_expenses') definitions.push('CHECK(amount>0)', 'CHECK(day BETWEEN 1 AND 31)', 'CHECK(active IN (0,1))');
      db.exec(`CREATE TABLE "${name}" (${definitions.join(',')}) STRICT`);
    }
    db.exec(`
      CREATE INDEX cashflow_planned ON cashflow_transactions(plannedDate);
      CREATE INDEX cashflow_actual ON cashflow_transactions(actualDate);
      CREATE INDEX cashflow_account ON cashflow_transactions(account);
      CREATE INDEX cashflow_source ON cashflow_transactions(source,sourceId);
      CREATE INDEX receivable_due ON receivables(dueDate);
      CREATE INDEX payable_due ON payables(dueDate);
      CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,passwordHash TEXT NOT NULL,role TEXT NOT NULL CHECK(role='admin'),createdAt TEXT NOT NULL) STRICT;
      CREATE TABLE sessions(tokenHash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,createdAt INTEGER NOT NULL,lastSeen INTEGER NOT NULL,expiresAt INTEGER NOT NULL) STRICT;
      CREATE INDEX sessions_expiry ON sessions(expiresAt);
      CREATE TABLE login_attempts(bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,windowStart INTEGER NOT NULL) STRICT;
      CREATE TABLE audit_events(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,createdAt TEXT NOT NULL) STRICT;
      PRAGMA user_version=2;
    `);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
module.exports = { openStore, SCHEMA_VERSION };
