import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,validateConfig} from '../src/config.mjs';
import {resolveProviderCredentials} from '../src/providers.mjs';
import {createConsole} from '../src/server.mjs';
import {chatCompletion,describeImage} from '../src/chat-api.mjs';
import {configToDraft,buildConfig,retainedVoiceDraft} from '../public/form-state.js';
const profile=(id,key,overrides={})=>({id,name:id,enabled:true,baseUrl:`https://${id}.example/v1`,protocol:'openai',apiKey:key,models:['model-a','model-b'],model:'model-a',...overrides});
test('removing voice controls preserves existing interface parameters and retained credentials on ordinary saves',()=>{
  const config=validateConfig({...defaults,voice:{...defaults.voice,enabled:true,mode:'omni',model:'qwen3.8-omni-flash',apiKey:'fake-voice-key'}});
  const safe=structuredClone(config);safe.voice.apiKey='';
  const draft={...configToDraft(safe),...retainedVoiceDraft(safe),persona:'修改后的个性设定'};
  const result=buildConfig(draft,safe,false,false,true);
  assert.equal(result.voice.enabled,true);assert.equal(result.voice.mode,'omni');assert.equal(result.voice.model,config.voice.model);assert.equal(result.voice.baseUrl,config.voice.baseUrl);assert.equal(result.voice.apiKey,'__KEEP__');assert.equal(result.persona,draft.persona);
});
test('provider keys are retained by identity and origin; legacy import preserves its own key',()=>{
  const current={chat:{provider:'openai',baseUrl:'https://old.example/v1',model:'old',apiKey:'fake-old'},modelProviders:[profile('one','fake-one'),profile('two','fake-two')]};
  const input={chat:{provider:'openai',providerId:'two',baseUrl:'https://two.example/v1',model:'model-b',apiKey:'__KEEP__'},modelProviders:[profile('one','__KEEP__'),profile('two','__KEEP__')]};
  resolveProviderCredentials(input,current);assert.equal(input.chat.apiKey,'fake-two');assert.equal(input.modelProviders[0].apiKey,'fake-one');
  for(const p of [profile('one','__KEEP__',{baseUrl:'https://other.example/v1'}),profile('new','__KEEP__')])assert.throws(()=>resolveProviderCredentials({modelProviders:[p]},current),e=>e.field==='apiKey'&&!e.message.includes('fake-'));
  const old={chat:current.chat};const legacy={modelProviders:[profile('legacy','__KEEP__',{baseUrl:old.chat.baseUrl,models:['old'],model:'old'})]};resolveProviderCredentials(legacy,old);assert.equal(legacy.modelProviders[0].apiKey,'fake-old');
});
test('provider selection enforces enabled membership, valid IDs and protocols',()=>{
  const registry=[profile('one','fake-one'),profile('two','fake-two',{protocol:'anthropic'})];
  const next=validateConfig({...defaults,modelProviders:registry,chat:{provider:'openai',providerId:'two',baseUrl:'https://unused.example/v1',apiKey:'unused',model:'model-b'}});
  assert.equal(next.chat.apiKey,'fake-two');assert.equal(next.chat.protocol,'anthropic');assert.equal(next.chat.baseUrl,'https://two.example/v1');
  for(const [providers,chat] of [[registry,{model:'not-present'}],[registry.map(p=>({...p,enabled:false})),{}],[[profile('one','x'),profile('one','y')],{}],[[profile('two','x',{protocol:'unknown'})],{}]])assert.throws(()=>validateConfig({...next,modelProviders:providers,chat:{...next.chat,...chat}}));
});
test('console redacts all provider credentials and persists independent profiles with the selected key',async t=>{
  let config=validateConfig({...defaults,modelProviders:[profile('one','fake-one'),profile('two','fake-two')],chat:{provider:'openai',providerId:'one',model:'model-a'}});
  let saved;const bridge={config,status:()=>({enabled:false}),configure:next=>{config=next;return 'applied';}};
  const server=createConsole(bridge,{token:'fake-console',config,persist:next=>{saved=structuredClone(next);},savedAt:null});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));config.consolePort=server.address().port;t.after(()=>server.close());
  const base=`http://127.0.0.1:${config.consolePort}`,headers={Authorization:'Bearer fake-console','Content-Type':'application/json'};
  const get=()=>fetch(base+'/api/state',{headers}).then(r=>r.json());const state=await get();assert.equal(state.config.chat.apiKey,'');assert.ok(state.config.modelProviders.every(p=>p.apiKey===''));assert.equal(state.hasProviderKeys.two,true);
  const payload={...state.config,chat:{...state.config.chat,providerId:'two',baseUrl:'https://two.example/v1',model:'model-b',apiKey:'__KEEP__'},modelProviders:state.config.modelProviders.map(p=>({...p,apiKey:'__KEEP__'}))};
  const response=await fetch(base+'/api/config',{method:'POST',headers:{...headers,'If-Match':state.revision},body:JSON.stringify(payload)});assert.equal(response.status,200);assert.equal(saved.chat.apiKey,'fake-two');assert.equal(saved.modelProviders[0].apiKey,'fake-one');assert.equal(saved.modelProviders[1].apiKey,'fake-two');
  const bad={...payload,modelProviders:payload.modelProviders.map(p=>({...p,baseUrl:'https://attacker.example/v1'}))};const result=await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify(bad)});assert.equal(result.status,400);assert.ok(!(await result.text()).includes('fake-one'));
});
test('explicit Anthropic format builds Messages requests even without anthropic in URL; images use native blocks',async()=>{
  const requests=[];const fetchImpl=async(url,options)=>{requests.push({url,headers:options.headers,body:JSON.parse(options.body)});return new Response(JSON.stringify({content:[{type:'text',text:'模拟成功'}],usage:{input_tokens:1,output_tokens:2}}),{headers:{'Content-Type':'application/json'}});};
  const config={baseUrl:'https://service.example/v1',model:'vision-model',apiKey:'fake-key',protocol:'anthropic'};
  assert.equal(await chatCompletion(config,[{role:'system',content:'规则'},{role:'user',content:'你好'}],{fetchImpl}),'模拟成功');assert.equal(requests[0].url,'https://service.example/v1/messages');assert.equal(requests[0].body.system,'规则');assert.equal(requests[0].headers['anthropic-version'],'2023-06-01');
  await describeImage(config,'data:image/png;base64,ZmFrZQ==',{fetchImpl});assert.equal(requests[1].body.messages[0].content[0].type,'image');assert.equal(requests[1].body.messages[0].content[0].source.type,'base64');
  const openai=async(url,options)=>{assert.equal(url,'https://service.example/anthropic/chat/completions');assert.ok(JSON.parse(options.body).messages);return new Response(JSON.stringify({choices:[{message:{content:'OpenAI'}}]}));};assert.equal(await chatCompletion({...config,protocol:'openai',baseUrl:'https://service.example/anthropic'},[{role:'user',content:'hi'}],{fetchImpl:openai}),'OpenAI');
});
