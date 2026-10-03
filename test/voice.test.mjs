import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {transcribeAudio} from '../src/voice.mjs';
import {defaults,validateConfig} from '../src/config.mjs';
import {configToDraft,buildConfig} from '../public/form-state.js';
import {createConsole} from '../src/server.mjs';

function wave(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-voice-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'record.wav'),data=Buffer.alloc(44);data.write('RIFF');data.writeUInt32LE(36,4);data.write('WAVE',8);fs.writeFileSync(file,data);return file;}
const config={enabled:true,baseUrl:'http://127.0.0.1:9999/v1',model:'mock-asr',apiKey:'voice-test-secret'};
test('ASR uploads audio bytes and separate credentials to the configured compatible endpoint',async t=>{
  let request;const text=await transcribeAudio(config,wave(t),{fetchImpl:async(url,options)=>{request={url,options};return new Response(JSON.stringify({text:'我喜欢猫'}));}});
  assert.equal(text,'我喜欢猫');assert.equal(request.url,config.baseUrl+'/audio/transcriptions');
  assert.equal(request.options.headers.Authorization,'Bearer voice-test-secret');assert.equal(request.options.redirect,'error');
  assert.equal(request.options.body.get('model'),'mock-asr');assert.equal(request.options.body.get('file').name,'record.wav');assert.equal(request.options.body.get('file').size,44);
  assert.equal(Object.hasOwn(request.options.headers,'Content-Type'),false);
});
test('ASR rejects disabled, unsupported, oversized and cancelled inputs before any upload',async t=>{
  const file=wave(t);let calls=0;const fetchImpl=async()=>{calls++;return new Response('{}');};
  await assert.rejects(transcribeAudio({...config,enabled:false},file,{fetchImpl}),/未启用/);
  fs.writeFileSync(file,'this is private text and not audio');await assert.rejects(transcribeAudio(config,file,{fetchImpl}),/格式不支持/);
  fs.truncateSync(file,21*1024*1024);await assert.rejects(transcribeAudio(config,file,{fetchImpl}),/20 MiB/);
  await assert.rejects(transcribeAudio(config,file,{fetchImpl,signal:AbortSignal.abort()}),/取消/);assert.equal(calls,0);
});
test('ASR provider failures never reflect a key or raw provider response',async t=>{
  const file=wave(t);
  await assert.rejects(transcribeAudio(config,file,{fetchImpl:async()=>new Response('voice-test-secret',{status:401})}),error=>/HTTP 401/.test(error.message)&&!error.message.includes('voice-test-secret'));
  await assert.rejects(transcribeAudio(config,file,{fetchImpl:async()=>{throw new Error('voice-test-secret');}}),error=>/请求失败/.test(error.message)&&!error.message.includes('voice-test-secret'));
  await assert.rejects(transcribeAudio(config,file,{fetchImpl:async()=>new Response('{}')}),/没有返回文字/);
});
test('voice drafts preserve keys only for the same origin; enabling requires a model and remote credentials',()=>{
  const saved=validateConfig({...defaults,voice:config}),draft=configToDraft(saved);
  assert.equal(buildConfig(draft,saved,false,false,true).voice.apiKey,'__KEEP__');
  assert.throws(()=>buildConfig({...draft,voiceBase:'https://other.example/v1'},saved,false,false,true),error=>error.field==='voiceKey');
  assert.throws(()=>buildConfig({...draft,voiceModel:''},saved,false,false,true),error=>error.field==='voiceModel');
  assert.throws(()=>validateConfig({...defaults,voice:{...config,baseUrl:'https://api.example/v1',apiKey:''}}),error=>error.field==='voiceKey');
  assert.equal(buildConfig({...draft,voiceEnabled:false,voiceModel:'',clearVoiceKey:true},saved,false,false,true).voice.apiKey,'');
});
test('console hides voice credentials and refuses retained-key forwarding across origins',async t=>{
  const saved=validateConfig({...defaults,voice:config}),writes=[];
  const bridge={config:saved,status:()=>({}),configure:()=>{}};
  const server=createConsole(bridge,{config:saved,token:'test-console',persist:next=>writes.push(next)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));saved.consolePort=server.address().port;t.after(()=>server.close());
  const base=`http://127.0.0.1:${saved.consolePort}`,headers={Authorization:'Bearer test-console','Content-Type':'application/json'};
  const state=await(await fetch(base+'/api/state',{headers})).json();assert.equal(state.hasVoiceKey,true);assert.equal(state.config.voice.apiKey,'');assert.equal(JSON.stringify(state).includes(config.apiKey),false);
  const payload={...state.config,voice:{...state.config.voice,apiKey:'__KEEP__'},persona:'updated'};
  assert.equal((await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify(payload)})).status,200);
  assert.equal(writes[0].voice.apiKey,config.apiKey);
  payload.voice.baseUrl='https://different.example/v1';assert.equal((await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify(payload)})).status,400);assert.equal(writes.length,1);
});
