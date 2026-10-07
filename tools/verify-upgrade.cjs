'use strict';
// Backup snapshot only: never open a live production database.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{createHash}=require('node:crypto');
const {restore}=require('./restore.cjs');
const {createBackup,checksum}=require('../src/backup.cjs');
function digests(file){const db=new DatabaseSync(file,{readOnly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('sessions','login_attempts') ORDER BY name").all().map(({name})=>[name,createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM '+name+' ORDER BY 1').all())).digest('hex')]));}finally{db.close();}}
async function verify(manifestPath,work){
 if(fs.existsSync(work))throw Error('WORK_DIRECTORY_EXISTS');fs.mkdirSync(work,{recursive:true,mode:0o700});
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')),source=path.join(path.dirname(manifestPath),manifest.databaseFile),before=digests(source),sourceHash=checksum(source),databasePath=path.join(work,'upgraded.sqlite');
 await restore(manifestPath,databasePath);const after=digests(databasePath);for(const name of Object.keys(before))assert.equal(after[name],before[name],name+' changed');assert.equal(checksum(source),sourceHash);
 const backupDir=path.join(work,'backup'),m=await createBackup({databasePath,backupDir,statusDir:path.join(work,'status'),prune:false});
 const second=path.join(work,'restored-again.sqlite');await restore(path.join(backupDir,m.id+'.manifest.json'),second);assert.deepEqual(digests(second),after);assert.equal(checksum(source),sourceHash);
 return {result:'PASS',sourceSchema:manifest.schemaVersion,targetSchema:m.schemaVersion,legacyTablesUnchanged:true,administratorPreserved:true,sourceBackupUnchanged:true,newBackupRestore:true};
}
if(require.main===module){const [manifest,work]=process.argv.slice(2);if(!manifest||!work)throw Error('Usage: verify-upgrade.cjs <backup-manifest> <new-isolated-directory>');verify(manifest,work).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={verify};
