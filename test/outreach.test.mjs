import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/bridge.mjs';
import { defaults,validateConfig } from '../src/config.mjs';
import { OutreachState,outreachGate,calendar } from '../src/outreach.mjs';
import { configToDraft,buildConfig } from '../public/form-state.js';

class Engine extends EventEmitter {
  constructor(role){super();this.role=role;this.ready=true;this.turns=new Map();this.runs=[];this.answer='上回那个弄好了没';}
  async thread(id){return id||this.role+'-thread';}
  async run(id,prompt){this.runs.push(prompt);return this.answer;}
  stop(){}configure(){}async interrupt(){}
}
class QQ extends EventEmitter {
  constructor(){super();this.connected=true;this.sent=[];}
  async send(target,text){this.sent.push({target,text});}
  close(){}connect(){}
}
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-outreach-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let time=Date.parse('2026-09-29T06:00:00Z');
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456',outreach:{...defaults.outreach,enabled:true}});
  const onebot=new QQ(),social=new Engine('social'),work=new Engine('work'),apiSocial=new Engine('social');
  const stateFile=path.join(dir,'sessions.json');
  const bridge=new Bridge(config,{onebot,social,work,apiSocial,stateFile,now:()=>time});t.after(()=>bridge.stop());
  return {bridge,config,onebot,social,work,stateFile,time:()=>time,setTime:t=>time=t,seed:()=>{bridge.outreach.incoming('我昨天在弄一个机器人',time-3*3600000,true);}};
}
const event=(text,id,user=123456)=>({post_type:'message',message_type:'private',self_id:999999,user_id:user,message_id:id,message:text});

test('outreach gates avoid calls outside hours, before idle, offline, busy, work mode or with no topic',async t=>{
  const f=fixture(t);assert.equal(await f.bridge.checkOutreach(),false);assert.equal(f.social.runs.length,0);
  f.seed();const state=f.bridge.outreach.value;
  const context={now:f.time(),connected:true,busy:false,privateMode:'chat'};
  assert.equal(outreachGate(f.config,state,context),'');
  for(const change of [{connected:false},{busy:true},{privateMode:'work'},{now:Date.parse('2026-09-29T01:00:00Z')}])assert.ok(outreachGate(f.config,state,{...context,...change}));
  f.bridge.outreach.incoming('刚刚的消息',f.time(),true);assert.match(outreachGate(f.config,state,context),/安静时长/);
  assert.equal(await f.bridge.checkOutreach(),false);assert.equal(f.social.runs.length,0);
});
test('proactive send targets only owner, waits for a reply across restart, and enforces daily sends',async t=>{
  const f=fixture(t);f.seed();assert.equal(await f.bridge.checkOutreach(),true);
  assert.deepEqual(f.onebot.sent[0].target,{type:'private',user:'123456'});assert.equal(f.bridge.outreach.value.sentToday,1);
  f.setTime(f.time()+3*3600000);assert.equal(await f.bridge.checkOutreach(),false);assert.equal(f.social.runs.length,1);
  const restored=new OutreachState(f.stateFile+'.outreach.json',f.config.ownerQQ);assert.equal(restored.value.awaitingReply,true);assert.equal(restored.value.sentToday,1);
  await f.bridge.handle(event('弄好了',1));assert.equal(f.bridge.outreach.value.awaitingReply,false);
  f.social.answer='今天状态好点没';
  f.setTime(f.time()+3*3600000);assert.equal(await f.bridge.checkOutreach(),true);assert.equal(f.bridge.outreach.value.sentToday,2);
  f.bridge.outreach.incoming('嗯',f.time()-3*3600000,true);f.bridge.outreach.value.lastOutgoingAt=f.time()-3*3600000;
  assert.equal(await f.bridge.checkOutreach(),false);assert.match(f.bridge.outreachStatus().reason,/次数已用完/);
  assert.equal(new OutreachState(f.stateFile+'.outreach.json','other-owner').value.history.length,0);
});
test('silence and failures consume a bounded judgment budget but never send or immediately repeat',async t=>{
  const f=fixture(t);f.seed();f.social.answer='[SILENT]';
  for(let i=0;i<6;i++){assert.equal(await f.bridge.checkOutreach(),false);assert.equal(await f.bridge.checkOutreach(),false);f.setTime(f.time()+3600000);}
  assert.equal(f.social.runs.length,6);assert.equal(f.onebot.sent.length,0);assert.match(f.bridge.outreachStatus().reason,/判断次数/);
  f.setTime(Date.parse('2026-09-30T02:00:00Z'));assert.equal(await f.bridge.checkOutreach(),false);assert.equal(f.social.runs.length,7);assert.equal(f.bridge.outreach.value.checksToday,1);
  f.setTime(f.time()+3600000);f.social.run=async()=>{throw new Error('provider down');};assert.equal(await f.bridge.checkOutreach(),false);assert.equal(f.bridge.outreach.value.checksToday,2);assert.equal(f.onebot.sent.length,0);
});
test('incoming message cancels in-progress outreach and is answered normally; concurrent checks only call once',async t=>{
  const f=fixture(t);f.seed();let complete,started;
  const began=new Promise(resolve=>started=resolve);f.social.run=async(id,prompt)=>{
    f.social.runs.push(prompt);if(f.social.runs.length===1){started();return new Promise(resolve=>complete=resolve);}return '接上你这句';
  };
  f.social.interrupt=async()=>complete('不该发出的旧话题');
  const first=f.bridge.checkOutreach();await began;const duplicate=f.bridge.checkOutreach();
  await f.bridge.handle(event('我又想到一个问题',1));await Promise.all([first,duplicate]);
  assert.equal(f.social.runs.length,2);assert.equal(f.onebot.sent.length,1);assert.equal(f.onebot.sent[0].text,'接上你这句');assert.equal(f.bridge.outreach.value.sentToday,0);assert.equal(f.bridge.busy.size,0);
});
test('config pause and generation changes suppress late proactive replies; pause and mode survive restarts',async t=>{
  const f=fixture(t);f.seed();let complete,started;const began=new Promise(resolve=>started=resolve);
  f.social.run=async()=>{started();return new Promise(resolve=>complete=resolve);};
  const pending=f.bridge.checkOutreach();await began;f.bridge.configure({...f.config,outreach:{...f.config.outreach,enabled:false}});complete('迟来的话');await pending;assert.equal(f.onebot.sent.length,0);
  f.bridge.configure(f.config);await f.bridge.handle(event('/outreach pause',1));assert.equal(f.bridge.outreachPaused,true);assert.equal(await f.bridge.checkOutreach(),false);
  await f.bridge.handle(event('/mode work',2));const restored=new OutreachState(f.stateFile+'.outreach.json',f.config.ownerQQ);assert.equal(restored.value.paused,true);assert.equal(restored.value.privateMode,'work');
});
test('outreach fields reject invalid activity windows and blank values and calendar uses Beijing dates',()=>{
  const draft=configToDraft(defaults);
  for(const [field,value]of [['outreachStart','24'],['outreachEnd','9'],['outreachIdle',''],['outreachCheck','14'],['outreachMax','11']])assert.throws(()=>buildConfig({...draft,[field]:value},defaults,false),error=>error.field===field);
  assert.throws(()=>validateConfig({...defaults,outreach:{...defaults.outreach,startHour:22,endHour:10}}),error=>error.field==='outreachEnd');
  assert.deepEqual(calendar(Date.parse('2026-09-29T16:00:00Z')),{day:'2026-09-30',hour:0});
});
