'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {openStore}=require('../src/storage.cjs'),{createAdmin}=require('../src/auth.cjs'),{createApplication}=require('../src/server.cjs');
test('HTTPS origin: secure Host cookie, login/logout/relogin, Origin and CSRF gates',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cashflow-https-test-')),store=openStore(path.join(dir,'data.sqlite'));
 await createAdmin(store,'synthetic-admin','Synthetic-HTTPS-test-only');
 const origin='https://cashflow.wellzfriend.com';const app=await createApplication({store,origin,today:()=> '2026-12-31'});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=(route,method='GET',headers={},body)=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:route,method,headers:{Host:'cashflow.wellzfriend.com',...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 const loginBody={username:'synthetic-admin',password:'Synthetic-HTTPS-test-only'};
 assert.equal((await request('/auth/login','POST',{'Content-Type':'application/json',Origin:'http://127.0.0.1:3310'},loginBody)).status,403);
 assert.equal((await request('/api/v1?action=getAccounts')).status,401);
 assert.equal((await request('/auth/session','GET',{Cookie:'cashflow_local_session='+'a'.repeat(64)})).status,401);
 let previousCookie;
 for(let i=0;i<2;i++){
  const login=await request('/auth/login','POST',{'Content-Type':'application/json',Origin:origin},loginBody);assert.equal(login.status,200);
  const raw=login.headers['set-cookie'][0];assert.match(raw,/^__Host-cashflow_session=/);assert.match(raw,/; Secure/);assert.match(raw,/; HttpOnly/);assert.match(raw,/; Path=\//);assert.match(raw,/; SameSite=Strict/);assert.doesNotMatch(raw,/Domain=/i);
  const cookie=raw.split(';')[0],csrf=JSON.parse(login.text).csrf;
  if(previousCookie)assert.notEqual(cookie,previousCookie);
  assert.equal((await request('/auth/session','GET',{Cookie:cookie})).status,200);
  const page=await request('/','GET',{Cookie:cookie});assert.equal(page.status,200);assert.match(page.headers['strict-transport-security'],/max-age/);
  assert.equal((await request('/auth/logout','POST',{'Content-Type':'application/json',Origin:origin,Cookie:cookie},{})).status,403);
  assert.equal((await request('/auth/logout','POST',{'Content-Type':'application/json',Origin:'https://wrong.invalid',Cookie:cookie,'X-CSRF-Token':csrf},{})).status,403);
  const logout=await request('/auth/logout','POST',{'Content-Type':'application/json',Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf},{});assert.equal(logout.status,200);assert.match(logout.headers['set-cookie'][0],/Max-Age=0/);
  assert.equal((await request('/auth/session','GET',{Cookie:cookie})).status,401);previousCookie=cookie;
 }
 assert.equal((await request('/','GET',{Host:'127.0.0.1:3310'})).status,421);
});
