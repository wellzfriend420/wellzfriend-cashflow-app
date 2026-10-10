'use strict';
process.env.TZ = 'Asia/Tokyo';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./storage.cjs');
const createLedger = require('./domain/ledger.cjs');
const { createAuth } = require('./auth.cjs');
const { readStatus } = require('./backup.cjs');
const {timingSafeEqual}=require('node:crypto');
const {createNotifications}=require('./direct-debit.cjs');
const root = path.resolve(__dirname, '..');
const files = new Map(['index.html','login.html','assets/styles.css','assets/app.js','assets/overdue.js','assets/corrections.js','assets/schedules.js','assets/schedule-input.js','assets/login.js','assets/direct-debit.js','assets/cashflow-math.js','assets/vendor/xlsx.full.min.js'].map(file => ['/' + file, path.join(root, file)]));
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
function fault(status, message) { return Object.assign(new Error(message), {status}); }
async function readBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fault(415,'送信形式が不正です');
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=chunk.length; if(size>1048576) throw fault(413,'入力が大きすぎます'); chunks.push(chunk); }
  try { const value=JSON.parse(Buffer.concat(chunks).toString('utf8')); if(!value||typeof value!=='object'||Array.isArray(value)) throw 0; return value; }
  catch { throw fault(400,'入力形式が不正です'); }
}
async function createApplication(options = {}) {
  const origin = new URL(options.origin || process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:3310');
  const secure = origin.protocol === 'https:';
  const notificationOptions=options.notifications||{allowed:process.env.DIRECT_DEBIT_NOTIFICATIONS==='true',token:process.env.DIRECT_DEBIT_API_TOKEN||'',target:process.env.DIRECT_DEBIT_LINE_TARGET||''};
  if(notificationOptions.allowed&&(!/^[A-Za-z0-9_-]{32,128}$/.test(notificationOptions.token||'')||!secure))throw new Error('Notification HTTPS and strong token are required');
  const companyName=options.companyName||process.env.APP_COMPANY_NAME||'ウェルノット資金繰り';
  if(typeof companyName!=='string'||!companyName.trim()||companyName.length>120)throw new Error('Invalid company name');
  const escapedCompany=companyName.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if(origin.pathname!=='/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('PUBLIC_ORIGIN must be an origin');
  if(!secure && !['127.0.0.1','localhost','[::1]'].includes(origin.hostname)) throw new Error('HTTPS is required outside localhost');
  const store=options.store || openStore(process.env.DATABASE_PATH || path.join(root,'var/data/cashflow.sqlite'));
  const ledger=createLedger(store,{...(options.today?{today:options.today}:{}),companyName}), auth=await createAuth(store,{secure});
  const notifications=createNotifications(store,ledger,{...notificationOptions,origin:origin.origin,companyName});
  let maintenanceDay='';
  const currentDay=()=>options.today?options.today():new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const maintain=()=>{try{if(maintenanceDay!==currentDay()){ledger.replenish();maintenanceDay=currentDay();}}catch{console.error('{"event":"fixed_expense_maintenance_failed"}');}};
  maintain(); const maintenanceTimer=setInterval(maintain,60000); maintenanceTimer.unref();
  const statusDir=options.statusDir || process.env.BACKUP_STATUS_DIR || path.join(root,'var/backup-status');
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    // Legacy event handlers are retained; scripts and network requests stay same-origin.
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    if(secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url=new URL(req.url,origin);
      if(url.pathname==='/healthz' && req.method==='GET') {
        store.db.prepare('SELECT 1').get(); return json(res,maintenanceDay===currentDay()?200:503,{status:maintenanceDay===currentDay()?'ok':'maintenance_failed'});
      }
      if(req.headers.host!==origin.host) throw fault(421,'接続先が一致しません');
      if(url.pathname.startsWith('/integrations/direct-debit/')){
        if(!notificationOptions.allowed)throw fault(404,'見つかりません');
        const expected=Buffer.from('Bearer '+notificationOptions.token),received=Buffer.from(req.headers.authorization||'');
        if(received.length!==expected.length||!timingSafeEqual(received,expected))throw fault(401,'認証できません');
        if(req.method!=='POST')throw fault(405,'この操作は利用できません');
        const body=await readBody(req);
        if(url.pathname==='/integrations/direct-debit/prepare')return json(res,200,notifications.prepare());
        if(url.pathname==='/integrations/direct-debit/ack')return json(res,200,notifications.acknowledge(body));
        throw fault(404,'見つかりません');
      }
      if(!['GET','POST','HEAD'].includes(req.method)) throw fault(405,'この操作は利用できません');
      if(req.method==='POST' && req.headers.origin!==origin.origin) throw fault(403,'接続元を確認できません。画面を開き直してください');
      if(req.headers['sec-fetch-site']==='cross-site') throw fault(403,'接続元を確認できません');
      if(url.pathname==='/auth/login' && req.method==='POST') {
        const body=await readBody(req), result=await auth.login(body.username,body.password,req.socket.remoteAddress);
        if(result.token) res.setHeader('Set-Cookie',auth.cookie(result.token));
        return json(res,result.status,result.error?{error:result.error}:{success:true,csrf:result.csrf,username:result.username});
      }
      const session=auth.session(req,{touch:url.pathname!=='/api/v1/backup-status'});
      if(url.pathname==='/auth/session' && req.method==='GET') {
        if(!session) throw fault(401,'ログインしてください');
        return json(res,200,{csrf:session.csrf,username:session.username});
      }
      if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
        if(!session) throw fault(401,'ログインしてください');
        if(req.method==='POST' && !auth.csrf(req,session)) throw fault(403,'画面を再読み込みしてください');
        if(url.pathname==='/auth/logout' && req.method==='POST') { auth.logout(session);res.setHeader('Set-Cookie',auth.cookie('',0));return json(res,200,{success:true}); }
        if(url.pathname==='/auth/password' && req.method==='POST') {
          const body=await readBody(req);await auth.changePassword(session,body.currentPassword,body.newPassword);
          res.setHeader('Set-Cookie',auth.cookie('',0));return json(res,200,{success:true});
        }
        if(url.pathname==='/api/v1/backup-status' && req.method==='GET') return json(res,200,readStatus(statusDir));
        if(url.pathname!=='/api/v1') throw fault(404,'見つかりません');
        if(req.method==='GET'&&url.searchParams.get('action')==='getDirectDebitNotification')return json(res,200,notifications.settings());
        if(req.method==='GET') return json(res,200,ledger.get(url.searchParams.get('action'),Object.fromEntries(url.searchParams)));
        if(req.method==='POST') {const body=await readBody(req);return json(res,200,body.action==='saveDirectDebitNotification'?notifications.save(body,session.userId):ledger.post(body,session.userId));}
        throw fault(405,'この操作は利用できません');
      }
      if(!['GET','HEAD'].includes(req.method)) throw fault(405,'この操作は利用できません');
      const requestPath=url.pathname==='/'?'/index.html':url.pathname;
      if(requestPath==='/index.html'&&!session) {res.writeHead(303,{Location:'/login.html'});return res.end();}
      const file=files.get(requestPath);
      if(!file) throw fault(404,'見つかりません');
      const raw=fs.readFileSync(file);
      const content=path.extname(file)==='.html'?Buffer.from(raw.toString('utf8').replaceAll('{{APP_COMPANY_NAME}}',escapedCompany)):raw;
      res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Content-Length':content.length});res.end(req.method==='HEAD'?undefined:content);
    } catch(error) {
      const internal=error.code || !/[ぁ-んァ-ヶ一-龠]/.test(error.message);
      const status=error.status || (internal?500:400);
      if(status>=500) console.error(JSON.stringify({event:'request_failed',code:'INTERNAL_ERROR'}));
      if(!res.headersSent) json(res,status,{error:internal&&!error.status?'処理できませんでした。管理者に確認してください':error.message});
      else res.end();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;
  return {server,store,close:()=>new Promise(resolve=>{clearInterval(maintenanceTimer);server.close(()=>{if(!options.store)store.close();resolve();});server.closeIdleConnections();})};
}
if(require.main===module) createApplication().then(app=>{
  const port=Number(process.env.PORT||3000),host=process.env.LISTEN_HOST||'127.0.0.1';
  app.server.listen(port,host,()=>console.log(JSON.stringify({event:'ready',port})));
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>app.close().then(()=>process.exit(0)));
}).catch(()=>{console.error('APPLICATION_START_FAILED');process.exitCode=1;});
module.exports={createApplication};
