import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaSnapshot,quotaText} from '../src/usage.mjs';
import {CodexClient} from '../src/codex.mjs';
import {searchGuide} from '../src/search.mjs';

const at=Date.UTC(2026,9,15,10),raw={rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:at/1000+5400},secondary:{usedPercent:60,windowDurationMins:10080,resetsAt:at/1000+86400},credits:{secret:'fake-private'}}}};
test('quota prefers all current buckets, converts used to remaining, and reports a compact reset countdown',()=>{
  const snapshot=quotaSnapshot(raw,at),text=quotaText(snapshot,at);
  assert.equal(snapshot.windows[0].remaining,75);assert.match(text,/5小时额度：剩余 75%/);assert.match(text,/1小时30分钟后刷新/);assert.match(text,/7天额度：剩余 40%/);assert.ok(!JSON.stringify(snapshot).includes('fake-private'));assert.ok(text.length<130);
  assert.equal(quotaSnapshot({rateLimits:{primary:{usedPercent:140}}},at).windows[0].remaining,0);
  assert.equal(quotaSnapshot({rateLimits:{primary:{usedPercent:-10}}},at).windows[0].remaining,100);
});
test('missing, malformed, stale or elapsed quota never becomes an invented allowance or reset time',()=>{
  assert.match(quotaText(null,at),/读取不到/);
  assert.match(quotaText(quotaSnapshot(raw,at),at+91000),/读取不到/);
  const unknown=quotaSnapshot({rateLimits:{primary:{usedPercent:null,windowDurationMins:null,resetsAt:null}}},at);
  assert.match(quotaText(unknown,at),/剩余未知\n刷新时间未知/);
  const past=quotaSnapshot({rateLimits:{primary:{usedPercent:100,resetsAt:at/1000-10}}},at);
  assert.match(quotaText(past,at),/等待刷新后的数据/);assert.ok(!quotaText(past,at).includes('剩余 100%'));
  assert.equal(quotaSnapshot({rateLimitsByLimitId:{},rateLimits:raw.rateLimits}),null);
});
test('quota reads are bounded, cached and deduplicated without launching a model or leaking upstream errors',async()=>{
  const c=new CodexClient('work',()=>{});let calls=0,release;c.request=async(method,params,timeout)=>{assert.equal(method,'account/rateLimits/read');assert.equal(timeout,2500);calls++;return new Promise(r=>{release=r;});};
  assert.equal(await c.readUsage(),null);assert.equal(calls,0);
  c.ready=true;c.accountType='apikey';assert.equal(await c.readUsage(),null);assert.equal(calls,0);
  c.accountType='chatgpt';const a=c.readUsage(),b=c.readUsage();release(raw);assert.deepEqual(await a,await b);assert.equal(calls,1);
  await c.readUsage();assert.equal(calls,1);
  c.request=async()=>{throw new Error('fake-private-provider-error');};assert.equal(await c.readUsage({force:true}),null);
});
test('account changes discard cached quota and reject late quota from the previous account',async()=>{
  const c=new CodexClient('work',()=>{});c.ready=true;c.accountType='chatgpt';let release;c.request=()=>new Promise(r=>{release=r;});
  const pending=c.readUsage();c.receive({method:'account/updated',params:{authMode:'chatgpt'}});release(raw);assert.equal(await pending,null);assert.equal(c.quota,null);
  c.receive({method:'account/rateLimits/updated',params:raw});assert.equal((await c.readUsage()).windows[0].remaining,75);
  c.stop();assert.equal(c.quota,null);
});
test('all chat search modes lead with results and provide real sources only when requested',()=>{
  for(const enabled of [true,false]){
    const guide=searchGuide(enabled,{verifiedSources:true});assert.match(guide,/先给结论或直接回答/);assert.match(guide,/用户已经要求来源时本轮直接给/);assert.match(guide,/不能凭印象补造来源/);
  }
});
