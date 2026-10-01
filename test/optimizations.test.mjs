import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Bridge} from '../src/bridge.mjs';
import {defaults,validateConfig} from '../src/config.mjs';
import {ConversationQueue,splitBubbles,relayIntent,socialReply} from '../src/conversation.mjs';
import {SocialState} from '../src/social-state.mjs';
import {Telemetry} from '../src/telemetry.mjs';
import {ApiChatClient,chatCompletion} from '../src/chat-api.mjs';
import {createConsole} from '../src/server.mjs';

const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const now=Date.parse('2026-09-29T06:00:00Z');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-upgrade-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
class Engine extends EventEmitter{
  constructor(role){super();this.role=role;this.turns=new Map();this.runs=[];this.stops=0;}
  async thread(id){return id||this.role+'-id';}
  async run(id,prompt){this.runs.push(prompt);return '接着说';}
  stop(){this.stops++;}configure(){this.stop();}async interrupt(){}
}
class QQ extends EventEmitter{
  constructor(){super();this.sent=[];this.connected=true;this.connects=0;this.closes=0;}
  send(target,text){this.sent.push({target,text});return Promise.resolve();}connect(){this.connects++;}close(){this.closes++;}
}
function fixture(t,{outreach=false}={}){
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456',groups:['654321'],outreach:{...defaults.outreach,enabled:outreach}});
  const onebot=new QQ(),social=new Engine('social'),work=new Engine('work'),apiSocial=new Engine('social');
  const bridge=new Bridge(config,{onebot,social,work,apiSocial,stateFile:path.join(temp(t),'sessions.json'),now:()=>now,mergeDelayMs:10,bubbleDelayMs:0});
  bridge.privateMode='chat';t.after(()=>bridge.stop());return {bridge,config,onebot,social,work,apiSocial};
}
const event=(text,id,{group=false,mention=true}={})=>({post_type:'message',message_type:group?'group':'private',self_id:999999,user_id:123456,group_id:654321,message_id:id,message:group&&mention?'[CQ:at,qq=999999]'+text:text,sender:{nickname:'测试'}});

test('consecutive messages merge and messages arriving during generation wait without busy replies',async t=>{
  const f=fixture(t),first=deferred(),started=deferred();
  f.social.run=async(id,prompt)=>{f.social.runs.push(prompt);if(f.social.runs.length===1){started.resolve();return first.promise;}return '下一句也收到';};
  const a=f.bridge.handle(event('我今天有点烦',1)),b=f.bridge.handle(event('项目还没写完',2));await started.promise;
  const c=f.bridge.handle(event('而且明天要交',3));await tick();assert.equal(f.social.runs.length,1);
  first.resolve('先喘口气');await Promise.all([a,b,c]);
  assert.equal(f.social.runs.length,2);assert.match(f.social.runs[0],/我今天有点烦\n项目还没写完/);assert.match(f.social.runs[1],/而且明天要交/);
  assert.deepEqual(f.onebot.sent.map(v=>v.text),['先喘口气','下一句也收到']);assert.equal(f.bridge.queue.pending,0);
});
test('group mention arriving while generation is busy is answered in a later turn',async t=>{
  const f=fixture(t),first=deferred(),started=deferred();
  f.social.run=async(id,prompt)=>{f.social.runs.push(prompt);if(f.social.runs.length===1){started.resolve();return first.promise;}return '收到后一句';};
  const a=f.bridge.handle(event('第一问',1,{group:true}));await started.promise;
  const b=f.bridge.handle(event('第二问',2,{group:true}));first.resolve('收到第一句');await Promise.all([a,b]);
  assert.equal(f.social.runs.length,2);assert.match(f.social.runs[1],/第二问/);assert.equal(f.onebot.sent.length,2);
});
test('bubbles preserve complete content and grapheme clusters even beyond the soft bubble count',()=>{
  const source='这是第一句话，后面还有很多重要的信息不能突然消失。\n还有第二句话，把事情说完再停。\n最后补充一句，收尾也要留着。';
  const bubbles=splitBubbles(source,2);assert.equal(bubbles.length,2);assert.equal(bubbles.join(''),source.replace(/\n/g,''));
  const emoji='👨‍👩‍👧‍👦'.repeat(21);assert.equal(splitBubbles(emoji).join(''),emoji);
});
test('only successful bubbles enter visible history after a delivery failure',async t=>{
  const f=fixture(t);f.social.run=async()=> '第一句\n第二句\n第三句';
  f.onebot.send=async(target,text)=>{if(text==='第二句')throw new Error('offline');f.onebot.sent.push({target,text});};
  await f.bridge.handle(event('聊聊',1));
  assert.equal(f.bridge.outreach.value.history.at(-1).content,'第一句');assert.equal(f.bridge.memory.room('private:123456').recent.at(-1).text,'第一句');
});
test('API history is reconciled to delivered text and SILENT does not erase a prior reply',async t=>{
  let answer='完整的原始回复';const file=path.join(temp(t),'api.json');
  const client=new ApiChatClient({baseUrl:'http://localhost/v1',model:'test',apiKey:''},{historyFile:file,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:answer}}]}))});
  const id=await client.thread(null);await client.run(id,'hi');client.commitReply(id,'实际发出');assert.equal(client.history[id].at(-1).content,'实际发出');
  answer='[SILENT]';await client.run(id,'bye');client.commitReply(id,'');assert.equal(client.history[id].at(-1).content,'实际发出');
});
test('persona and scheduling updates keep QQ, work and project alive, model changes only stop social',async t=>{
  const f=fixture(t),projects={demo:temp(t)};f.config.projects=projects;f.bridge.configure(f.config);f.bridge.project='demo';const connects=f.onebot.connects,closes=f.onebot.closes,stops=f.work.stops;
  f.bridge.configure({...f.config,projects,persona:'新风格',outreach:{...f.config.outreach,idleMinutes:180}});
  assert.equal(f.onebot.connects,connects);assert.equal(f.onebot.closes,closes);assert.equal(f.work.stops,stops);assert.equal(f.bridge.project,'demo');
  f.bridge.configure({...f.bridge.config,chat:{...f.config.chat,provider:'openai',model:'test',baseUrl:'http://localhost/v1'}});
  assert.equal(f.work.stops,stops);assert.equal(f.onebot.connects,connects);assert.ok(f.social.stops>0);
});
test('hot persona update leaves an in-flight response valid; model replacement suppresses old output',async t=>{
  const f=fixture(t);f.bridge.configure(f.config);let complete=deferred(),started=deferred();
  f.social.run=async()=>{started.resolve();return complete.promise;};const first=f.bridge.handle(event('hello',1));await started.promise;
  f.bridge.configure({...f.config,persona:'新语气'});complete.resolve('回复保留');await first;assert.equal(f.onebot.sent.at(-1).text,'回复保留');
  complete=deferred();started=deferred();const second=f.bridge.handle(event('next',2));await started.promise;
  f.bridge.configure({...f.bridge.config,model:'changed'});complete.resolve('旧模型回复');await second;assert.equal(f.onebot.sent.some(v=>v.text==='旧模型回复'),false);
});
test('pause clears queued messages and prevents late delivery',async t=>{
  const f=fixture(t),started=deferred(),complete=deferred();f.social.run=async()=>{started.resolve();return complete.promise;};
  const a=f.bridge.handle(event('第一句',1));await started.promise;const b=f.bridge.handle(event('第二句',2));f.bridge.configure({...f.config,enabled:false});complete.resolve('旧回答');await Promise.all([a,b]);assert.equal(f.onebot.sent.length,0);assert.equal(f.bridge.queue.pending,0);
});
test('quoted relay marker and unsolicited structured action never send group messages',async t=>{
  const f=fixture(t);f.social.run=async()=>JSON.stringify({reply:'它是一个标记',action:{type:'send_group',group:'654321',text:'不该发送'}});
  await f.bridge.handle(event('解释一下[发群]是什么意思',1));assert.equal(f.onebot.sent.some(v=>v.target.type==='group'),false);
  assert.equal(relayIntent('帮我把晚安发到群里'),true);assert.equal(relayIntent('不要把这句话发到群'),false);
  assert.equal(socialReply('{"reply":"好","action":{"type":"send_group","group":"777777","text":"hi"}}',{authorized:true,groups:['654321']}).action,null);
});
test('explicit sourced preferences persist, manual corrections win and deleted facts stay forgotten',t=>{
  const file=path.join(temp(t),'social.json'),s=new SocialState(file),key='private:123456';
  s.incoming(key,'我喜欢猫',{now});assert.equal(s.room(key).memories[0].source,'我喜欢猫');
  const id=s.room(key).memories[0].id;s.edit(key,{id,text:'我现在喜欢狗'},now+1);s.incoming(key,'我喜欢猫',{now:now+2});assert.equal(s.room(key).memories[0].text,'我现在喜欢狗');
  s.edit(key,{id,remove:true},now+3);s.incoming(key,'我喜欢猫',{now:now+4});assert.equal(s.room(key).memories.length,0);
  const restored=new SocialState(file);assert.ok(restored.room(key).forgotten.includes('我喜欢猫'));
  restored.incoming(key,'假设我喜欢鱼',{now});assert.equal(restored.room(key).memories.length,0);
});
test('older excerpts keep original source and time while group context stays isolated',t=>{
  const s=new SocialState(path.join(temp(t),'social.json'));
  for(let n=0;n<25;n++)s.incoming('private:123456','内容'+n,{now:now+n,learn:false});
  assert.equal(s.room('private:123456').recent.length,20);assert.equal(s.room('private:123456').summary[0].text,'内容0');assert.equal(s.room('private:123456').summary[0].at,now);
  s.incoming('group:654321','群消息',{now,learn:false});assert.equal(s.context('group:654321',now).includes('内容0'),false);
});
test('mood changes gradually, decays back to baseline and survives restart',t=>{
  const file=path.join(temp(t),'social.json'),s=new SocialState(file),key='private:123456';
  s.incoming(key,'哈哈，谢谢你',{now});const before=s.room(key).mood.valence;assert.ok(before>0&&before<.5);
  const restored=new SocialState(file);assert.equal(restored.room(key).mood.valence,before);assert.ok(restored.mood(key,now+8*3600000).valence<before/5);
});
test('future topics have a due time, cooldown and asked count; completed events close',t=>{
  const s=new SocialState(path.join(temp(t),'social.json')),key='private:123456';s.incoming(key,'我明天有考试',{now});
  assert.equal(s.eligibleTopics(key,now).length,0);const due=now+25*3600000,topic=s.eligibleTopics(key,due)[0];assert.ok(topic);
  s.asked(key,[topic.id],due);assert.equal(s.eligibleTopics(key,due+3600000).length,0);
  s.incoming(key,'我考完了',{now:due+3600000});assert.equal(s.room(key).topics[0].status,'closed');assert.equal(s.eligibleTopics(key,due+2*86400000).length,0);
});
test('active outreach marks only a delivered selected topic and records the decision',async t=>{
  const f=fixture(t,{outreach:true}),key='private:123456';f.bridge.outreach.incoming('明天有考试',now-3*3600000,true);
  f.bridge.memory.edit(key,{kind:'topic',text:'考试'},now-3*3600000);const topic=f.bridge.memory.room(key).topics[0];
  f.social.run=async()=>JSON.stringify({reply:'考试感觉怎么样',topicId:topic.id});assert.equal(await f.bridge.checkOutreach(),true);
  assert.equal(topic.askedCount,1);assert.equal(f.bridge.telemetry.view(now).decisions.at(-1).reason,'已主动发送，等待回复');
});
test('reported usage is counted, missing usage remains unknown and metrics do not store prompts',async t=>{
  let usage;await chatCompletion({baseUrl:'http://localhost/v1',model:'test',apiKey:''},[],{fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'hi'}}],usage:{prompt_tokens:12,completion_tokens:4}})),onUsage:v=>usage=v});assert.deepEqual(usage,{input:12,output:4});
  const metrics=new Telemetry(path.join(temp(t),'metrics.json'));metrics.record({kind:'chat',provider:'api',model:'test',ok:true,durationMs:100,usage},now);metrics.record({kind:'outreach',provider:'codex',model:'default',ok:false,durationMs:300},now);
  const today=metrics.view(now).today;assert.equal(today.calls,2);assert.equal(today.inputTokens,12);assert.equal(today.outputTokens,4);assert.equal(today.unknownUsage,1);assert.equal(today.averageMs,200);assert.equal(today.failures,1);
});
test('memory API is authenticated, scoped and supports editable facts without reconnecting QQ',async t=>{
  const f=fixture(t),server=createConsole(f.bridge,{config:f.config,token:'test'});await new Promise(r=>server.listen(0,'127.0.0.1',r));f.config.consolePort=server.address().port;t.after(()=>server.close());const url=`http://127.0.0.1:${f.config.consolePort}`;
  assert.equal((await fetch(url+'/api/social')).status,401);const headers={Authorization:'Bearer test','Content-Type':'application/json'};
  assert.equal((await fetch(url+'/api/social?scope=private:555555',{headers})).status,400);
  const result=await (await fetch(url+'/api/social',{method:'POST',headers,body:JSON.stringify({kind:'memory',text:'我喜欢猫'})})).json();assert.equal(result.data.memories[0].text,'我喜欢猫');assert.equal(f.onebot.connects,0);
});
test('queue overflow is explicit and pending cancellation resolves waiters',async()=>{
  const q=new ConversationQueue({delay:20,limit:1});const a=q.push('a',1,async()=>{});await assert.rejects(q.push('a',2,async()=>{}),/队列已满/);q.cancel('a');await a;assert.equal(q.pending,0);
});
test('Anthropic usage includes reported cache reads and writes',async()=>{
  let usage;await chatCompletion({baseUrl:'http://localhost/anthropic',model:'test',apiKey:''},[],{fetchImpl:async()=>new Response(JSON.stringify({content:[{type:'text',text:'hi'}],usage:{input_tokens:10,output_tokens:5,cache_creation_input_tokens:20,cache_read_input_tokens:30}})),onUsage:v=>usage=v});assert.deepEqual(usage,{input:60,output:5});
});
test('memory retrieval finds an older relevant fact beyond the latest sixteen',t=>{
  const s=new SocialState(path.join(temp(t),'social.json')),key='private:123456';s.edit(key,{text:'我的生日是10月1日'},now);
  for(let n=0;n<20;n++)s.edit(key,{text:'一般备注'+n},now+n+1);
  assert.match(s.context(key,now+100,'你还记得我的生日吗'),/我的生日是10月1日/);
});
test('negated plans are not tracked and generic completion closes a single open topic',t=>{
  const s=new SocialState(path.join(temp(t),'social.json')),key='private:123456';s.incoming(key,'我不打算明天去考试',{now});assert.equal(s.room(key).topics.length,0);
  s.incoming(key,'我明天有考试',{now});s.incoming(key,'考试还没结束了',{now:now+1});assert.equal(s.room(key).topics[0].status,'open');
  s.incoming(key,'我搞定了',{now:now+2});assert.equal(s.room(key).topics[0].status,'closed');
});
test('repeated and closed-topic proactive suggestions are blocked by the bridge',async t=>{
  const f=fixture(t,{outreach:true}),key='private:123456';f.bridge.outreach.incoming('面试',now-3*3600000,true);
  f.bridge.memory.edit(key,{kind:'topic',text:'面试',status:'closed'},now-3*3600000);f.social.run=async()=> '面试怎么样';
  assert.equal(await f.bridge.checkOutreach(),false);assert.equal(f.onebot.sent.length,0);
  f.bridge.outreach.value.lastCheckAt=0;f.bridge.outreach.value.history.push({role:'assistant',content:'休息一会吧'});f.social.run=async()=> '休息一会吧';assert.equal(await f.bridge.checkOutreach(),false);assert.equal(f.onebot.sent.length,0);
});
test('new owner input cancels the remaining proactive bubbles, preserving only the bubble already sent',async t=>{
  const f=fixture(t,{outreach:true});f.bridge.outreach.incoming('最近有点累',now-3*3600000,true);f.bridge.bubbleDelayMs=30;f.social.run=async(id,prompt)=>prompt.includes('主动私聊考虑')?'第一句\n不该发的第二句':'新话题';
  const began=deferred(),send=f.onebot.send.bind(f.onebot);f.onebot.send=async(target,text)=>{await send(target,text);if(text==='第一句')began.resolve();};
  const outreach=f.bridge.checkOutreach();await began.promise;await f.bridge.handle(event('我现在有事想聊',1));await outreach;
  assert.deepEqual(f.onebot.sent.map(v=>v.text),['第一句','新话题']);assert.equal(f.bridge.outreach.value.awaitingReply,false);
});
test('legacy persona format is superseded at runtime without changing the saved persona',async t=>{
  const f=fixture(t);f.config.persona='在末尾输出[发群]正文';let persona;f.social.thread=async(id,options)=>{persona=options.persona;return 'social-id';};
  await f.bridge.handle(event('聊聊',1));assert.match(persona,/格式已经停用/);assert.match(persona,/结构化转发/);assert.equal(f.config.persona,'在末尾输出[发群]正文');
});
