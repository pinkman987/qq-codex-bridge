import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createConsole} from '../src/server.mjs';
import {defaults,validateConfig} from '../src/config.mjs';
import {ApiChatClient} from '../src/chat-api.mjs';
import {reviewLines,validateReviewedLog} from '../public/form-state.js';

async function setup(t,run,interrupt=async()=>{},engineFactory=null){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-distill-job-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config=validateConfig({...defaults,ownerQQ:'123456'});
  const calls=[];
  const engine=engineFactory?engineFactory(dir):{thread:async()=> 'job-thread',run:async(...args)=>{calls.push(args);return run(...args);},interrupt};
  const bridge={config,status:()=>({selfId:'987654'}),chatEngine:engine,configure(next){this.config=next;return 'applied';}};
  const jobFile=path.join(dir,'job.json');
  const server=createConsole(bridge,{token:'test-token',config,distillJobFile:jobFile,persist:()=>{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  config.consolePort=server.address().port;
  const base=`http://127.0.0.1:${config.consolePort}`;
  const headers={Authorization:'Bearer test-token','Content-Type':'application/json'};
  const request=async(method,route,body)=>{
    const response=await fetch(base+route,{method,headers,body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json()};
  };
  const phase=async target=>{
    for(let i=0;i<100;i++){
      const {data}=await request('GET','/api/distill/progress');
      if(data.phase===target)return data;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error(`never reached ${target}`);
  };
  return {request,phase,calls,jobFile,config,bridge,server,base,headers};
}

async function simultaneousPosts(api,route,bodies){
  let received=0,ready;
  const started=new Promise(resolve=>{ready=resolve;});
  const listener=()=>{if(++received===bodies.length){api.server.off('request',listener);ready();}};
  api.server.on('request',listener);
  const writers=[];
  const results=bodies.map(body=>new Promise((resolve,reject)=>{
    const request=http.request(api.base+route,{method:'POST',headers:api.headers},response=>{
      let raw='';response.on('data',chunk=>raw+=chunk);response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(raw)}));response.on('error',reject);
    });
    request.on('error',reject);request.write('{');writers.push(()=>request.end(JSON.stringify(body).slice(1)));
  }));
  await started;for(const write of writers)write();return Promise.all(results);
}

test('simultaneous uploads and repeated review confirmations cannot start duplicate distillation jobs',async t=>{
  const api=await setup(t,()=> '最终结果');
  const text=Array.from({length:10},(_,i)=>`对方：消息${i+1}`).join('\n');
  const uploads=await simultaneousPosts(api,'/api/distill',[{text},{text}]);
  assert.deepEqual(uploads.map(result=>result.status).sort(),[202,409]);
  const {id}=uploads.find(result=>result.status===202).data;await api.phase('review');
  const confirmations=await simultaneousPosts(api,'/api/distill/confirm',[{id,text},{id,text}]);
  assert.deepEqual(confirmations.map(result=>result.status).sort(),[202,409]);
  await api.phase('done');assert.equal(api.calls.length,1);
});

test('configuration revision is checked again after reading concurrently uploaded bodies',async t=>{
  const api=await setup(t,()=> 'unused');
  const {data}=await api.request('GET','/api/state');api.headers['If-Match']=data.revision;
  const saves=await simultaneousPosts(api,'/api/config',[{...api.config,ownerQQ:'222222'},{...api.config,ownerQQ:'333333'}]);
  assert.deepEqual(saves.map(result=>result.status).sort(),[200,409]);
  assert.equal(api.bridge.config.ownerQQ,saves[0].status===200?'222222':'333333');
});

test('2000 imported multiline messages remain 2000 review records and can be confirmed',async t=>{
  const api=await setup(t,()=> 'S: 简短自然');
  const text=JSON.stringify(Array.from({length:2000},(_,i)=>({sender_name:'对方',content:`消息${i+1}${i<59?'\n续行':''}`})));
  const {data}=await api.request('POST','/api/distill',{text});const review=await api.phase('review');
  assert.equal(review.lines,2000);assert.equal(reviewLines(review.preview).length,2000);
  assert.match(review.preview,/消息1 续行\n/);
  assert.equal((await api.request('POST','/api/distill/confirm',{id:data.id,text:review.preview})).status,202);
  await api.phase('done');assert.equal(api.calls.length,21);
});

test('large Chinese review records fit the request limit and survive UTF-8 packet boundaries',async t=>{
  const api=await setup(t,()=> 'S: 简短自然');
  const text=JSON.stringify(Array.from({length:2000},()=>({sender_name:'对方',content:'中'.repeat(190)})));
  const {data}=await api.request('POST','/api/distill',{text});const review=await api.phase('review');
  assert.ok(Buffer.byteLength(JSON.stringify({id:data.id,text:review.preview}))>200000);
  assert.equal(review.preview.includes('\uFFFD'),false);
  assert.equal((await api.request('POST','/api/distill/confirm',{id:data.id,text:review.preview})).status,202);
  await api.phase('done');assert.equal(api.calls.some(call=>call[1].includes('\uFFFD')),false);
});

test('review validation retains the minimum while accepting more than 2000 records',()=>{
  assert.throws(()=>validateReviewedLog(Array.from({length:9},()=> '对方：消息').join('\n')),/9/);
  for(const count of [2000,2001,10000])assert.equal(validateReviewedLog(Array.from({length:count},()=> '对方：消息').join('\n')).length,count);
});

test('large imports preserve every record and confirm Chinese content above the old 2 MiB limit',async t=>{
  const api=await setup(t,()=> 'S: 简短自然');
  assert.equal((await api.request('GET','/api/state')).data.capabilities.unlimitedDistillRecords,true);
  const records=Array.from({length:4001},(_,i)=>`对方：记录${i+1} ${'中'.repeat(185)}`);
  const text=records.join('\n');
  const start=await api.request('POST','/api/distill',{text});
  const review=await api.phase('review');
  assert.equal(review.lines,records.length);assert.equal(review.preview,text);
  assert.ok(Buffer.byteLength(JSON.stringify({id:start.data.id,text:review.preview}))>2097152);
  assert.equal(api.calls.length,0);
  assert.equal((await api.request('POST','/api/distill/confirm',{id:start.data.id,text:review.preview})).status,202);
  await api.phase('done');
  const prompts=api.calls.slice(0,-1).map(call=>call[1].split('聊天记录：\n')[1]);
  assert.equal(prompts.join('\n'),text);assert.equal(api.calls.length,42);
});

test('large observation sets merge in bounded groups before final synthesis without skipping batches',async t=>{
  let observed=0,mergeCalls=0;
  const api=await setup(t,(_id,prompt)=>{
    if(prompt.includes('请归并原始观察')){mergeCalls++;return Array.from({length:20},(_,i)=>`S: 归并${mergeCalls}-${i}`).join('\n');}
    if(prompt.includes('合并为最终人设素材'))return '最终风格';
    observed++;
    return Array.from({length:100},(_,i)=>`S: 独立观察${observed}-${i}`).join('\n');
  });
  const text=Array.from({length:501},(_,i)=>`对方：消息${i+1}`).join('\n');
  const start=await api.request('POST','/api/distill',{text});await api.phase('review');
  await api.request('POST','/api/distill/confirm',{id:start.data.id,text});
  assert.equal((await api.phase('done')).notes,'最终风格');
  assert.equal(observed,6);assert.equal(mergeCalls,3);
  const merges=api.calls.filter(call=>call[1].includes('请归并原始观察')).map(call=>call[1].split('原始观察：\n')[1]);
  assert.ok(merges.every(prompt=>prompt.split('\n').length<=200));
  assert.equal(merges.join('\n').split('\n').length,600);
  assert.match(merges.join('\n'),/独立观察6-99/);
  const synthesis=api.calls.at(-1)[1].split('原始观察：\n')[1];
  assert.equal(synthesis.split('\n').length,60);
});

test('an invalid merge response fails clearly instead of silently dropping observations',async t=>{
  const api=await setup(t,(_id,prompt)=>prompt.includes('请归并原始观察')?'无结果':Array.from({length:120},(_,i)=>`S: 观察${i}`).join('\n'));
  const text=Array.from({length:201},(_,i)=>`对方：消息${i}`).join('\n');
  const start=await api.request('POST','/api/distill',{text});await api.phase('review');
  await api.request('POST','/api/distill/confirm',{id:start.data.id,text});
  assert.match((await api.phase('error')).detail,/第 1 轮、第 \d+ 批归并失败/);
  assert.equal(api.calls.some(call=>call[1].includes('合并为最终人设素材')),false);
});

test('distillation pauses for local review, resumes after confirmation, and restores the finished result',async t=>{
  const api=await setup(t,()=> 'S: 常用短句\nM: 曾一起吃火锅\n[示例]\n好呀\n[回忆]\n一起吃过火锅');
  const text=Array.from({length:12},(_,i)=>`对方：第${i+1}句话`).join('\n');
  const start=await api.request('POST','/api/distill',{text});
  assert.equal(start.status,202);
  const review=await api.phase('review');
  assert.equal(review.id,start.data.id);
  assert.match(review.preview,/第1句话/);
  assert.equal(api.calls.length,0);
  assert.equal(fs.readFileSync(api.jobFile,'utf8').includes('第1句话'),false);
  assert.equal((await api.request('POST','/api/distill/confirm',{id:'old-id',text})).status,409);
  const confirmed=await api.request('POST','/api/distill/confirm',{id:review.id,text:text.replace('第1句话','校对后的话')});
  assert.equal(confirmed.status,202);
  const done=await api.phase('done');
  assert.match(done.notes,/一起吃过火锅/);
  assert.match(api.calls[0][1],/校对后的话/);
  assert.ok(api.calls[0][3].timeoutMs<=180000);
  assert.equal(api.calls[0][3].contextManaged,true);
  assert.equal(api.calls[0][3].persistHistory,false);
  const restored=createConsole(api.bridge,{token:'test-token',config:api.config,distillJobFile:api.jobFile});
  await new Promise(resolve=>restored.listen(0,'127.0.0.1',resolve));
  t.after(()=>restored.close());
  api.config.consolePort=restored.address().port;
  const response=await fetch(`http://127.0.0.1:${api.config.consolePort}/api/distill/progress`,{headers:{Authorization:'Bearer test-token'}});
  assert.equal((await response.json()).notes,done.notes);
});

test('parallel distillation covers every chunk using separate real API sessions',async t=>{
  const requests=[];let active=0,peak=0;
  const api=await setup(t,()=>{},undefined,dir=>new ApiChatClient({baseUrl:'http://localhost/v1',model:'mock',apiKey:''},{historyFile:path.join(dir,'history.json'),fetchImpl:async(_url,options)=>{
    const request=JSON.parse(options.body);requests.push(request);const index=requests.length;
    peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,20));--active;
    return new Response(JSON.stringify({choices:[{message:{content:index<=5?`S: 第${index}块观察`:'最终风格'}}]}));
  }}));
  const text=Array.from({length:450},(_,i)=>`对方：消息${i+1}`).join('\n');
  const {data}=await api.request('POST','/api/distill',{text});await api.phase('review');
  await api.request('POST','/api/distill/confirm',{id:data.id,text});
  const done=await api.phase('done');
  assert.equal(requests.length,6);assert.equal(peak,4);
  const synthesis=requests.at(-1).messages.at(-1).content;
  for(let i=1;i<=5;i++)assert.match(synthesis,new RegExp(`第${i}块观察`));
  assert.equal(done.notes,'最终风格');assert.equal(api.bridge.chatEngine.threads.size,0);
});

test('a failed observation chunk reports its number and never synthesizes partial records',async t=>{
  let calls=0;
  const api=await setup(t,()=>{},undefined,dir=>new ApiChatClient({baseUrl:'http://localhost/v1',model:'mock',apiKey:''},{historyFile:path.join(dir,'history.json'),fetchImpl:async()=>{
    const n=++calls;await new Promise(resolve=>setTimeout(resolve,20));
    return n===2?new Response('{}',{status:429}):new Response(JSON.stringify({choices:[{message:{content:'S: 正常观察'}}]}));
  }}));
  const text=Array.from({length:350},(_,i)=>`对方：消息${i+1}`).join('\n');
  const {data}=await api.request('POST','/api/distill',{text});await api.phase('review');
  await api.request('POST','/api/distill/confirm',{id:data.id,text});
  const error=await api.phase('error');assert.match(error.detail,/第 2 块/);assert.match(error.detail,/限流/);
  assert.equal(calls,4);assert.equal(error.notes,undefined);
});

test('persistent 5xx and generic 400 fail after one retry without record isolation or false moderation claims',async t=>{
  for(const status of [400,503]){
    let calls=0;
    const api=await setup(t,()=>{},undefined,dir=>new ApiChatClient({baseUrl:'http://localhost/v1',model:'mock',apiKey:''},{historyFile:path.join(dir,'history.json'),fetchImpl:async()=>{
      calls++;return new Response(JSON.stringify({error:{code:'invalid_request_error'}}),{status});
    }}));
    const text=Array.from({length:150},(_,i)=>`对方：消息${i}`).join('\n');
    const {data}=await api.request('POST','/api/distill',{text});await api.phase('review');await api.request('POST','/api/distill/confirm',{id:data.id,text});
    const result=await api.phase('error');assert(calls<=4);assert.equal(result.notes,undefined);assert.doesNotMatch(result.detail,/自动忽略|触发服务端审核/);
  }
});

test('explicit moderation rejection isolates one refused record and reports the exclusion',async t=>{
  let calls=0;
  const api=await setup(t,(_id,prompt)=>{
    calls++;if(prompt.includes('被拒记录')){const error=new Error('HTTP 400');error.contentRejected=true;throw error;}return 'S: 简短自然';
  });
  const text=Array.from({length:150},(_,i)=>`对方：${i===9?'被拒记录':`正常消息${i}`}`).join('\n');
  const {data}=await api.request('POST','/api/distill',{text});await api.phase('review');await api.request('POST','/api/distill/confirm',{id:data.id,text});
  const result=await api.phase('done');assert.match(result.detail,/1 条记录/);assert.equal(result.excludedRecords,1);assert(calls<35);
  assert.equal(JSON.parse(fs.readFileSync(api.jobFile,'utf8')).excludedRecords,1);
});

test('widespread moderation rejection has a bounded isolation budget instead of issuing hundreds of calls',async t=>{
  let calls=0;
  const api=await setup(t,()=>{calls++;const error=new Error('HTTP 400');error.contentRejected=true;throw error;});
  const text=Array.from({length:101},(_,i)=>`对方：消息${i}`).join('\n');
  const {data}=await api.request('POST','/api/distill',{text});await api.phase('review');await api.request('POST','/api/distill/confirm',{id:data.id,text});
  const result=await api.phase('error');assert.match(result.detail,/32 次/);assert(calls<=34);
});

test('cancelling parallel distillation aborts every active chunk and permits a clean retry',async t=>{
  let calls=0,aborted=0,answer=false;
  const api=await setup(t,()=>{},undefined,dir=>new ApiChatClient({baseUrl:'http://localhost/v1',model:'mock',apiKey:''},{historyFile:path.join(dir,'history.json'),fetchImpl:async(_url,options)=>{
    ++calls;
    if(answer)return new Response(JSON.stringify({choices:[{message:{content:'重试成功'}}]}));
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{++aborted;reject(new Error('cancelled'));},{once:true}));
  }}));
  const text=Array.from({length:350},(_,i)=>`对方：消息${i+1}`).join('\n');
  const {data}=await api.request('POST','/api/distill',{text});await api.phase('review');
  await api.request('POST','/api/distill/confirm',{id:data.id,text});await api.phase('observe');
  assert.equal(calls,4);
  await api.request('POST','/api/distill/cancel',{id:data.id});await api.phase('cancelled');
  assert.equal(aborted,4);await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(api.bridge.chatEngine.turns.size,0);assert.equal(api.bridge.chatEngine.threads.size,0);
  answer=true;const short=text.split('\n').slice(0,10).join('\n');
  const retry=await api.request('POST','/api/distill',{text:short});await api.phase('review');
  await api.request('POST','/api/distill/confirm',{id:retry.data.id,text:short});
  assert.equal((await api.phase('done')).notes,'重试成功');
});

test('cancelling a reviewed task prevents model calls and records a terminal state',async t=>{
  const api=await setup(t,()=> 'unexpected');
  const text=Array.from({length:10},(_,i)=>`对方：${i}`).join('\n');
  const {data}=await api.request('POST','/api/distill',{text});
  await api.phase('review');
  assert.equal((await api.request('POST','/api/distill/cancel',{id:data.id})).status,200);
  assert.equal((await api.phase('cancelled')).phase,'cancelled');
  assert.equal(api.calls.length,0);
});

test('cancelling during model generation interrupts it and ignores late output',async t=>{
  let interrupted=false,resolveModel;
  const api=await setup(t,()=>new Promise(resolve=>{resolveModel=resolve;}),async()=>{interrupted=true;resolveModel?.('late answer');});
  const text=Array.from({length:10},(_,i)=>`对方：${i}`).join('\n');
  const {data}=await api.request('POST','/api/distill',{text});
  await api.phase('review');
  assert.equal((await api.request('POST','/api/distill/confirm',{id:data.id,text})).status,202);
  await api.phase('distill');
  assert.equal((await api.request('POST','/api/distill/cancel',{id:data.id})).status,200);
  assert.equal((await api.phase('cancelled')).phase,'cancelled');
  assert.equal(interrupted,true);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await api.request('GET','/api/distill/progress')).data.phase,'cancelled');
});

test('a bridge restart reports an unfinished review as interrupted',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-distill-restart-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'job.json');
  fs.writeFileSync(file,JSON.stringify({id:'previous',phase:'review',detail:'review',startedAt:1}));
  const config=validateConfig({...defaults,ownerQQ:'123456'});
  const bridge={config,status:()=>({})};
  const server=createConsole(bridge,{token:'token',config,distillJobFile:file});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());config.consolePort=server.address().port;
  const response=await fetch(`http://127.0.0.1:${config.consolePort}/api/distill/progress`,{headers:{Authorization:'Bearer token'}});
  const job=await response.json();
  assert.equal(job.phase,'error');assert.match(job.detail,/重启/);
});
