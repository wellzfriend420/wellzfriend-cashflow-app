'use strict';
const {createHash}=require('node:crypto');
const tables=['transaction_origins','transaction_revisions'];
function migrateCorrections(db){
 if(db.prepare('PRAGMA user_version').get().user_version>=4)return;
 db.exec('BEGIN IMMEDIATE');
 try{
  db.exec(`CREATE TABLE transaction_origins (
   transactionId TEXT PRIMARY KEY REFERENCES cashflow_transactions(id) ON DELETE RESTRICT,
   kind TEXT NOT NULL CHECK(kind IN ('migration','plan','direct')),
   migrationId TEXT, fileHash TEXT, sourceFile TEXT, sheet TEXT, cell TEXT,
   originalJson TEXT NOT NULL CHECK(json_valid(originalJson)), planJson TEXT CHECK(planJson IS NULL OR json_valid(planJson)),
   createdAt TEXT NOT NULL,
   UNIQUE(migrationId,fileHash,sheet,cell),
   CHECK(kind<>'migration' OR (migrationId IS NOT NULL AND fileHash IS NOT NULL AND sheet IS NOT NULL AND cell IS NOT NULL AND planJson IS NULL))
  ) STRICT;
  CREATE TABLE transaction_revisions (
   requestId TEXT PRIMARY KEY, requestHash TEXT NOT NULL,
   transactionId TEXT NOT NULL REFERENCES cashflow_transactions(id) ON DELETE RESTRICT,
   action TEXT NOT NULL CHECK(action IN ('correctActual','cancelActual','reopenActual')),
   actorId TEXT NOT NULL, actorName TEXT NOT NULL, reason TEXT NOT NULL,
   beforeJson TEXT NOT NULL CHECK(json_valid(beforeJson)), afterJson TEXT NOT NULL CHECK(json_valid(afterJson)),
   createdAt TEXT NOT NULL
  ) STRICT;
  CREATE INDEX transaction_revision_target ON transaction_revisions(transactionId,createdAt);
  CREATE TRIGGER origin_no_update BEFORE UPDATE ON transaction_origins BEGIN SELECT RAISE(ABORT,'Origin is immutable'); END;
  CREATE TRIGGER origin_no_delete BEFORE DELETE ON transaction_origins BEGIN SELECT RAISE(ABORT,'Origin is immutable'); END;
  CREATE TRIGGER revision_no_update BEFORE UPDATE ON transaction_revisions BEGIN SELECT RAISE(ABORT,'History is immutable'); END;
  CREATE TRIGGER revision_no_delete BEFORE DELETE ON transaction_revisions BEGIN SELECT RAISE(ABORT,'History is immutable'); END;`);
  const insert=db.prepare('INSERT INTO transaction_origins VALUES(?,?,?,?,?,?,?,?,?,?)');
  const now=new Date().toISOString();
  for(const s of db.prepare("SELECT * FROM settings WHERE key LIKE 'migration:%'").all()){
   const m=JSON.parse(s.value);
   if(!m.completedAt||!Array.isArray(m.transactionIds)||m.count!==m.transactionIds.length)throw Error('移行完了情報を確認してください');
   for(const id of m.transactionIds){
    const t=db.prepare('SELECT * FROM cashflow_transactions WHERE id=?').get(id);
    const sheet=t?.memo?.match(/シート=([^;]+);/)?.[1],cell=t?.memo?.match(/セル=([^;]+);/)?.[1];
    const expected='xl_'+createHash('sha256').update(`${m.sourceSha256}|${sheet}|${cell}`).digest('hex');
    if(!t||id!==expected||!sheet||!cell)throw Error('移行元明細を照合できません。更新を中止しました');
    insert.run(id,'migration',m.caseId,m.sourceSha256,m.sourceFile,sheet,cell,JSON.stringify(t),null,now);
   }
  }
  db.exec('PRAGMA user_version=4');
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('訂正履歴の参照整合性エラー');
  db.exec('COMMIT');
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
}
function checkIntegrity(db){
 const bad=db.prepare(`SELECT count(*) n FROM transaction_origins o JOIN cashflow_transactions t ON t.id=o.transactionId
 WHERE json_extract(o.originalJson,'$.id')<>t.id OR json_extract(o.originalJson,'$.source')<>t.source
 OR coalesce(json_extract(o.originalJson,'$.sourceId'),'')<>coalesce(t.sourceId,'')`).get().n;
 if(bad)throw Error('訂正元情報の整合性エラー');
 for(const s of db.prepare("SELECT value FROM settings WHERE key LIKE 'migration:%'").all()){
  const m=JSON.parse(s.value);
  for(const id of m.transactionIds||[]){
   const o=db.prepare('SELECT * FROM transaction_origins WHERE transactionId=?').get(id);
   if(!o||o.migrationId!==m.caseId||o.fileHash!==m.sourceSha256||id!=='xl_'+createHash('sha256').update(`${o.fileHash}|${o.sheet}|${o.cell}`).digest('hex'))throw Error('移行元情報の整合性エラー');
  }
 }
}
module.exports={migrateCorrections,checkIntegrity,tables};
