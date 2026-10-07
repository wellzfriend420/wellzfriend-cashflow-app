'use strict';
const {openStore}=require('../src/storage.cjs');
const {createAdmin}=require('../src/auth.cjs');
(async()=>{
  const username=process.argv[2];
  if(!username||process.stdin.isTTY) throw new Error('Usage: provide a password on standard input and a username as the first argument');
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1024)throw new Error('Password input too long');}
  const store=openStore(process.env.DATABASE_PATH||'var/data/cashflow.sqlite');
  try{await createAdmin(store,username,input.replace(/\r?\n$/,''));console.log('ADMIN_CREATED');}finally{store.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
