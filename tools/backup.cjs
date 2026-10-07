'use strict';
const {createBackup}=require('../src/backup.cjs');
createBackup({databasePath:process.env.DATABASE_PATH||'var/data/cashflow.sqlite',backupDir:process.env.BACKUP_DIR||'var/backups',statusDir:process.env.BACKUP_STATUS_DIR||'var/backup-status'})
 .then(result=>console.log(JSON.stringify({event:'backup_success',id:result.id,bytes:result.bytes})))
 .catch(error=>{console.error(JSON.stringify({event:'backup_failed',code:error.code||'BACKUP_FAILED'}));process.exitCode=1;});
