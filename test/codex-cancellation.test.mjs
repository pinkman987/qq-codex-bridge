import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexClient} from '../src/codex.mjs';

test('Codex cancellation before turn/start acknowledgment rejects promptly and interrupts the late turn',async()=>{
  const client=new CodexClient('social',()=>{}),controller=new AbortController(),requests=[];let acknowledge;
  client.request=(method,params)=>{requests.push({method,params});return method==='turn/start'?new Promise(resolve=>{acknowledge=resolve;}):Promise.resolve({});};
  const run=client.run('thread-1','text','low',{signal:controller.signal});
  controller.abort();await assert.rejects(run,/已停止/);assert.equal(client.turns.size,0);
  acknowledge({turn:{id:'late-turn'}});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests.at(-1),{method:'turn/interrupt',params:{threadId:'thread-1',turnId:'late-turn'}});
});

test('Codex respects per-request timeout and leaves no active turn',async()=>{
  const client=new CodexClient('social',()=>{}),requests=[];
  client.request=async(method,params)=>{requests.push({method,params});return {turn:{id:'turn-1'}};};
  await assert.rejects(client.run('thread-1','text','low',{timeoutMs:20}),/超.*1 秒/);
  assert.equal(client.turns.size,0);assert.equal(requests.at(-1).method,'turn/interrupt');
});

test('Codex does not start an already cancelled request and can stop while start is pending',async()=>{
  const client=new CodexClient('social',()=>{}),controller=new AbortController(),requests=[];let acknowledge;
  client.request=(method,params)=>{requests.push({method,params});return method==='turn/start'?new Promise(resolve=>{acknowledge=resolve;}):Promise.resolve({});};
  controller.abort();await assert.rejects(client.run('unused','text','low',{signal:controller.signal}),/已停止/);assert.equal(requests.length,0);
  const run=client.run('thread-1','text');await client.interrupt('thread-1');
  acknowledge({turn:{id:'turn-1'}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.at(-1).method,'turn/interrupt');
  client.receive({method:'turn/completed',params:{threadId:'thread-1',turn:{status:'interrupted'}}});
  await assert.rejects(run,/已停止/);
});
