import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Bridge} from '../src/bridge.mjs';
import {defaults,validateConfig} from '../src/config.mjs';
import {TaskStore,publicTaskText} from '../src/tasks.mjs';
import {CodexClient} from '../src/codex.mjs';
import {createConsole} from '../src/server.mjs';
import {runPlayground,validateTestMessage,playgroundEngine} from '../src/playground.mjs';
import {quotaSnapshot} from '../src/usage.mjs';

class Engine extends EventEmitter{
  constructor(role='work'){super();this.role=role;this.turns=new Map();this.ready=true;this.responses=[];this.steers=[];this.runs=[];}
  async thread(saved,options){this.threadOptions=options;return saved||'fake-thread';}
  run(id,text,effort,options={}){
    this.runs.push({text,options});
    return new Promise((resolve,reject)=>{
      const end=(fn,value)=>{this.turns.delete(id);options.signal?.removeEventListener('abort',abort);fn(value);};
      const abort=()=>end(reject,new Error('任务已停止'));
      this.turns.set(id,{turnId:'fake-turn',resolve:value=>end(resolve,value),reject:error=>end(reject,error)});
      if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
    });
  }
  respond(id,result){this.responses.push({id,result});}
  async steer(id,text){assert.ok(this.turns.has(id));this.steers.push(text);}
  async interrupt(id){this.turns.get(id)?.reject(new Error('任务已停止'));}
  stop(){for(const t of [...this.turns.values()])t.reject(new Error('引擎已停止'));}
  configure(){}
}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-workbench-'));
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456',groups:['654321'],persona:'测试人设',chat:{...defaults.chat,apiKey:'fake-secret-key'},projects:{}});
  const onebot=new EventEmitter();Object.assign(onebot,{connected:true,sent:[],async send(target,text){this.sent.push({target,text});},connect(){},close(){}});
  const work=new Engine(),social=new Engine('social');let now=1000000;
  const bridge=new Bridge(config,{onebot,work,social,apiSocial:new Engine('social'),apiOmni:new Engine('social'),stateFile:path.join(root,'sessions.json'),now:()=>now,mergeDelayMs:0,bubbleDelayMs:0});
  t.after(()=>{bridge.stop();fs.rmSync(root,{recursive:true,force:true});});
  return {root,config,bridge,work,social,onebot,tick:()=>{now+=16000;}};
}
const target={type:'private',user:'123456',text:'修改测试首页'};
const until=async fn=>{for(let i=0;i<100&&!fn();i++)await new Promise(r=>setTimeout(r,5));assert.ok(fn(),'fake operation reached expected state');};
async function start(f){const run=f.bridge.runPrivate(target,'private:123456');await until(()=>f.work.turns.size===1);return {run,task:f.bridge.taskList()[0]};}

test('work tasks persist progress/files/results; QQ reports are ordered, bounded and exclude tool output',async t=>{
  const f=fixture(t),{run,task}=await start(f);
  const event=(type,extra={})=>f.work.emit('notification',{method:'item/started',params:{threadId:'fake-thread',item:{type,...extra}}});
  event('commandExecution',{command:'fake-secret-key',aggregatedOutput:'private-output'});
  await f.bridge.taskRuns.get(task.id).delivery;
  event('commandExecution');event('fileChange');f.tick();event('webSearch');await f.bridge.taskRuns.get(task.id).delivery;
  f.work.emit('notification',{method:'item/completed',params:{threadId:'fake-thread',item:{type:'fileChange',status:'failed',changes:[{path:'failed.txt'}]}}});
  f.work.emit('notification',{method:'item/completed',params:{threadId:'fake-thread',item:{type:'fileChange',status:'completed',changes:[{path:'public/index.html',diff:'private-output'}]}}});
  f.work.turns.get('fake-thread').resolve('已修改首页并验证 fake-secret-key');await run;
  const stored=f.bridge.taskList()[0];assert.equal(stored.status,'completed');assert.deepEqual(stored.files,['public/index.html']);assert.ok(!stored.result.includes('fake-secret-key'));
  assert.equal(f.onebot.sent.length,4);assert.match(f.onebot.sent[0].text,/全力为你工作/);assert.match(f.onebot.sent.at(-1).text,/已修改首页/);
  assert.ok(f.onebot.sent.slice(1,-1).every(row=>!row.text.includes('用量')&&!row.text.includes('额度')));
  assert.ok(!JSON.stringify(f.onebot.sent).includes('private-output'));assert.ok(!JSON.stringify(stored).includes('private-output'));
  assert.equal(new TaskStore(f.bridge.stateFile+'.tasks.json').list('123456')[0].status,'completed');
});
test('approval waits, supplements and cancellation stay bound to the active owner task',async t=>{
  const f=fixture(t),{run,task}=await start(f);
  await f.bridge.supplementTask(task.id,'只修改首页');assert.deepEqual(f.work.steers,['只修改首页']);
  await f.bridge.handleRequest({id:11,method:'item/commandExecution/requestApproval',params:{threadId:'fake-thread',command:'echo fake'}});
  assert.equal(f.bridge.taskList()[0].status,'waiting');await assert.rejects(f.bridge.supplementTask(task.id,'追加'),/确认问题/);
  const token=[...f.bridge.approvals.keys()][0];await f.bridge.answerApproval(target,'/approve',[token]);assert.equal(f.bridge.taskList()[0].status,'running');
  await f.bridge.stopTask(task.id);await run;assert.equal(f.bridge.taskList()[0].status,'cancelled');assert.equal(f.bridge.approvals.size,0);
  await assert.rejects(f.bridge.supplementTask(task.id,'结束后追加'),/已结束/);await assert.rejects(f.bridge.stopTask('unrelated'),/已结束/);
  assert.ok(f.onebot.sent.at(-1).text.includes('任务已停止'));
});
test('owner change interrupts task, hides old records and drops late QQ progress/results',async t=>{
  const f=fixture(t),{run}=await start(f);const sent=f.onebot.sent.length;
  f.bridge.configure({...f.config,ownerQQ:'987654'});await run;
  assert.equal(f.bridge.taskList().length,0);assert.equal(f.onebot.sent.length,sent);
  assert.equal(f.bridge.tasks.list('123456')[0].status,'interrupted');
});
test('stop during engine startup prevents a later turn from beginning',async t=>{
  const f=fixture(t);let release;f.work.thread=()=>new Promise(r=>{release=r;});
  const run=f.bridge.runPrivate(target,'private:123456');await until(()=>!!release);
  await f.bridge.stopTask(f.bridge.taskList()[0].id);release('fake-thread');await run;
  assert.equal(f.work.runs.length,0);assert.equal(f.bridge.taskList()[0].status,'cancelled');
});
test('QQ delivery failures do not turn completed work into a failure',async t=>{
  const f=fixture(t);f.onebot.send=async()=>{throw new Error('fake-private-error');};const {run}=await start(f);
  f.work.turns.get('fake-thread').resolve('测试结果');await run;
  assert.equal(f.bridge.taskList()[0].status,'completed');assert.equal(f.bridge.taskList()[0].deliveryError,true);
  assert.ok(!JSON.stringify(f.bridge.taskList()).includes('fake-private-error'));
});
test('QQ reports include real quota snapshots and lead with the final result; quota failure does not fail work',async t=>{
  const f=fixture(t);const reads=[];f.work.readUsage=async options=>{reads.push(options);return quotaSnapshot({rateLimits:{primary:{usedPercent:28,windowDurationMins:300,resetsAt:4600}}},1000000);};
  const {run,task}=await start(f);assert.equal(reads.length,0);assert.ok(!f.onebot.sent[0].text.includes('额度'));
  f.work.emit('notification',{method:'item/started',params:{threadId:'fake-thread',item:{type:'fileChange'}}});await f.bridge.taskRuns.get(task.id).delivery;
  assert.equal(reads.length,0);assert.ok(!f.onebot.sent.at(-1).text.includes('额度'));
  f.work.turns.get('fake-thread').resolve('首页已修改，测试通过。');await run;
  assert.ok(f.onebot.sent.at(-1).text.startsWith('首页已修改，测试通过。'));assert.equal(reads.at(-1).force,true);assert.equal(reads.length,1);assert.match(f.onebot.sent.at(-1).text,/剩余 72%/);assert.match(f.onebot.sent.at(-1).text,/约 1小时后刷新/);
  f.work.readUsage=async()=>{throw new Error('fake-private-quota-error');};const second=await start(f);f.work.turns.get('fake-thread').resolve('完成');await second.run;
  assert.equal(f.bridge.taskList()[0].status,'completed');assert.match(f.onebot.sent.at(-1).text,/用量：暂时读取不到/);assert.ok(!JSON.stringify(f.onebot.sent).includes('fake-private-quota-error'));
});
test('work replies flatten tables, omit unsolicited URLs and allow a later source request',async t=>{
  const f=fixture(t),first=await start(f);
  const answer='### 结果\n| 项目 | 状态 |\n|---|---|\n| 首页 | 已检查 |\n\n[文档](https://example.test/docs)';
  f.work.turns.get('fake-thread').resolve(answer);await first.run;
  const sent=f.onebot.sent.at(-1).text;assert.match(sent,/首页\n状态：已检查/);assert.ok(!sent.includes('https:'));assert.ok(!sent.includes('|'));assert.ok(!sent.includes('###'));
  const next=f.bridge.runPrivate({...target,text:'把来源链接发我'},'private:123456');await until(()=>f.work.turns.size===1);
  f.work.turns.get('fake-thread').resolve('[文档](https://example.test/docs)');await next;
  assert.match(f.onebot.sent.at(-1).text,/https:\/\/example.test\/docs/);
});

test('plain owner replies answer clarification questions without approving commands',async t=>{
  const f=fixture(t),{run}=await start(f);
  await f.bridge.handleRequest({id:61,method:'item/tool/requestUserInput',params:{threadId:'fake-thread',questions:[{id:'goal',question:'这次主要想解决什么？',options:[{label:'布局'},{label:'文字'}]}]}});
  assert.match(f.onebot.sent.at(-1).text,/直接回复我就好/);
  const message=(user,text,id)=>({post_type:'message',message_type:'private',user_id:user,self_id:'999999',message_id:id,message:[{type:'text',data:{text}}]});
  await f.bridge.handle(message('555555','布局',701));assert.equal(f.work.responses.length,0);
  await f.bridge.handle(message('123456','布局',702));assert.deepEqual(f.work.responses,[{id:61,result:{answers:{goal:{answers:['布局']}}}}]);
  await f.bridge.handleRequest({id:62,method:'item/commandExecution/requestApproval',params:{threadId:'fake-thread',command:'echo test'}});
  await f.bridge.handle(message('123456','好的',703));assert.equal(f.work.responses.length,1);assert.equal(f.bridge.approvals.size,1);
  await f.bridge.stopTask(f.bridge.taskList()[0].id);await run;
});

test('cold startup, progress, cancellation and failure never read or show quota',async t=>{
  const f=fixture(t);f.work.ready=false;let reads=0;f.work.readUsage=async()=>{reads++;return null;};
  const {run,task}=await start(f);assert.equal(reads,0);assert.equal(f.onebot.sent.length,1);
  f.work.emit('notification',{method:'item/started',params:{threadId:'fake-thread',item:{type:'webSearch'}}});await f.bridge.taskRuns.get(task.id).delivery;assert.equal(reads,0);
  await f.bridge.stopTask(task.id);await run;assert.equal(reads,0);
  const next=await start(f);f.work.turns.get('fake-thread').reject(new Error('fake failure'));await next.run;
  assert.equal(reads,0);assert.ok(f.onebot.sent.every(row=>!/用量|额度/.test(row.text)));
});

test('task store bounds history, isolates owners and marks unfinished work interrupted after restart',t=>{
  const f=fixture(t);for(let i=0;i<102;i++)f.bridge.tasks.create({owner:i===101?'other':'123456',text:'示例任务'+i,project:'默认',directory:f.root});
  const store=new TaskStore(f.bridge.stateFile+'.tasks.json');assert.equal(store.data.tasks.length,100);assert.equal(store.list('123456').length,99);
  assert.ok(store.list('123456').every(t=>t.status==='interrupted'));assert.ok(!JSON.stringify(store.list('123456')).includes('other'));
  assert.equal(publicTaskText('fake-secret-key',f.config),'[已隐藏密钥]');
});
test('Codex steering sends expected active turn and cannot create an idle turn',async()=>{
  const client=new CodexClient('work',()=>{});const calls=[];client.request=async(method,params)=>calls.push({method,params});
  await assert.rejects(client.steer('thread','a'),/尚未开始/);assert.equal(calls.length,0);
  client.turns.set('thread',{turnId:'turn'});await client.steer('thread','补充');
  assert.deepEqual(calls[0],{method:'turn/steer',params:{threadId:'thread',expectedTurnId:'turn',input:[{type:'text',text:'补充',text_elements:[]}]}});
  client.turns.get('thread').interruptRequested=true;await assert.rejects(client.steer('thread','a'));
});
async function consoleFixture(t){
  const f=fixture(t),engines=[];let saves=0;
  const server=createConsole(f.bridge,{config:f.config,token:'fake-console',savedAt:null,distillJobFile:path.join(f.root,'distill.json'),persist:()=>saves++,createPlaygroundEngine:config=>{const engine=new Engine('social');engine.config=structuredClone(config);engines.push(engine);return engine;}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.consolePort=server.address().port;t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer fake-console','Content-Type':'application/json'};
  const post=(route,body,extra={})=>fetch(base+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  return {...f,base,headers,post,engines,saves:()=>saves};
}
const message=(id='test-request-1')=>({id,mode:'saved',text:'你好',history:[],includeMemory:false});
test('playground uses saved or draft persona with retained keys; it never writes config, QQ sessions or real memory',async t=>{
  const f=await consoleFixture(t);f.bridge.memory.edit('private:123456',{kind:'memory',text:'我喜欢猫'});
  const before=JSON.stringify(f.bridge.memory.value),sessions=JSON.stringify(f.bridge.sessions);
  const first=f.post('/api/playground',{...message(),includeMemory:true});await until(()=>f.engines[0]?.runs.length);
  assert.equal(f.engines[0].threadOptions.ephemeral,true);assert.ok(f.engines[0].runs[0].text.includes('我喜欢猫'));
  assert.equal(f.engines[0].runs[0].options.persistHistory,false);f.engines[0].turns.get('fake-thread').resolve('你好呀');assert.equal((await first).status,200);
  const draft=structuredClone(f.config);draft.persona='草稿：语气直接';draft.chat.apiKey='__KEEP__';draft.ownerQQ='987654';draft.enabled=false;
  const second=f.post('/api/playground',{...message('test-request-2'),mode:'draft',config:draft,history:[{role:'user',content:'你好'},{role:'assistant',content:'你好呀'}]});await until(()=>f.engines[1]?.runs.length);
  assert.equal(f.engines[1].config.persona,'草稿：语气直接');assert.equal(f.engines[1].config.ownerQQ,'123456');assert.equal(f.engines[1].config.chat.apiKey,'fake-secret-key');assert.ok(!f.engines[1].runs[0].text.includes('我喜欢猫'));
  f.engines[1].turns.get('fake-thread').resolve('说吧');assert.equal((await second).status,200);
  assert.equal(f.saves(),0);assert.equal(f.config.persona,'测试人设');assert.equal(JSON.stringify(f.bridge.sessions),sessions);assert.equal(JSON.stringify(f.bridge.memory.value),before);assert.equal(f.onebot.sent.length,0);
});
test('playground validates auth, origin, bounds and key origin; cancels only matching test and hides provider errors',async t=>{
  const f=await consoleFixture(t);
  assert.equal((await fetch(f.base+'/api/tasks')).status,401);
  assert.equal((await f.post('/api/playground',message(),{Origin:'https://other.example'})).status,403);
  assert.equal((await f.post('/api/playground',{...message(),text:'x'.repeat(4001)})).status,400);
  const draft=structuredClone(f.config);draft.chat.apiKey='__KEEP__';draft.chat.baseUrl='https://other.example/v1';
  assert.equal((await f.post('/api/playground',{...message(),mode:'draft',config:draft})).status,400);assert.equal(f.engines.length,0);
  const one=f.post('/api/playground',message());await until(()=>f.engines[0]?.runs.length);
  assert.equal((await f.post('/api/playground',message())).status,409);
  await f.post('/api/playground/cancel',{id:'unrelated'});assert.equal(f.engines[0].turns.size,1);
  await f.post('/api/playground/cancel',{id:'test-request-1'});assert.match((await (await one).json()).error,/已停止/);
  const two=f.post('/api/playground',message('test-request-2'));await until(()=>f.engines[1]?.runs.length);f.engines[1].turns.get('fake-thread').reject(new Error('fake-secret-key provider-private-payload'));
  const failure=await (await two).json();assert.ok(!JSON.stringify(failure).includes('fake-secret-key'));assert.ok(!JSON.stringify(failure).includes('provider-private-payload'));
});
test('authenticated task routes stop and supplement matching tasks; foreign origins cannot operate',async t=>{
  const f=await consoleFixture(t),{run,task}=await start(f);
  assert.equal((await f.post('/api/tasks/stop',{id:task.id},{Origin:'https://other.example'})).status,403);assert.equal(f.work.turns.size,1);
  assert.equal((await f.post('/api/tasks/supplement',{id:task.id,text:'只改颜色'})).status,200);assert.deepEqual(f.work.steers,['只改颜色']);
  assert.equal((await f.post('/api/tasks/stop',{id:'other'})).status,409);
  assert.equal((await f.post('/api/tasks/stop',{id:task.id})).status,200);await run;
  const list=await (await fetch(f.base+'/api/tasks',{headers:f.headers})).json();assert.equal(list.tasks[0].status,'cancelled');
});
test('playground selects isolated API engine and never persists or executes model-suggested relay',async()=>{
  const config=validateConfig({...defaults,chat:{...defaults.chat,provider:'openai',baseUrl:'https://example.invalid/v1',model:'test',apiKey:'fake-key'}});
  const engine=playgroundEngine(config);engine.fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({reply:'你好',action:{type:'send_group',group:'654321',text:'不应发送'}})}}]}),{status:200,headers:{'Content-Type':'application/json'}});
  const response=await runPlayground(engine,config,message(),{signal:new AbortController().signal});assert.equal(response,'你好');assert.deepEqual(engine.history,{});assert.equal(engine.historyFile,null);
  assert.throws(()=>validateTestMessage({...message(),history:[{role:'system',content:'bad'}]}));
});
