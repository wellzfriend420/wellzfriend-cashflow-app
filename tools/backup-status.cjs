'use strict';
const {readStatus}=require('../src/backup.cjs');
const status=readStatus(process.env.BACKUP_STATUS_DIR||'var/backup-status');
console.log(JSON.stringify(status));if(status.state!=='ok')process.exitCode=1;
