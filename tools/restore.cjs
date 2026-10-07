'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const {checksum,inspectSnapshot}=require('../src/backup.cjs');
const {openStore}=require('../src/storage.cjs');
async function restore(manifestPath,target){
  const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(!/^cashflow-\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(m.id)||m.databaseFile!==m.id+'.sqlite')throw new Error('INVALID_MANIFEST');
  const source=path.join(path.dirname(manifestPath),m.databaseFile);
  if(checksum(source)!==m.sha256||fs.statSync(source).size!==m.bytes)throw new Error('CHECKSUM_MISMATCH');
  inspectSnapshot(source,{allowPreviousSchema:true});
  fs.mkdirSync(path.dirname(path.resolve(target)),{recursive:true,mode:0o700});
  // Exclusive reservation: never overwrite an existing database or its sidecars.
  if(['','-wal','-shm','-journal'].some(s=>fs.existsSync(target+s)))throw new Error('TARGET_EXISTS');
  const fd=fs.openSync(target,'wx',0o600);fs.closeSync(fd);
  let sourceDb;
  try{
    sourceDb=new DatabaseSync(source,{readOnly:true});await backup(sourceDb,target,{rate:128});sourceDb.close();sourceDb=null;
    const restored=openStore(target);
    try{restored.db.exec('BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM login_attempts; COMMIT;');}finally{restored.close();}
    const summary=inspectSnapshot(target);fs.chmodSync(target,0o600);return summary;
  }catch(error){if(sourceDb)sourceDb.close();throw error;}
}
if(require.main===module){const [manifest,target]=process.argv.slice(2);if(!manifest||!target){console.error('Usage: node tools/restore.cjs <manifest.json> <new-database-path>');process.exitCode=1;}else restore(manifest,target).then(()=>console.log('RESTORE_VERIFIED')).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={restore};
