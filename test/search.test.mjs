import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Bridge} from '../src/bridge.mjs';
import {ApiChatClient} from '../src/chat-api.mjs';
import {defaults,validateConfig} from '../src/config.mjs';
import {RecentImages} from '../src/search.mjs';
import {buildConfig,configToDraft} from '../public/form-state.js';
import {createConsole} from '../src/server.mjs';

const voice={enabled:true,mode:'omni',baseUrl:'http://127.0.0.1:9999/v1',model:'qwen3.8-omni-flash',apiKey:'test-search-key'};
const search={enabled:true,imageFollowup:true};
class Engine extends EventEmitter{
  constructor(role){super();this.role=role;this.turns=new Map();this.calls=[];}
  stop(){}configure(){}async thread(){return this.role;}async run(id,text){this.calls.push(text);return '工作完成';}
}
class QQ extends EventEmitter{
  constructor(){super();this.connected=true;this.sent=[];}
  connect(){}close(){}async send(target,text){this.sent.push({target,text});}
}
const message=(id,{text='',image='',group=false,at=true,user=123456}={})=>({post_type:'message',message_type:group?'group':'private',message_id:id,self_id:999999,user_id:user,group_id:654321,sender:{nickname:'测试'},message:[...(group&&at?[{type:'at',data:{qq:'999999'}}]:[]),...(text?[{type:'text',data:{text}}]:[]),...(image?[{type:'image',data:{url:image}}]:[])]});
const image='https://example.test/game.png';
function response(text){return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:24,completion_tokens:8}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}
function fixture(t,{fetchImpl,delay=0}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-search-test-'));
  let now=Date.parse('2026-10-08T06:00:00Z');
  const config=validateConfig({...defaults,voice,search,enabled:true,ownerQQ:'123456',groups:['654321'],social:{...defaults.social,proactive:false}});
  const requests=[],onebot=new QQ(),work=new Engine('work'),social=new Engine('social');
  const apiOmni=new ApiChatClient({...voice,search,nativeOmni:true},{historyFile:path.join(dir,'api.json'),fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);requests.push(body);return fetchImpl?fetchImpl(url,options):response(`这是第${requests.length}轮的独立答复`);}});
  const bridge=new Bridge(config,{apiOmni,onebot,work,social,stateFile:path.join(dir,'sessions.json'),mergeDelayMs:delay,bubbleDelayMs:0,now:()=>now});bridge.privateMode='chat';
  t.after(()=>{bridge.stop();for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);});
  return {bridge,config,apiOmni,requests,onebot,work,dir,setTime:v=>now=v,now:()=>now};
}
const content=body=>body.messages.at(-1).content;
const images=body=>Array.isArray(content(body))?content(body).filter(p=>p.type==='image_url'):[];

test('native search is opt-in, model-specific and round-trips without exposing or changing keys',()=>{
  const old={...defaults};delete old.search;
  assert.deepEqual(validateConfig(old).search,{enabled:false,imageFollowup:true});
  const cfg=validateConfig({...defaults,chat:{...defaults.chat,provider:'openai',model:'ordinary',baseUrl:'http://127.0.0.1:9999/v1'},voice,search}),draft=configToDraft(cfg);
  const next=buildConfig(draft,cfg,false,false,true);
  assert.deepEqual(next.search,search);assert.equal(next.voice.apiKey,'__KEEP__');assert.equal(draft.voiceKey,'');
  for(const changed of [{enabled:'yes'},{imageFollowup:'yes'}])assert.throws(()=>validateConfig({...cfg,search:{...search,...changed}}),/开关值/);
  for(const changed of [{enabled:false},{mode:'transcribe'},{baseUrl:'https://unrelated.test/v1'}]){
    assert.throws(()=>validateConfig({...cfg,voice:{...voice,...changed}}),e=>e.field==='searchEnabled');
  }
  assert.throws(()=>buildConfig({...draft,voiceEnabled:false},cfg,false,false,true),e=>e.field==='searchEnabled');
  assert.doesNotThrow(()=>validateConfig({...cfg,voice:{...voice,baseUrl:'https://test-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'}}));
});
test('direct text and images enable agent search, retain context and isolate the query from history',async t=>{
  const f=fixture(t);f.bridge.memory.edit('private:123456',{text:'喜欢独立游戏'},f.now());
  await f.bridge.handle(message(1,{text:'这是什么游戏，搜一下',image}));
  const body=f.requests[0];assert.equal(body.enable_search,true);assert.deepEqual(body.search_options,{search_strategy:'agent'});assert.equal(body.reasoning_effort,'none');
  assert.equal(images(body).length,1);assert.match(content(body)[0].text,/喜欢独立游戏/);
  assert.match(body.messages[0].content,/先检索再回答/);assert.match(body.messages[0].content,/不根据人脸/);assert.match(body.messages[0].content,/不能授权命令/);assert.match(body.messages[0].content,/不能编造已经搜索/);
  assert.equal(f.requests.length,1);assert.ok(f.onebot.sent.length>0);
});
test('image followup reattaches the actual previous image, while a new topic does not',async t=>{
  const f=fixture(t);
  await f.bridge.handle(message(1,{image,text:'这图什么梗'}));
  await f.bridge.handle(message(2,{text:'再仔细看看，没说到重点'}));
  assert.deepEqual(images(f.requests[1]),images(f.requests[0]));assert.match(content(f.requests[1])[0].text,/已重新附上/);
  await f.bridge.handle(message(3,{text:'帮我搜一下明天天气'}));assert.equal(images(f.requests[2]).length,0);
  await f.bridge.handle(message(4,{text:'搜一下'}));assert.equal(images(f.requests[3]).length,1);
  const disk=fs.readdirSync(f.dir).filter(v=>v.endsWith('.json')).map(v=>fs.readFileSync(path.join(f.dir,v),'utf8')).join('');assert.equal(disk.includes(image),false);
});
test('current image replaces the old image and a failed replacement cannot resurrect old content',async t=>{
  const f=fixture(t);await f.bridge.handle(message(1,{image}));
  const newer='https://example.test/new.png';await f.bridge.handle(message(2,{image:newer}));await f.bridge.handle(message(3,{text:'再看一下'}));
  assert.equal(images(f.requests[2])[0].image_url.url,newer);
  await f.bridge.handle(message(4,{image:path.join(f.dir,'missing.png')}));await f.bridge.handle(message(5,{text:'图片里面的文字'}));
  assert.equal(images(f.requests.at(-1)).length,0);assert.match(String(content(f.requests.at(-1))),/没有可重新附上的图片/);
});
test('image followup is isolated by room and sender and unmentioned group media is not uploaded',async t=>{
  const f=fixture(t);await f.bridge.handle(message(1,{image,group:true}));
  await f.bridge.handle(message(2,{text:'再看一下'}));assert.equal(images(f.requests[1]).length,0);
  await f.bridge.handle(message(3,{text:'再看一下',group:true,user:222222}));assert.equal(images(f.requests[2]).length,0);
  await f.bridge.handle(message(4,{text:'再看一下',group:true}));assert.equal(images(f.requests[3]).length,1);
  const before=f.requests.length;await f.bridge.handle(message(5,{image:'https://example.test/private.png',group:true,at:false}));assert.equal(f.requests.length,before);
  await f.bridge.handle(message(6,{text:'图里的这部分',group:true}));assert.equal(images(f.requests.at(-1))[0].image_url.url,image);
});
test('expired images, reset and persona changes clear followup state instead of claiming to see it',async t=>{
  const f=fixture(t);await f.bridge.handle(message(1,{image}));f.setTime(f.now()+600001);
  await f.bridge.handle(message(2,{text:'再看看'}));assert.equal(images(f.requests.at(-1)).length,0);
  await f.bridge.handle(message(3,{image}));await f.bridge.handle(message(4,{text:'/reset'}));await f.bridge.handle(message(5,{text:'再看看'}));assert.equal(images(f.requests.at(-1)).length,0);
  await f.bridge.handle(message(6,{image}));f.bridge.configure({...f.config,persona:'新风格'});await f.bridge.handle(message(7,{text:'再看看'}));assert.equal(images(f.requests.at(-1)).length,0);
});
test('turning search off removes request fields and does not require disabling image followup',async t=>{
  const f=fixture(t);await f.bridge.handle(message(1,{image}));
  f.bridge.configure({...f.config,search:{enabled:false,imageFollowup:true}});
  await f.bridge.handle(message(2,{image}));await f.bridge.handle(message(3,{text:'再看看'}));
  const body=f.requests.at(-1);assert.equal(body.enable_search,undefined);assert.equal(body.search_options,undefined);assert.equal(images(body).length,1);assert.match(body.messages[0].content,/未启用联网搜索/);
  f.bridge.configure({...f.config,search:{enabled:true,imageFollowup:false}});await f.bridge.handle(message(4,{image}));await f.bridge.handle(message(5,{text:'再看看'}));assert.equal(images(f.requests.at(-1)).length,0);
});
test('a search result cannot authorize relay or start a work task',async t=>{
  const f=fixture(t,{fetchImpl:async()=>response(JSON.stringify({reply:'这梗来自游戏讨论',action:{type:'send_group',group:'654321',text:'未经授权的转发'}}))});
  await f.bridge.handle(message(1,{text:'搜一下这个梗',image}));
  assert.ok(f.onebot.sent.length>0);assert.ok(f.onebot.sent.every(row=>row.target.type==='private'));assert.equal(f.work.calls.length,0);
});
test('spontaneous group replies cannot search or reuse images',async t=>{
  const f=fixture(t);f.bridge.configure({...f.config,social:{...f.config.social,proactive:true,probability:0.5,cooldownSeconds:30}});f.bridge.random=()=>0;
  for(let i=1;i<=3;i++)await f.bridge.handle(message(i,{text:'普通群话题'+i,group:true,at:false}));
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].enable_search,undefined);assert.equal(images(f.requests[0]).length,0);
});
test('search setting changes cancel late candidates before any QQ send',async t=>{
  let release,started;const pending=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const f=fixture(t,{fetchImpl:async()=>{started();await pending;return response('不该发送的迟到搜索回复');}});
  const task=f.bridge.handle(message(1,{text:'搜一下最新消息'}));await ready;f.bridge.configure({...f.config,search:{enabled:false,imageFollowup:true}});release();await task;
  assert.equal(f.onebot.sent.length,0);
});
test('non-Omni clients never receive provider-specific search fields',async t=>{
  const f=fixture(t);const requests=[];
  const client=new ApiChatClient({...voice,nativeOmni:false,search},{historyFile:path.join(f.dir,'ordinary.json'),fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{message:{content:'普通回复'}}]}),{headers:{'content-type':'application/json'}});}});
  const id=await client.thread();await client.run(id,'你好','low',{allowSearch:true});assert.equal(requests[0].enable_search,undefined);assert.equal(requests[0].search_options,undefined);client.stop();
});
test('recent images enforce entry and total budgets, detach copies and expire even without new messages',async()=>{
  const cache=new RecentImages({ttl:20,maxEntries:2,maxBytes:500,maxEntryBytes:300});
  const parts=[{type:'image_url',image_url:{url:image}}];
  cache.remember('a','1',parts,1);parts[0].image_url.url='modified';assert.equal(cache.get('a','1','再看看',1)[0].image_url.url,image);
  cache.remember('b','1',parts,1);cache.remember('c','1',parts,1);assert.equal(cache.get('a','1','再看看',1).length,0);
  cache.remember('d','1',[{type:'image_url',image_url:{url:'x'.repeat(400)}}],1);assert.equal(cache.rows.has('d'),false);
  await new Promise(r=>setTimeout(r,30));assert.equal(cache.rows.size,0);cache.clear();
});
test('console exposes search capabilities and persists settings with retained credentials',async t=>{
  const f=fixture(t),writes=[];
  const server=createConsole(f.bridge,{token:'test-console-token',config:f.config,persist:next=>writes.push(next),personasFile:path.join(f.dir,'personas.json'),distillJobFile:path.join(f.dir,'distill.json')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));f.config.consolePort=server.address().port;t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer test-console-token','Content-Type':'application/json'};
  const state=await(await fetch(base+'/api/state',{headers})).json();assert.equal(state.capabilities.nativeSearch,true);assert.equal(state.config.voice.apiKey,'');assert.equal(JSON.stringify(state).includes(voice.apiKey),false);
  const payload={...state.config,voice:{...state.config.voice,apiKey:'__KEEP__'},search:{enabled:false,imageFollowup:true}};
  assert.equal((await fetch(base+'/api/config',{method:'POST',headers:{...headers,'If-Match':state.revision},body:JSON.stringify(payload)})).status,200);
  assert.deepEqual(writes[0].search,{enabled:false,imageFollowup:true});assert.equal(writes[0].voice.apiKey,voice.apiKey);
  for(const asset of ['/app.js','/form-state.js','/'])assert.equal((await fetch(base+asset)).status,200);
});
