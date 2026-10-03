import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Bridge} from '../src/bridge.mjs';
import {ApiChatClient,chatCompletion} from '../src/chat-api.mjs';
import {defaults,validateConfig} from '../src/config.mjs';
import {omniAudio,readAudio,transcribeAudio} from '../src/voice.mjs';
import {configToDraft,buildConfig} from '../public/form-state.js';
import {createConsole} from '../src/server.mjs';

const voice={enabled:true,mode:'omni',baseUrl:'http://127.0.0.1:9999/v1',model:'qwen3.8-omni-flash',apiKey:'test-omni-secret'};
function folder(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-omni-test-'));t.after(()=>{for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);});return dir;}
function wav(dir,size=44){const file=path.join(dir,'sound.wav'),bytes=Buffer.alloc(44);bytes.write('RIFF');bytes.writeUInt32LE(36,4);bytes.write('WAVE',8);fs.writeFileSync(file,bytes);if(size>44)fs.truncateSync(file,size);return file;}
function streamResponse(text,{finished=true,usage={prompt_tokens:42,completion_tokens:9},width=7}={}){
  const frames=[{choices:[{index:0,delta:{reasoning_content:'PRIVATE REASONING'}}]},...Array.from(text).map(v=>({choices:[{index:0,delta:{content:v}}]})),...(finished?[{choices:[{index:0,delta:{},finish_reason:'stop'}]},{choices:[],usage}]:[])];
  const data=Buffer.from(frames.map(v=>'data: '+JSON.stringify(v)+'\r\n\r\n').join('')+(finished?'data: [DONE]\n\n':''));let n=0;
  return new Response(new ReadableStream({pull(controller){if(n===data.length)return controller.close();controller.enqueue(data.subarray(n,n+width));n=Math.min(data.length,n+width);}}),{headers:{'content-type':'text/event-stream'}});
}
class Engine extends EventEmitter{constructor(){super();this.role='work';this.turns=new Map();this.calls=[];}stop(){}async thread(){return 'work';}async run(id,text){this.calls.push(text);return '工作回复';}}
class QQ extends EventEmitter{constructor(file){super();this.file=file;this.connected=true;this.sent=[];this.conversions=[];}connect(){}close(){}async call(action,params){this.conversions.push({action,params});return {file:this.file};}async send(target,text){this.sent.push({target,text});}}
const msg=(id,{text='',audio=false,image=false,group=false,at=true}={})=>({post_type:'message',message_type:group?'group':'private',message_id:id,self_id:999999,user_id:123456,group_id:654321,sender:{nickname:'测试用户'},message:[...(group&&at?[{type:'at',data:{qq:'999999'}}]:[]),...(text?[{type:'text',data:{text}}]:[]),...(audio?[{type:'record',data:{file:'qq-record'}}]:[]),...(image?[{type:'image',data:{url:'https://example.test/cat.png'}}]:[])]});
function fixture(t,{fetchImpl,delay=0}={}){
  const dir=folder(t),onebot=new QQ(wav(dir)),work=new Engine(),social=new Engine();social.role='social';
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456',groups:['654321'],voice});
  const apiOmni=new ApiChatClient({...voice,nativeOmni:true},{historyFile:path.join(dir,'api.json'),fetchImpl});
  const bridge=new Bridge(config,{onebot,work,social,apiOmni,stateFile:path.join(dir,'sessions.json'),mergeDelayMs:delay,bubbleDelayMs:0});bridge.privateMode='chat';t.after(()=>bridge.stop());
  return {bridge,onebot,work,apiOmni,config,dir};
}
test('Omni streaming handles split Chinese bytes, excludes reasoning and records final usage',async()=>{
  let request,usage;const result=await chatCompletion(voice,[{role:'user',content:'hello'}],{stream:true,extraBody:{modalities:['text'],reasoning_effort:'none'},fetchImpl:async(url,options)=>{request={url,options};return streamResponse('你好，听到了',{width:1});},onUsage:v=>usage=v});
  assert.equal(result,'你好，听到了');assert.deepEqual(usage,{input:42,output:9});
  assert.equal(request.url,voice.baseUrl+'/chat/completions');assert.equal(request.options.redirect,'error');
  const body=JSON.parse(request.options.body);assert.equal(body.stream,true);assert.equal(body.stream_options.include_usage,true);assert.equal(body.reasoning_effort,'none');
});
test('Omni never returns a partial stream or reflects provider errors',async()=>{
  await assert.rejects(chatCompletion(voice,[],{stream:true,fetchImpl:async()=>streamResponse('不完整的回答',{finished:false})}),/响应流中断/);
  await assert.rejects(chatCompletion(voice,[],{stream:true,fetchImpl:async()=>new Response('data: '+JSON.stringify({error:{message:voice.apiKey}})+'\n\n',{headers:{'content-type':'text/event-stream'}})}),error=>/响应流报告错误/.test(error.message)&&!error.message.includes(voice.apiKey));
});
test('stream timeout and external cancellation stop waiting without retrying',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){}}),{headers:{'content-type':'text/event-stream'}});};
  const keeper=setInterval(()=>{},10);try{
    await assert.rejects(chatCompletion(voice,[],{stream:true,fetchImpl,timeoutMs:20}),/超时/);
    const controller=new AbortController();setTimeout(()=>controller.abort(),20);
    await assert.rejects(chatCompletion(voice,[],{stream:true,fetchImpl,signal:controller.signal}),/已停止/);assert.equal(calls,2);
  }finally{clearInterval(keeper);}
});
test('private native audio makes one generation request with persona and memory, keeping no Base64 history',async t=>{
  const requests=[];const f=fixture(t,{fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);requests.push({url,body});
    const label=body.messages.at(-1).content.find(v=>v.text?.startsWith('当前音频编号'));
    const id=/当前音频编号 (\w+)/.exec(label.text)[1];
    return streamResponse(JSON.stringify({reply:'小白这名字挺可爱',heard:[{id,text:'我家猫叫小白'}],action:{type:'send_group',text:'不允许语音自动授权'}}));
  }});
  f.bridge.memory.edit('private:123456',{text:'喜欢猫'},1);
  await f.bridge.handle(msg(1,{audio:true}));
  assert.equal(requests.length,1);assert.equal(requests[0].url,voice.baseUrl+'/chat/completions');
  assert.equal(requests[0].body.messages[0].role,'system');assert.ok(requests[0].body.messages[0].content.includes(f.config.persona));
  const content=requests[0].body.messages.at(-1).content;assert.equal(content.filter(v=>v.type==='input_audio').length,1);assert.match(content[0].text,/喜欢猫/);
  assert.equal(f.onebot.conversions[0].action,'get_record');assert.deepEqual(f.onebot.sent.map(v=>v.text),['小白这名字挺可爱']);
  const room=f.bridge.memory.room('private:123456');assert.ok(room.recent.some(v=>v.text.includes('我家猫叫小白')));assert.equal(room.memories.some(v=>v.text.includes('我家猫叫小白')),false);
  const disk=fs.readdirSync(f.dir).filter(v=>v.endsWith('.json')).map(v=>fs.readFileSync(path.join(f.dir,v),'utf8')).join('');assert.equal(disk.includes('base64,'),false);assert.equal(disk.includes(voice.apiKey),false);
});
test('mixed audio, image and text batch goes directly to the same Omni model once',async t=>{
  const requests=[];const f=fixture(t,{delay:10,fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));return streamResponse('猫看着挺精神');}});
  await Promise.all([f.bridge.handle(msg(1,{audio:true})),f.bridge.handle(msg(2,{image:true})),f.bridge.handle(msg(3,{text:'这只猫怎么样'}))]);
  assert.equal(requests.length,1);const parts=requests[0].messages.at(-1).content;
  assert.equal(parts.filter(v=>v.type==='input_audio').length,1);assert.equal(parts.filter(v=>v.type==='image_url').length,1);assert.match(parts[0].text,/这只猫怎么样/);
  const batches=f.bridge.telemetry.view().today;assert.equal(batches.mergedRequests,2);assert.equal(f.bridge.status().chatProvider,'omni');
});
test('SnowLuma converted Base64 takes precedence over its original record path and URL',async t=>{
  let payload;const f=fixture(t,{fetchImpl:async(url,options)=>{payload=JSON.parse(options.body);return streamResponse('听到你了');}});
  const bytes=fs.readFileSync(f.onebot.file);
  f.onebot.call=async()=>({file:'original-qq-record.silk',url:'https://private.invalid/audio',out_format:'wav',base64:bytes.toString('base64')});
  await f.bridge.handle(msg(1,{audio:true}));
  const audio=payload.messages.at(-1).content.find(row=>row.type==='input_audio');
  assert.equal(audio.input_audio.data,`data:;base64,${bytes.toString('base64')}`);
  assert.deepEqual(f.onebot.sent.map(v=>v.text),['听到你了']);
});
test('invalid or oversized gateway Base64 is rejected without falling back to original audio',t=>{
  const bytes=fs.readFileSync(wav(folder(t))),file='original.silk';
  assert.equal(readAudio({base64:'data:audio/wav;base64,'+bytes.toString('base64'),file}).extension,'wav');
  for(const base64 of ['',null,'%%%=',bytes.toString('base64')+'=',bytes.toString('base64').slice(0,-1)])assert.throws(()=>readAudio({base64,file}),/语音网关/);
  assert.throws(()=>readAudio({base64:bytes.toString('base64'),file},{maxBytes:43}),/过大/);
  assert.throws(()=>readAudio({base64:'a'.repeat(200),file},{maxBytes:12}),/过大/);
});
test('ASR also uploads the gateway converted Base64 rather than opening its original file',async t=>{
  const bytes=fs.readFileSync(wav(folder(t)));let uploaded;
  const text=await transcribeAudio(voice,{file:'original.silk',base64:bytes.toString('base64')},{fetchImpl:async(url,options)=>{
    uploaded=Buffer.from(await options.body.get('file').arrayBuffer());return Response.json({text:'转写成功'});
  }});
  assert.equal(text,'转写成功');assert.deepEqual(uploaded,bytes);
});
test('failed pure audio reports an explicit transport failure without asking the model to pretend it heard',async t=>{
  let requests=0;const f=fixture(t,{fetchImpl:async()=>{requests++;throw new Error('Must not call a model');}});
  f.onebot.call=async()=>({file:'original.silk',base64:'invalid-base64'});
  await f.bridge.handle(msg(1,{audio:true}));await f.bridge.handle(msg(2,{audio:true,group:true}));
  f.bridge.tutor={lastAt:Date.now()};await f.bridge.handle(msg(3,{audio:true}));
  assert.equal(requests,0);assert.equal(f.onebot.sent.length,3);
  assert.ok(f.onebot.sent.every(row=>row.text==='语音处理失败，音频没传到模型，请稍后重试。'));
});
test('text follows Omni too, while unmentioned group audio is not fetched or uploaded',async t=>{
  let calls=0;const f=fixture(t,{fetchImpl:async()=>{calls++;return streamResponse('今天聊点啥');}});
  await f.bridge.handle(msg(1,{text:'你好'}));assert.equal(calls,1);
  await f.bridge.handle(msg(2,{audio:true,group:true,at:false}));assert.equal(f.onebot.conversions.length,0);assert.equal(calls,1);
  await f.bridge.handle(msg(3,{audio:true,group:true}));assert.equal(calls,2);assert.equal(f.onebot.conversions.length,1);
  assert.equal(f.onebot.sent.filter(v=>v.target.type==='group').length,1);
});
test('model change suppresses late native replies and discards audio evidence',async t=>{
  let release,started;const pending=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
  const f=fixture(t,{fetchImpl:async()=>{started();await pending;return streamResponse('迟到的回复');}});
  const task=f.bridge.handle(msg(1,{audio:true}));await ready;f.bridge.configure({...f.config,voice:{...voice,enabled:false}});release();await task;
  assert.equal(f.onebot.sent.length,0);assert.equal(f.bridge.chatEngine,f.bridge.social);
});
test('pure native audio in work mode gives a mode hint without starting a work task',async t=>{
  const f=fixture(t,{fetchImpl:async()=>{throw new Error('No model call allowed');}});f.bridge.privateMode='work';
  await f.bridge.handle(msg(1,{audio:true}));
  assert.equal(f.work.calls.length,0);assert.equal(f.onebot.conversions.length,0);
  assert.deepEqual(f.onebot.sent.map(v=>v.text),['工作模式请发文字任务；用 /mode chat 切换后可以聊语音。']);
});
test('native inline audio rejects oversized data before encoding and realtime is rejected before saving',t=>{
  const dir=folder(t);assert.throws(()=>omniAudio(wav(dir,7_000_001)),/音频过大/);
  assert.throws(()=>validateConfig({...defaults,voice:{...voice,model:'qwen3.8-omni-flash-realtime'}}),error=>error.field==='voiceModel');
  const saved=validateConfig({...defaults,voice}),draft=configToDraft(saved);assert.equal(draft.voiceMode,'omni');
  assert.equal(buildConfig(draft,saved,false,false,true).voice.apiKey,'__KEEP__');
  assert.throws(()=>buildConfig({...draft,voiceModel:'qwen3.8-omni-flash-realtime'},saved,false,false,true),error=>error.field==='voiceModel');
});
test('Omni connection test uses fixed text, preserves config and never discloses the key',async t=>{
  const f=fixture(t,{fetchImpl:async()=>{throw new Error('No real call allowed');}}),received=[],saved=[];
  const server=createConsole(f.bridge,{config:f.config,token:'mock-console',persist:value=>saved.push(value),testChat:async config=>received.push(config)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.consolePort=server.address().port;t.after(()=>server.close());
  const base=`http://127.0.0.1:${f.config.consolePort}`,headers={Authorization:'Bearer mock-console','Content-Type':'application/json'};
  const response=await fetch(base+'/api/omni/test',{method:'POST',headers,body:JSON.stringify({voice:{...voice,apiKey:'__KEEP__'}})});
  assert.equal(response.status,200);assert.equal(received[0].nativeOmni,true);assert.equal(received[0].apiKey,voice.apiKey);assert.equal(saved.length,0);
  const state=await(await fetch(base+'/api/state',{headers})).json();assert.equal(state.capabilities.nativeOmni,true);assert.equal(JSON.stringify(state).includes(voice.apiKey),false);
});
