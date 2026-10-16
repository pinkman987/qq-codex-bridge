import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CodexClient,loadSocialCatalog,codexFailure} from '../src/codex.mjs';

test('fresh account catalog replaces stale cached models and preserves tool restrictions',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'qq-model-catalog-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const file=path.join(home,'models_cache.json');
  fs.writeFileSync(file,JSON.stringify({models:[{slug:'stale-model'}]}));
  let initialized=0;
  const catalog=await loadSocialCatalog({home,allowSearch:true,refresh:true,initialize:async()=>{
    initialized++;
    fs.writeFileSync(file,JSON.stringify({models:[{slug:'stale-model'},{slug:'account-model',shell_type:'bash'}]}));
    return {models:[{model:'account-model'}]};
  }});
  assert.equal(initialized,1);assert.deepEqual(catalog.models.map(model=>model.slug),['account-model']);
  assert.equal(catalog.models[0].shell_type,'disabled');assert.equal(catalog.models[0].supports_search_tool,true);
});

test('unsupported explicit ChatGPT model is rejected before starting a thread',async()=>{
  const client=new CodexClient('social',()=>{});client.start=async()=>{};client.accountType='chatgpt';client.models=[{model:'account-model'}];
  let requested=false;client.request=async()=>{requested=true;};
  await assert.rejects(client.thread(null,{model:'unavailable-model'}),/清空.*模型名称/);
  assert.equal(requested,false);
});

test('automatic and supported explicit models use the refreshed account choices',async()=>{
  const client=new CodexClient('social',()=>{});client.start=async()=>{};client.defaultCwd=os.tmpdir();
  client.accountType='chatgpt';client.models=[{model:'account-model'}];client.defaultModel='account-model';
  const requests=[];client.request=async(method,params)=>{requests.push(params);return {thread:{id:'test'}};};
  await client.thread(null,{});await client.thread(null,{model:'account-model'});
  assert.deepEqual(requests.map(params=>params.model),['account-model','account-model']);
});

test('raw model errors and provider secrets never become user-facing text',()=>{
  const fake='FICTIONAL_SECRET_IN_UPSTREAM_ERROR';
  const unsupported=JSON.stringify({type:'error',error:{message:"The 'unavailable-model' model is not supported when using Codex with a ChatGPT account. "+fake}});
  assert.match(codexFailure(unsupported).message,/清空.*模型名称/);
  for(const value of [unsupported,fake,JSON.stringify({error:{message:fake}})])assert.equal(codexFailure(value).message.includes(fake),false);
});
