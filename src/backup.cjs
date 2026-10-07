'use strict';
const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { COLUMNS } = require('./contract.cjs');
const { SCHEMA_VERSION } = require('./storage.cjs');
const version = require('../package.json').version;
const stamp = date => date.toISOString().replace(/[-:.]/g, '');
const safeName = /^cashflow-\d{8}T\d{9}Z-[a-f0-9]{8}$/;
function atomicJson(file, data) {
  const temp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function checksum(file) { const h = createHash('sha256'), fd = fs.openSync(file, 'r'), chunk = Buffer.alloc(1024 * 1024); try { let n; while ((n = fs.readSync(fd, chunk, 0, chunk.length, null))) h.update(chunk.subarray(0, n)); } finally { fs.closeSync(fd); } return h.digest('hex'); }
function inspectSnapshot(file, {allowPreviousSchema=false} = {}) {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')) throw new Error('INTEGRITY_FAILED');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('FOREIGN_KEY_FAILED');
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersion !== SCHEMA_VERSION && !(allowPreviousSchema && [1,2,3].includes(schemaVersion))) throw new Error('SCHEMA_MISMATCH');
    const counts = Object.fromEntries(Object.keys(COLUMNS).map(table => [table, db.prepare(`SELECT count(*) n FROM "${table}"`).get().n]));
    if(schemaVersion>=3){for(const table of require('./schedule-schema.cjs').tables) counts[table]=db.prepare('SELECT count(*) n FROM '+table).get().n; require('./domain/schedules.cjs').checkIntegrity(db);}
    if(schemaVersion>=4){for(const table of require('./correction-schema.cjs').tables) counts[table]=db.prepare('SELECT count(*) n FROM '+table).get().n;require('./correction-schema.cjs').checkIntegrity(db);}
    const totals = {};
    for (const [table, source] of [['receivables','receivable'],['payables','payable']]) {
      const invalid = db.prepare(`SELECT count(*) n FROM "${table}" d LEFT JOIN cashflow_transactions t ON t.id=d.cfId WHERE t.id IS NULL OR t.source<>? OR t.sourceId<>d.id OR t.plannedAmount<>d.amount-d.paidAmount OR d.paidAmount<>COALESCE((SELECT SUM(p.actualAmount) FROM cashflow_transactions p WHERE p.source=? AND p.sourceId=d.id),0)`).get(source, source + '_payment').n;
      if (invalid) throw new Error('LEDGER_INTEGRITY_FAILED');
      totals[table] = db.prepare(`SELECT COALESCE(SUM(amount),0) amount,COALESCE(SUM(paidAmount),0) paid,COALESCE(SUM(amount-paidAmount),0) outstanding FROM "${table}"`).get();
    }
    totals.accounts = db.prepare('SELECT COALESCE(SUM(balance),0) balance FROM accounts').get();
    return { schemaVersion, counts, totals, integrity: 'ok', foreignKeys: 'ok', ledger: 'ok' };
  } finally { db.close(); }
}
function readStatus(statusDir, now = Date.now()) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(path.join(statusDir, 'status.json'), 'utf8')); } catch {}
  const last = Date.parse(data.lastSuccessAt || '');
  return { state: data.lastResult === 'failed' ? 'failed' : !Number.isFinite(last) ? 'missing' : now - last > 90 * 60000 ? 'stale' : 'ok', lastSuccessAt: data.lastSuccessAt || null, lastAttemptAt: data.lastAttemptAt || null, errorCode: data.errorCode || null, externalBackup: 'not_configured' };
}
function listCompleted(directory) {
  return fs.readdirSync(directory).filter(name => name.endsWith('.manifest.json') && safeName.test(name.slice(0, -14))).flatMap(name => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      const base = name.slice(0, -14);
      if (m.id !== base || m.databaseFile !== base + '.sqlite' || !Number.isFinite(Date.parse(m.createdAt)) || !fs.existsSync(path.join(directory, m.databaseFile)) || !fs.existsSync(path.join(directory, base + '.sha256'))) return [];
      return [m];
    } catch { return []; }
  }).sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt));
}
function selectRetained(manifests, hourly = 48, daily = 14) {
  const keep = new Set(), hours = new Set(), days = new Set();
  for (const m of manifests) {
    const date = new Date(m.createdAt), hour = date.toISOString().slice(0,13);
    const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
    if (hours.size < hourly && !hours.has(hour)) { hours.add(hour); keep.add(m.id); }
    if (days.size < daily && !days.has(day)) { days.add(day); keep.add(m.id); }
  }
  if (manifests[0]) keep.add(manifests[0].id);
  return keep;
}
async function createBackup({ databasePath, backupDir, statusDir, now = new Date(), prune = true }) {
  fs.mkdirSync(statusDir, {recursive:true,mode:0o700});
  let oldStatus = {};
  try { oldStatus = JSON.parse(fs.readFileSync(path.join(statusDir,'status.json'),'utf8')); } catch {}
  const attempt = now.toISOString(), lock = path.join(statusDir,'backup.lock');
  let lockFd, source, temporary;
  try {
    lockFd = fs.openSync(lock,'wx',0o600);
    fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid,startedAt:attempt}));
    atomicJson(path.join(statusDir,'status.json'),{...oldStatus,lastAttemptAt:attempt,lastResult:'running',errorCode:null});
    fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
    const id = 'cashflow-' + stamp(now) + '-' + randomBytes(4).toString('hex');
    const file = path.join(backupDir,id+'.sqlite');
    temporary = file + '.partial';
    source = new DatabaseSync(databasePath,{readOnly:true,timeout:5000});
    await backup(source,temporary,{rate:128});
    source.close(); source=null;
    // Normalize only the completed offline snapshot, never the running source DB.
    // A DELETE-journal snapshot restores from a read-only mount without WAL/SHM files.
    const snapshot=new DatabaseSync(temporary,{timeout:5000});
    try { snapshot.exec('PRAGMA journal_mode=DELETE;'); } finally { snapshot.close(); }
    fs.chmodSync(temporary,0o600);
    const report = inspectSnapshot(temporary);
    const sha256 = checksum(temporary), size = fs.statSync(temporary).size;
    const fd=fs.openSync(temporary,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,file); temporary=null;
    fs.writeFileSync(path.join(backupDir,id+'.sha256'),sha256+'  '+id+'.sqlite\n',{mode:0o600,flag:'wx'});
    const manifest = {id,createdAt:attempt,appVersion:version,databaseFile:id+'.sqlite',bytes:size,sha256,...report};
    // Manifest is the completion marker consumed by future off-site transfer.
    atomicJson(path.join(backupDir,id+'.manifest.json'),manifest);
    if (prune) {
      const manifests=listCompleted(backupDir),keep=selectRetained(manifests);
      const expired=manifests.filter(m=>!keep.has(m.id));
      if(expired.length>100) throw new Error('PRUNE_LIMIT_EXCEEDED');
      for(const m of expired) for(const suffix of ['.manifest.json','.sha256','.sqlite']) fs.unlinkSync(path.join(backupDir,m.id+suffix));
    }
    atomicJson(path.join(statusDir,'status.json'),{lastAttemptAt:attempt,lastSuccessAt:attempt,lastResult:'success',errorCode:null,lastBackupId:id});
    return manifest;
  } catch(error) {
    const code = error.code === 'EEXIST' && lockFd === undefined ? 'BACKUP_LOCKED' : ['INTEGRITY_FAILED','FOREIGN_KEY_FAILED','LEDGER_INTEGRITY_FAILED','SCHEMA_MISMATCH','PRUNE_LIMIT_EXCEEDED'].includes(error.message) ? error.message : 'BACKUP_FAILED';
    try { atomicJson(path.join(statusDir,'status.json'),{...oldStatus,lastAttemptAt:attempt,lastResult:'failed',errorCode:code}); } catch {}
    const wrapped=new Error(code,{cause:error});wrapped.code=code;throw wrapped;
  } finally {
    if(source) source.close();
    if(temporary) { try { fs.unlinkSync(temporary); } catch {} }
    if(lockFd!==undefined){fs.closeSync(lockFd);fs.unlinkSync(lock);}
  }
}
module.exports={createBackup,readStatus,inspectSnapshot,checksum,listCompleted,selectRetained,atomicJson};
