'use strict';
// Build an inactive, credential-free template. This command never contacts n8n or LINE.
const fs=require('node:fs'),path=require('node:path');
const nodes=[];
function node(name,type,version,parameters,extra={}){nodes.push({id:name,name,type:'n8n-nodes-base.'+type,typeVersion:version,position:[nodes.length*240,0],parameters,...extra});}
node('Daily 10 JST','scheduleTrigger',1.2,{rule:{interval:[{field:'cronExpression',expression:'0 0 10 * * *'}]}});
node('Prepare daily batch','httpRequest',4.2,{method:'POST',url:'https://cashflow.example.invalid/integrations/direct-debit/prepare',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,specifyBody:'json',jsonBody:'{}',options:{timeout:15000}},{retryOnFail:true,maxTries:3,waitBetweenTries:5000});
node('Only pending today','code',2,{jsCode:`const b=$input.first().json;
if(!b.send)return [];
if(Date.now()>=Date.parse(b.expiresAt)||!Number.isFinite(Date.parse(b.expiresAt)))throw Error('Notification expired; do not send stale batch');
if(!/^[UCR][0-9a-f]{32}$/.test(b.payload?.to)||b.payload?.messages?.length!==1)throw Error('Invalid batch');
return [{json:b}];`});
node('LINE push','httpRequest',4.2,{method:'POST',url:'https://api.line.me/v2/bot/message/push',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendHeaders:true,headerParameters:{parameters:[{name:'X-Line-Retry-Key',value:'={{ $json.retryKey }}'}]},sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json.payload) }}',options:{timeout:15000,response:{response:{fullResponse:true,neverError:true,responseFormat:'json'}}}},{retryOnFail:true,maxTries:3,waitBetweenTries:5000});
node('Verify LINE accepted','code',2,{jsCode:`const r=$input.first().json,b=$('Only pending today').first().json;
const h=Object.fromEntries(Object.entries(r.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));
const ok=r.statusCode>=200&&r.statusCode<300;
const duplicate=r.statusCode===409&&!!h['x-line-accepted-request-id'];
if(!ok&&!duplicate)throw Error('LINE request not accepted; retry whole workflow today with stored batch');
const requestId=duplicate?h['x-line-accepted-request-id']:h['x-line-request-id'];
if(!requestId)throw Error('Missing LINE receipt; retry whole workflow today');
return [{json:{day:b.day,retryKey:b.retryKey,requestId}}];`});
node('Record acceptance','httpRequest',4.2,{method:'POST',url:'https://cashflow.example.invalid/integrations/direct-debit/ack',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json) }}',options:{timeout:15000}},{retryOnFail:true,maxTries:3,waitBetweenTries:5000});
const connections=Object.fromEntries(nodes.slice(0,-1).map((n,i)=>[n.name,{main:[[{node:nodes[i+1].name,type:'main',index:0}]]}]));
const workflow={name:'Cashflow - automatic debit reminder',active:false,nodes,connections,settings:{timezone:'Asia/Tokyo',executionOrder:'v1',executionTimeout:120,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false}};
const file=path.join(__dirname,'../deployment/n8n-direct-debit.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(workflow,null,2)+'\n');
