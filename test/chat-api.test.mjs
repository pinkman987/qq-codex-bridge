import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ApiChatClient,chatCompletion } from '../src/chat-api.mjs';
import { defaults,validateConfig } from '../src/config.mjs';
import { createConsole } from '../src/server.mjs';
import { Bridge } from '../src/bridge.mjs';
import { configToDraft,buildConfig } from '../public/form-state.js';

async function provider(t,handler){
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-chat-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('compatible API sends only chat parameters and keeps independent bounded history across restarts',async t=>{
  const calls=[];
  const baseUrl=await provider(t,async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({url:req.url,auth:req.headers.authorization,body:JSON.parse(raw)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'接着聊'}}]}));});
  const config={provider:'openai',baseUrl,model:'example-model',apiKey:'provider-secret'},historyFile=path.join(temp(t),'history.json');
  const client=new ApiChatClient(config,{historyFile}),id=await client.thread('codex-id',{persona:'简短聊天'});
  await client.run(id,'我喜欢猫');await client.run(id,'你记得吗');
  assert.equal(calls[0].url,'/v1/chat/completions');assert.equal(calls[0].auth,'Bearer provider-secret');assert.equal(calls[0].body.model,'example-model');assert.equal(calls[0].body.tools,undefined);
  assert.ok(calls[1].body.messages.some(m=>m.content==='我喜欢猫'));assert.ok(calls[1].body.messages.some(m=>m.role==='assistant'&&m.content==='接着聊'));
  assert.equal(fs.readFileSync(historyFile,'utf8').includes('provider-secret'),false);
  const restored=new ApiChatClient(config,{historyFile});assert.equal(await restored.thread(id,{persona:'新语气'}),id);await restored.run(id,'继续');assert.match(calls[2].body.messages[0].content,/新语气/);
  restored.configure({...config,model:'different'});assert.notEqual(await restored.thread(id,{}),id);
});
test('anthropic-style endpoint posts messages API with system split out',async t=>{
  const calls=[];
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({url:req.url,headers:req.headers,body:JSON.parse(raw)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({content:[{type:'text',text:'连接成功。'}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const config={provider:'openai',baseUrl:`http://127.0.0.1:${server.address().port}/apps/anthropic`,model:'claude-test',apiKey:'provider-secret'};
  const text=await chatCompletion(config,[{role:'system',content:'人设'},{role:'user',content:'你好'},{role:'assistant',content:'嗨'},{role:'user',content:'在吗'}]);
  assert.equal(text,'连接成功。');
  assert.equal(calls[0].url,'/apps/anthropic/v1/messages');
  assert.equal(calls[0].headers['anthropic-version'],'2023-06-01');
  assert.equal(calls[0].headers['x-api-key'],'provider-secret');
  assert.equal(calls[0].headers.authorization,'Bearer provider-secret');
  assert.equal(calls[0].body.system,'人设');
  assert.equal(calls[0].body.messages.some(m=>m.role==='system'),false);
  assert.equal(calls[0].body.messages.length,3);
  assert.ok(Number.isInteger(calls[0].body.max_tokens)&&calls[0].body.max_tokens>0);
  const withV1={...config,baseUrl:config.baseUrl+'/v1'};
  assert.equal(await chatCompletion(withV1,[{role:'user',content:'你好'}]),'连接成功。');
  assert.equal(calls[1].url,'/apps/anthropic/v1/messages');
});
test('compatible API errors never reflect provider credentials and support cancellation and timeout',async()=>{
  const config={baseUrl:'https://example.invalid/v1',model:'test',apiKey:'secret'};
  for(const status of [401,403,404,429,500])await assert.rejects(()=>chatCompletion(config,[],{fetchImpl:async()=>new Response('secret reflected by server',{status})}),error=>!error.message.includes('secret'));
  await assert.rejects(()=>chatCompletion(config,[],{fetchImpl:async()=>new Response('{}')}),/没有返回/);
  const pending=(_,options)=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('secret')),{once:true});});
  const controller=new AbortController(),request=chatCompletion(config,[],{fetchImpl:pending,signal:controller.signal});controller.abort();await assert.rejects(()=>request,/已停止/);
});
test('API chat client forwards a request-specific timeout to the model call',async t=>{
  const config={baseUrl:'https://example.invalid/v1',model:'test',apiKey:'secret'};
  const fetchImpl=(_,options)=>new Promise((resolve,reject)=>{
    // Real fetch keeps a socket alive; a bare pending promise does not on Node 22.
    const watchdog=setTimeout(()=>reject(new Error('timeout was not forwarded')),1000);
    options.signal.addEventListener('abort',()=>{clearTimeout(watchdog);reject(new Error('aborted'));},{once:true});
  });
  const client=new ApiChatClient(config,{historyFile:path.join(temp(t),'history.json'),fetchImpl});
  const id=await client.thread(null,{persona:'test'});
  await assert.rejects(()=>client.run(id,'hello','low',{timeoutMs:20}),/1 秒/);
});

test('provider errors classify explicit content rejection without exposing raw messages or misclassifying generic 400 and 5xx',async()=>{
  const config={baseUrl:'https://example.invalid/v1',model:'test',apiKey:'private-test-key'};
  for(const [status,code,rejected]of [[400,'data_inspection_failed',true],[400,'DataInspectionFailed',true],[400,'invalid_request_error',false],[500,'data_inspection_failed',false]]){
    await assert.rejects(()=>chatCompletion(config,[],{fetchImpl:async()=>new Response(JSON.stringify({error:{code,message:'private-test-key'}}),{status})}),error=>error.contentRejected===rejected&&error.status===status&&!error.message.includes('private-test-key'));
  }
  await assert.rejects(()=>chatCompletion(config,[],{fetchImpl:async()=>new Response('x'.repeat(20000),{status:400})}),error=>error.contentRejected===false);
});
test('distillation can call a provider without persisting the source transcript in chat history',async t=>{
  const historyFile=path.join(temp(t),'history.json');
  const config={baseUrl:'https://example.invalid/v1',model:'test',apiKey:'secret'};
  const fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:'风格观察'}}]}),{headers:{'Content-Type':'application/json'}});
  const client=new ApiChatClient(config,{historyFile,fetchImpl});
  const id=await client.thread(null,{persona:'analyst'});
  assert.equal(await client.run(id,'私人聊天记录','low',{contextManaged:true,persistHistory:false}),'风格观察');
  assert.equal(fs.existsSync(historyFile),false);
});
test('API config requires remote keys, allows keyless local models, and prevents retained key forwarding to a new origin',async t=>{
  const config=validateConfig({...defaults,chat:{provider:'openai',baseUrl:'https://example.com/v1',apiKey:'retained-secret',model:'test'}});
  assert.throws(()=>validateConfig({...config,chat:{...config.chat,apiKey:''}}),error=>error.field==='apiKey');
  assert.throws(()=>validateConfig({...config,chat:{...config.chat,baseUrl:'http://remote.example/v1'}}),error=>error.field==='apiBase');
  assert.equal(validateConfig({...config,chat:{...config.chat,baseUrl:'http://127.0.0.1:9999/v1',apiKey:''}}).chat.apiKey,'');
  const draft=configToDraft(config);assert.equal(buildConfig(draft,config,false,true).chat.apiKey,'__KEEP__');
  assert.throws(()=>buildConfig({...draft,apiBase:'https://other.example/v1'},config,false,true),error=>error.field==='apiKey');
  const writes=[],tests=[];const bridge={config,status:()=>({}),configure(){}};
  const server=createConsole(bridge,{token:'test',config,persist:c=>writes.push(c),testChat:async c=>tests.push(c)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));config.consolePort=server.address().port;t.after(()=>server.close());
  const base=`http://127.0.0.1:${config.consolePort}`,headers={Authorization:'Bearer test','Content-Type':'application/json'};
  const state=await(await fetch(base+'/api/state',{headers})).json();assert.equal(state.hasApiKey,true);assert.equal(JSON.stringify(state).includes('retained-secret'),false);
  const post=(route,body)=>fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)});
  const testResult=await post('/api/chat/test',{chat:{...state.config.chat,apiKey:'__KEEP__'}});assert.equal(testResult.status,200);assert.equal(tests[0].apiKey,'retained-secret');assert.equal(writes.length,0);
  assert.equal((await post('/api/chat/test',{chat:{...state.config.chat,baseUrl:'https://other.example/v1',apiKey:'__KEEP__'}})).status,400);assert.equal(tests.length,1);
  assert.equal((await post('/api/config',{...state.config,chat:{...state.config.chat,apiKey:'__KEEP__'},persona:'changed'})).status,200);assert.equal(writes[0].chat.apiKey,'retained-secret');
  assert.equal((await post('/api/config',{...state.config,chat:{...state.config.chat,provider:'codex',apiKey:''}})).status,200);assert.equal(writes[1].chat.apiKey,'');
});
test('third-party chat routes groups and owner chat to API while work still routes to Codex',async t=>{
  class Engine extends EventEmitter{constructor(role){super();this.role=role;this.ready=true;this.turns=new Map();this.calls=[];}async thread(){return this.role;}async run(id,prompt){this.calls.push(prompt);return 'reply';}stop(){}configure(){} }
  class QQ extends EventEmitter{constructor(){super();this.sent=[];}async send(target,text){this.sent.push({target,text});}close(){}connect(){} }
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456',groups:['654321'],chat:{provider:'openai',baseUrl:'http://127.0.0.1:9999/v1',model:'test',apiKey:''}});
  const social=new Engine('social'),apiSocial=new Engine('social'),work=new Engine('work'),onebot=new QQ();
  const bridge=new Bridge(config,{social,apiSocial,work,onebot,stateFile:path.join(temp(t),'sessions.json')});
  const event=(message_type,message,id)=>({post_type:'message',message_type,user_id:123456,self_id:999999,group_id:654321,message_id:id,message});
  await bridge.handle(event('group','[CQ:at,qq=999999]你好',1));await bridge.handle(event('private','工作',2));await bridge.handle(event('private','/mode chat',3));await bridge.handle(event('private','聊聊',4));
  assert.equal(apiSocial.calls.length,2);assert.equal(work.calls.length,1);assert.equal(social.calls.length,0);
});
test('thinking models returning empty content are retried with thinking disabled',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    if(body.enable_thinking===false)return new Response(JSON.stringify({choices:[{message:{content:'S: 爱说哦哦'}}]}),{status:200});
    return new Response(JSON.stringify({choices:[{message:{content:'',reasoning_content:'让我想想……'}}]}),{status:200});
  };
  const text=await chatCompletion({baseUrl:'https://example.com/v1',model:'thinky',apiKey:'k'},[{role:'user',content:'hi'}],{fetchImpl});
  assert.equal(text,'S: 爱说哦哦');
  assert.equal(calls.length,2);
  assert.equal(calls[1].enable_thinking,false);
});
