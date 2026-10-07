'use strict';
const tables=['payment_schedules','payment_schedule_occurrences','payment_schedule_legs'];
function migrateSchedules(db){
 if(db.prepare('PRAGMA user_version').get().user_version>=3)return;
 // SQLite's documented table rebuild: disable FKs outside the transaction;
 // keep the original table name in all referencing schemas.
 db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
 try{
  const sql=db.prepare("SELECT sql FROM sqlite_schema WHERE name='cashflow_transactions'").get().sql;
  db.exec(sql.replace(/CREATE TABLE\s+"?cashflow_transactions"?/,'CREATE TABLE cashflow_transactions_new').replace("'payable_payment'))","'payable_payment','payment_schedule'))"));
  db.exec('INSERT INTO cashflow_transactions_new SELECT * FROM cashflow_transactions; DROP TABLE cashflow_transactions; ALTER TABLE cashflow_transactions_new RENAME TO cashflow_transactions;');
  db.exec(`CREATE INDEX cashflow_planned ON cashflow_transactions(plannedDate);
   CREATE INDEX cashflow_actual ON cashflow_transactions(actualDate);
   CREATE INDEX cashflow_account ON cashflow_transactions(account);
   CREATE INDEX cashflow_source ON cashflow_transactions(source,sourceId);
   CREATE TABLE payment_schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('loan','lease','installment','insurance','other')),
    account TEXT NOT NULL REFERENCES accounts(id), partner TEXT NOT NULL,
    defaultDebitMode TEXT NOT NULL CHECK(defaultDebitMode IN ('combined','split','single')),
    holidayRule TEXT NOT NULL CHECK(holidayRule IN ('none','next','previous')),
    principalStartMode TEXT CHECK(principalStartMode IN ('new','existing')),
    originalPrincipal INTEGER CHECK(originalPrincipal>=0 AND originalPrincipal<=9007199254740991), loanDate TEXT,
    principalBalanceDate TEXT, principalOpeningBalance INTEGER CHECK(principalOpeningBalance>=0 AND principalOpeningBalance<=9007199254740991),
    memo TEXT NOT NULL, archivedAt TEXT, version INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    CHECK(kind<>'loan' OR (principalStartMode IS NOT NULL AND principalBalanceDate IS NOT NULL AND principalOpeningBalance IS NOT NULL)),
    CHECK(kind='loan' OR defaultDebitMode='single')
   ) STRICT;
   CREATE TABLE payment_schedule_occurrences (
    id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL REFERENCES payment_schedules(id),
    name TEXT NOT NULL, kind TEXT NOT NULL, account TEXT NOT NULL REFERENCES accounts(id), partner TEXT NOT NULL,
    nominalDate TEXT NOT NULL, paymentDate TEXT NOT NULL, holidayRule TEXT NOT NULL,
    debitModeOverride TEXT CHECK(debitModeOverride IN ('combined','split')),
    effectiveDebitMode TEXT NOT NULL CHECK(effectiveDebitMode IN ('combined','split','single')),
    plannedAmount INTEGER CHECK(plannedAmount>0 AND plannedAmount<=9007199254740991),
    plannedPrincipal INTEGER CHECK(plannedPrincipal>=0 AND plannedPrincipal<=9007199254740991),
    plannedInterest INTEGER CHECK(plannedInterest>=0 AND plannedInterest<=9007199254740991),
    revision INTEGER NOT NULL, version INTEGER NOT NULL, cancelledAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    CHECK((kind='loan' AND plannedAmount IS NULL AND plannedPrincipal IS NOT NULL AND plannedInterest IS NOT NULL AND plannedPrincipal+plannedInterest>0 AND plannedPrincipal+plannedInterest<=9007199254740991) OR
          (kind<>'loan' AND plannedAmount IS NOT NULL AND plannedPrincipal IS NULL AND plannedInterest IS NULL))
   ) STRICT;
   CREATE INDEX schedule_occurrence_parent ON payment_schedule_occurrences(scheduleId,paymentDate);
   CREATE TABLE payment_schedule_legs (
    id TEXT PRIMARY KEY, occurrenceId TEXT NOT NULL REFERENCES payment_schedule_occurrences(id), revision INTEGER NOT NULL,
    component TEXT NOT NULL CHECK(component IN ('total','principal','interest')),
    transactionId TEXT NOT NULL UNIQUE REFERENCES cashflow_transactions(id),
    actualPrincipal INTEGER CHECK(actualPrincipal>=0 AND actualPrincipal<=9007199254740991),
    actualInterest INTEGER CHECK(actualInterest>=0 AND actualInterest<=9007199254740991),
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    UNIQUE(occurrenceId,revision,component)
   ) STRICT;
   PRAGMA user_version=3;`);
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Migration foreign key check failed');
  db.exec('COMMIT');
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
 finally{db.exec('PRAGMA foreign_keys=ON');}
}
module.exports={migrateSchedules,tables};
