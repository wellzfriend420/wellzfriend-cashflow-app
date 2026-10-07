'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const {atomicJson}=require('../src/backup.cjs');
let child,timer,stopping=false;
function run(){
  child=spawn(process.execPath,[path.join(__dirname,'backup.cjs')],{stdio:'inherit',env:process.env});
  const timeout=setTimeout(()=>{
    console.error('{"event":"backup_timeout"}');child.kill('SIGKILL');
    const file=path.join(process.env.BACKUP_STATUS_DIR||'var/backup-status','status.json');
    try{const previous=JSON.parse(fs.readFileSync(file,'utf8'));atomicJson(file,{...previous,lastResult:'failed',errorCode:'BACKUP_TIMEOUT'});}catch{}
  },10*60*1000);
  child.on('exit',()=>{clearTimeout(timeout);child=null;if(!stopping)schedule();});
}
function schedule(){const next=new Date();next.setMinutes(17,0,0);if(next.getTime()<=Date.now())next.setHours(next.getHours()+1);timer=setTimeout(run,next.getTime()-Date.now());}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopping=true;clearTimeout(timer);if(child)child.kill('SIGTERM');else process.exit(0);});
run();
