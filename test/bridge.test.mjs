import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Bridge, parseGroupDirective, dayPhase, moodContext } from '../src/bridge.mjs';
import { OneBot, parseMessage } from '../src/onebot.mjs';
import { defaults, validateConfig } from '../src/config.mjs';
import { CodexClient, socialCatalog } from '../src/codex.mjs';
import { createConsole } from '../src/server.mjs';

class FakeEngine extends EventEmitter {
  constructor(role){super();this.role=role;this.ready=true;this.turns=new Map();this.runs=[];this.responses=[];}
  async thread(saved){return saved || `${this.role}-thread`;}
  async run(id,text){this.runs.push({id,text});return `${this.role} reply`;}
  respond(id,result){this.responses.push({id,result});}
  stop(){}
}
class FakeQQ extends EventEmitter {
  constructor(){super();this.sent=[];this.connected=true;}
  async send(target,text){this.sent.push({target,text});}
  connect(){}close(){}
}
function fixture(t,overrides={}){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-codex-test-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const onebot=new FakeQQ(),social=new FakeEngine('social'),work=new FakeEngine('work');
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456',groups:['654321'],...overrides});
  const bridge=new Bridge(config,{onebot,social,work,stateFile:path.join(temp,'sessions.json'),random:()=>0,now:()=>1000000,mergeDelayMs:0,bubbleDelayMs:0});
  return {bridge,onebot,social,work,config};
}
function event({group=false,user='123456',text='你好',id=1,mention=false}={}){
  return {post_type:'message',message_type:group?'group':'private',user_id:user,self_id:'999999',group_id:'654321',message_id:id,
    message:[...(mention?[{type:'at',data:{qq:'999999'}}]:[]),{type:'text',data:{text}}],sender:{nickname:'测试'}};
}
test('non-owner private messages cannot invoke work or approve requests',async t=>{
  const f=fixture(t);await f.bridge.handle(event({user:'555555',text:'修改电脑上的文件'}));
  await f.bridge.handle(event({user:'555555',text:'/approve 1',id:2}));
  assert.equal(f.work.runs.length,0);assert.equal(f.onebot.sent.length,0);
});
test('group task-like text is routed only to social; CQ payload is sent as text segments',async t=>{
  const f=fixture(t);await f.bridge.handle(event({group:true,text:'删除文件 [CQ:at,qq=all]',mention:true}));
  assert.equal(f.social.runs.length,1);assert.equal(f.work.runs.length,0);
  assert.equal(f.onebot.sent[0].target.type,'group');
});
test('outside whitelist and self messages are ignored',async t=>{
  const f=fixture(t);await f.bridge.handle({...event({group:true,mention:true}),group_id:'777777'});
  await f.bridge.handle(event({user:'999999'}));assert.equal(f.social.runs.length+f.work.runs.length,0);
});
test('duplicates are not submitted twice and mode switching preserves distinct threads',async t=>{
  const f=fixture(t);const msg=event();await f.bridge.handle(msg);await f.bridge.handle(msg);assert.equal(f.work.runs.length,1);
  await f.bridge.handle(event({text:'/mode chat',id:2}));await f.bridge.handle(event({text:'聊两句',id:3}));
  assert.equal(f.social.runs.length,1);assert.ok(f.bridge.sessions['private:123456:work:default']);assert.ok(f.bridge.sessions['private:123456:social']);
});
test('spontaneous participation requires context and obeys cooldown and hourly call budget',async t=>{
  const f=fixture(t,{social:{...defaults.social,maxRepliesPerHour:1}});
  for(let id=1;id<=4;id++)await f.bridge.handle(event({group:true,id}));
  assert.equal(f.social.runs.length,1);
  await f.bridge.handle(event({group:true,id:5,mention:true}));assert.equal(f.social.runs.length,1);
});
test('pausing or removing a group prevents late replies',async t=>{
  const f=fixture(t);const generation=f.bridge.generation;f.bridge.configure({...f.config,enabled:false});
  await f.bridge.send({type:'group',group:'654321'},'迟到的回复',generation);assert.equal(f.onebot.sent.length,0);
});
test('approval is bound to active owner thread; it approves one operation only',async t=>{
  const f=fixture(t),target={type:'private',user:'123456'};
  f.work.turns.set('work-thread',{turnId:'turn-1'});f.bridge.workTargets.set('work-thread',{target,key:'private:123456',generation:0});
  await f.bridge.handleRequest({id:18,method:'item/commandExecution/requestApproval',params:{threadId:'work-thread',turnId:'turn-1',command:'echo test'}});
  const token=[...f.bridge.approvals.keys()][0];assert.ok(token);
  await f.bridge.handle(event({user:'555555',text:`/approve ${token}`}));assert.equal(f.work.responses.length,0);
  await f.bridge.handle(event({text:`/approve ${token}`,id:2}));assert.deepEqual(f.work.responses,[{id:18,result:{decision:'accept'}}]);
  assert.equal(f.bridge.approvals.size,0);
  await f.bridge.handle(event({text:`/approve ${token}`,id:3}));assert.equal(f.work.responses.length,1);
});
test('social catalogue removes shell, file editing, external tools and code mode',()=>{
  const result=socialCatalog({models:[{slug:'test-model',shell_type:'unified_exec',apply_patch_tool_type:'freeform',experimental_supported_tools:['clock'],tool_mode:'code_mode_only'}]}).models[0];
  assert.equal(result.shell_type,'disabled');assert.equal(result.apply_patch_tool_type,null);assert.deepEqual(result.experimental_supported_tools,[]);assert.equal(result.tool_mode,'direct');assert.equal(result.node_repl_disabled,true);
});
test('invalid token, empty owner on enable and remote OneBot are rejected',()=>{
  assert.throws(()=>validateConfig({...defaults,enabled:true}),/管理员/);
  assert.throws(()=>validateConfig({...defaults,onebot:{...defaults.onebot,wsUrl:'ws://evil.example:3001'}}),/本机/);
  assert.throws(()=>validateConfig({...defaults,onebot:{...defaults.onebot,accessToken:'a\r\nb'}}),/令牌/);
});
test('plain CQ string mentions are recognized without executing CQ text',()=>{
  const msg=parseMessage({...event({group:true}),message:'[CQ:at,qq=999999]你好[CQ:image,file=test]'});
  assert.equal(msg.mentioned,true);assert.equal(msg.text,'你好');
});
test('OneBot actual websocket roundtrip authenticates and safely formats outgoing text',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const bot=new OneBot(()=>{});t.after(()=>{bot.close();server.close();});let received,auth;
  server.on('connection',(socket,request)=>{auth=request.headers.authorization;socket.on('message',raw=>{const packet=JSON.parse(raw);if(packet.action==='send_group_msg')received=packet;
    socket.send(JSON.stringify({echo:packet.echo,status:'ok',retcode:0,data:packet.action==='get_login_info'?{user_id:999999}:{message_id:7}}));});});
  const ready=once(bot,'ready');bot.connect({wsUrl:`ws://127.0.0.1:${server.address().port}`,accessToken:'local-test-token'});await ready;
  await bot.send({type:'group',group:'654321'},'[CQ:at,qq=all]');
  assert.equal(auth,'Bearer local-test-token');assert.deepEqual(received.params.message,[{type:'text',data:{text:'[CQ:at,qq=all]'}}]);
});
test('console rejects absent, unicode tokens and foreign/malformed origins; hides saved credentials',async t=>{
  const f=fixture(t);f.config.onebot.accessToken='secret-test-token';
  const server=createConsole(f.bridge,{config:f.config,token:'a'.repeat(64)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.consolePort=server.address().port;
  t.after(()=>server.close());const url=`http://127.0.0.1:${f.config.consolePort}`;
  assert.equal((await fetch(url+'/api/state')).status,401);
  assert.equal((await fetch(url+'/api/state',{headers:{Authorization:'Bearer '+'é'.repeat(64)}})).status,401);
  assert.equal((await fetch(url+'/api/state',{headers:{Authorization:'Bearer '+'a'.repeat(64),Origin:'null'}})).status,403);
  assert.equal((await fetch(url+'/api/state',{headers:{Authorization:'Bearer '+'a'.repeat(64),Origin:'https://evil.example'}})).status,403);
  const result=await(await fetch(url+'/api/state',{headers:{Authorization:'Bearer '+'a'.repeat(64)}})).json();
  assert.equal(result.config.onebot.accessToken,'');assert.equal(result.hasOnebotToken,true);
});
test('OneBot receives converted inline audio larger than the old 1 MiB frame limit',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const bot=new OneBot(()=>{});t.after(()=>{bot.close();server.close();});
  const base64=Buffer.alloc(900000).toString('base64');
  server.on('connection',socket=>socket.on('message',raw=>{
    const packet=JSON.parse(raw);socket.send(JSON.stringify({echo:packet.echo,status:'ok',retcode:0,data:packet.action==='get_login_info'?{user_id:999999}:{file:'original.silk',out_format:'wav',base64}}));
  }));
  const ready=once(bot,'ready');bot.connect({wsUrl:`ws://127.0.0.1:${server.address().port}`,accessToken:'test'});await ready;
  const result=await bot.call('get_record',{file:'record',out_format:'wav'});
  assert.equal(result.base64,base64);assert.equal(bot.connected,true);
});
test('an unsuccessful turn is not reported as completion and final phase excludes commentary',async()=>{
  const client=new CodexClient('work',()=>{});client.proc={exitCode:null,stdin:{write(){} }};
  let resolved, rejected;const timer=setTimeout(()=>{},1000);
  client.turns.set('t',{timer,messages:new Map(),resolve:v=>resolved=v,reject:e=>rejected=e});
  client.receive({method:'item/completed',params:{threadId:'t',item:{id:'1',type:'agentMessage',phase:'commentary',text:'处理中'}}});
  client.receive({method:'item/completed',params:{threadId:'t',item:{id:'2',type:'agentMessage',phase:'final_answer',text:'完成'}}});
  client.receive({method:'turn/completed',params:{threadId:'t',turn:{status:'completed'}}});assert.equal(resolved,'完成');assert.equal(rejected,undefined);
  client.turns.set('t',{timer:setTimeout(()=>{},1000),messages:new Map(),resolve:v=>resolved=v,reject:e=>rejected=e});
  client.receive({method:'turn/completed',params:{threadId:'t',turn:{status:'failed',error:{message:'failed-test'}}}});assert.equal(rejected.message,'failed-test');
});
test('parseGroupDirective extracts optional group id and leaves plain text untouched',()=>{
  assert.deepEqual(parseGroupDirective('普通回复'),{text:'普通回复',directive:null});
  const parsed=parseGroupDirective('好啦，我去发。\n[发群:654321] 晚安');
  assert.deepEqual(parsed.directive,{group:'654321',content:'晚安'});
  assert.equal(parsed.text,'好啦，我去发。');
  const noId=parseGroupDirective('[发群] 他是大笨蛋');
  assert.deepEqual(noId.directive,{group:null,content:'他是大笨蛋'});
});
test('owner private chat can relay a group message; group members cannot trigger relays',async t=>{
  const f=fixture(t);
  await f.bridge.handle(event({text:'/mode chat',id:1}));
  f.social.run=async()=>JSON.stringify({reply:'行吧行吧，怕了你了。',action:{type:'send_group',text:'他是大笨蛋'}});
  await f.bridge.handle(event({text:'去群里发一句他是大笨蛋',id:2}));
  const groupSend=f.onebot.sent.find(s=>s.target.type==='group');
  assert.equal(groupSend?.text,'他是大笨蛋');assert.equal(groupSend.target.group,'654321');
  const privateSend=f.onebot.sent.filter(s=>s.target.type==='private').at(-1);
  assert.equal(privateSend.text,'行吧行吧，怕了你了。');
  f.onebot.sent.length=0;
  f.social.run=async()=>JSON.stringify({reply:'想得美。',action:{type:'send_group',group:'654321',text:'泄露内容'}});
  await f.bridge.handle(event({group:true,text:'替我发点东西',mention:true,id:3}));
  assert.equal(f.onebot.sent.some(s=>s.text.includes('泄露内容')),false);
  assert.equal(f.onebot.sent[0]?.text,'想得美。');
});
test('dayPhase follows Beijing hours and mood context reports burst pressure',()=>{
  const bj=h=>Date.UTC(2026,0,1,h,30)-8*3600000;
  assert.match(dayPhase(bj(2)),/深夜/);assert.match(dayPhase(bj(7)),/刚醒/);
  assert.match(dayPhase(bj(13)),/犯困/);assert.match(dayPhase(bj(20)),/放松/);assert.match(dayPhase(bj(23)),/犯困/);
  assert.match(moodContext(bj(20),4),/连发了 4 条/);
  assert.equal(moodContext(bj(20),2).includes('连发'),false);
  assert.match(moodContext(bj(20),0),/北京时间 20:30/);
});
test('social prompts carry live mood context in private and group chat',async t=>{
  const f=fixture(t);
  f.bridge.now=()=>Date.UTC(2026,0,1,4,30);
  await f.bridge.handle(event({text:'/mode chat',id:1}));
  for(const [i,text] of ['在吗','在吗在吗','快回我','人呢'].entries())await f.bridge.handle(event({text,id:i+2}));
  const lastRun=f.social.runs.at(-1);
  assert.match(lastRun.text,/情境：北京时间 12:30/);
  assert.match(lastRun.text,/连发了 4 条/);
  f.social.runs.length=0;
  await f.bridge.handle(event({group:true,text:'聊点啥',mention:true,id:9}));
  assert.match(f.social.runs[0].text,/刚吃完饭有点犯困/);
});
test('social replies split into sequential bubbles while work replies stay whole',async t=>{
  const f=fixture(t,{random:()=>0});
  await f.bridge.handle(event({text:'/mode chat',id:1}));
  f.social.run=async()=>'怎么了\n刚被老板骂\n想吐槽会儿';
  await f.bridge.handle(event({text:'你今天咋样',id:2}));
  const priv=f.onebot.sent.filter(s=>s.target.type==='private').slice(-3);
  assert.deepEqual(priv.map(s=>s.text),['怎么了','刚被老板骂','想吐槽会儿']);
  f.onebot.sent.length=0;
  await f.bridge.handle(event({text:'/mode work',id:3}));
  f.work.run=async()=>'x'.repeat(80);
  await f.bridge.handle(event({text:'跑个任务',id:4}));
  const workReply=f.onebot.sent.filter(s=>s.target.type==='private').at(-1);
  assert.equal(workReply.text.length,80);assert.equal(workReply.text.includes('\n'),false);
});
test('persona change rotates social threads while work threads survive',async t=>{
  const f=fixture(t);
  f.bridge.sessions['private:123456:social']='old-social';
  f.bridge.sessions['group:654321:social']='old-group-social';
  f.bridge.sessions['private:123456:work:default']='old-work';
  f.bridge.configure({...f.config,persona:'全新的人设内容'});
  assert.equal(f.bridge.sessions['private:123456:social'],undefined);
  assert.equal(f.bridge.sessions['group:654321:social'],undefined);
  assert.equal(f.bridge.sessions['private:123456:work:default'],'old-work');
  f.bridge.sessions['private:123456:social']='new-social';
  f.bridge.configure({...f.config,persona:'全新的人设内容'});
  assert.equal(f.bridge.sessions['private:123456:social'],'new-social');
});
test('multimodal messages carry faces, images and voice into context notes',async t=>{
  const f=fixture(t);
  const note=await f.bridge.modalityContext({voice:true,faces:['999999'],images:[]});
  assert.match(note,/语音识别未启用/);assert.match(note,/表情：/);
  const msg=parseMessage({post_type:'message',message_type:'private',user_id:123456,self_id:999999,message_id:77,
    message:[{type:'image',data:{url:'http://x/y.jpg'}},{type:'face',data:{id:'1'}},{type:'record',data:{}}],sender:{nickname:'测试'}});
  assert.equal(msg.text,'');assert.equal(msg.images.length,1);assert.equal(msg.faces.length,1);assert.equal(msg.voice,true);
  const codexNote=await f.bridge.modalityContext({images:['http://x/y.jpg']});
  assert.match(codexNote,/看不了内容/);
});

test('private voice converts through OneBot, transcribes separately and answers the current input',async t=>{
  const f=fixture(t,{voice:{enabled:true,baseUrl:'http://127.0.0.1:9999/v1',model:'mock-asr',apiKey:'separate-voice-key'}});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-voice-flow-'));
  const file=path.join(temp,'record.wav'),audio=Buffer.alloc(44);
  audio.write('RIFF');audio.writeUInt32LE(36,4);audio.write('WAVE',8);fs.writeFileSync(file,audio);
  t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(temp);});
  await f.bridge.handle(event({text:'/mode chat',id:1}));f.onebot.sent.length=0;
  const conversions=[],uploads=[];
  f.onebot.call=async(action,params)=>{conversions.push({action,params});return {file};};
  f.bridge.apiSocial.fetchImpl=async(url,options)=>{
    uploads.push({url,key:options.headers.Authorization,model:options.body.get('model')});
    return new Response(JSON.stringify({text:'我家的猫叫小白'}));
  };
  f.social.run=async(id,text)=>{f.social.runs.push({id,text});return '小白这名字挺可爱';};
  await f.bridge.handle({...event({id:2}),message:[{type:'record',data:{file:'gateway-record'}}]});
  assert.deepEqual(conversions,[{action:'get_record',params:{file:'gateway-record',out_format:'wav'}}]);
  assert.deepEqual(uploads,[{url:'http://127.0.0.1:9999/v1/audio/transcriptions',key:'Bearer separate-voice-key',model:'mock-asr'}]);
  assert.equal(f.social.runs.length,1);assert.match(f.social.runs[0].text,/语音转写：我家的猫叫小白/);
  assert.deepEqual(f.onebot.sent.map(v=>v.text),['小白这名字挺可爱']);
  assert.ok(f.bridge.memory.room('private:123456').recent.some(v=>v.role==='user'&&v.text.includes('我家的猫叫小白')));
});
test('tutor session explains stepwise, keeps follow-ups in tutor thread until exit',async t=>{
  const f=fixture(t);
  await f.bridge.handle(event({text:'/讲题 1+1等于几',id:1}));
  assert.ok(f.bridge.tutor);
  assert.equal(f.social.runs.length,1);
  assert.match(f.social.runs[0].text,/1\+1等于几/);
  assert.ok(f.onebot.sent.some(s=>s.text.includes('讲题会话开始')));
  f.onebot.sent.length=0;f.social.runs.length=0;
  await f.bridge.handle(event({text:'这步没懂',id:2}));
  assert.equal(f.social.runs.length,1);
  assert.match(f.social.runs[0].text,/这步没懂/);
  f.social.runs.length=0;
  await f.bridge.handle(event({text:'/退出讲题',id:3}));
  assert.equal(f.bridge.tutor,null);
  await f.bridge.handle(event({text:'聊点别的',id:4}));
  assert.equal(f.social.runs.length,0);
  assert.equal(f.work.runs.length,1);
});
test('mixed [SILENT] lines are stripped from replies and bubbles',async()=>{
  const { socialReply, splitBubbles } = await import('../src/conversation.mjs');
  assert.deepEqual(socialReply('你呢 有啥事吗\n[SILENT]'),{text:'你呢 有啥事吗',action:null});
  assert.deepEqual(socialReply('[SILENT]'),{text:'',action:null});
  assert.deepEqual(splitBubbles('先答一句\n[SILENT]\n再答一句',4),['先答一句','再答一句']);
});
test('effective persona always prefixes the configured base rules',async t=>{
  const f=fixture(t);
  const base=f.bridge.config.basePersona;
  assert.ok(base&&base.length>100);
  f.bridge.config={...f.bridge.config,persona:'只有一点差异设定'};
  assert.ok(f.bridge.effectivePersona.startsWith(base));
  assert.ok(f.bridge.effectivePersona.includes('只有一点差异设定'));
  const f2=fixture(t);
  f2.bridge.config={...f2.bridge.config,persona:'',basePersona:'自己的一套底座'};
  assert.equal(f2.bridge.effectivePersona.trim(),'自己的一套底座');
});
