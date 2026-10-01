import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults,validateConfig } from '../src/config.mjs';
import { createConsole,configRevision } from '../src/server.mjs';
import { configToDraft,buildConfig,draftEqual } from '../public/form-state.js';
import { connectionError } from '../src/onebot.mjs';

test('form validates out-of-range and blank numbers before sending; zero remains valid',()=>{
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456'}),draft=configToDraft(config);
  for(const [field,value]of [['probability','51'],['probability',''],['cooldown','29'],['hourly','101']]){
    assert.throws(()=>buildConfig({...draft,[field]:value},config,true),error=>error.field===field&&/整数/.test(error.message));
  }
  const next=buildConfig({...draft,probability:'0'},config,true);
  assert.equal(next.social.probability,0);assert.equal(next.onebot.accessToken,'__KEEP__');
  assert.equal(buildConfig(draft,config,false).onebot.accessToken,'');
});
test('project line errors identify their field and never silently drop duplicate projects',()=>{
  const draft=configToDraft(defaults);
  for(const projects of ['项目名没有等号','a=relative/path','a=C:\\First\na=C:\\Second'])assert.throws(()=>buildConfig({...draft,projects},defaults,false),error=>error.field==='projects');
  const next=buildConfig({...draft,groups:'123456，654321 123456',projects:'网站=C:\\Projects\\网站'},defaults,false);
  assert.deepEqual(next.groups,['123456','654321']);assert.equal(next.projects['网站'],'C:\\Projects\\网站');
  assert.equal(draftEqual(draft,{...draft}),true);assert.equal(draftEqual(draft,{...draft,persona:'different'}),false);
});
test('save API confirms persisted changes, preserves credentials and detects stale edits; unchanged saves do not restart engines',async t=>{
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456',onebot:{...defaults.onebot,accessToken:'private-test-token'}});
  const writes=[];let restarts=0;
  const bridge={config,status:()=>({enabled:true,qqConnected:true}),configure(){restarts++;}};
  const server=createConsole(bridge,{token:'console-test-token',config,persist:next=>writes.push(structuredClone(next)),savedAt:'2026-09-29T00:00:00.000Z'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));config.consolePort=server.address().port;
  t.after(()=>server.close());const base=`http://127.0.0.1:${config.consolePort}`,headers={Authorization:'Bearer console-test-token','Content-Type':'application/json'};
  const state=await(await fetch(base+'/api/state',{headers})).json();
  const payload={...state.config,persona:'new persona',onebot:{...state.config.onebot,accessToken:'__KEEP__'}};
  const post=(input,revision)=>fetch(base+'/api/config',{method:'POST',headers:{...headers,'If-Match':revision},body:JSON.stringify(input)});
  const changed=await(await post(payload,state.revision)).json();
  assert.equal(changed.ok,true);assert.equal(changed.changed,true);assert.equal(changed.hasOnebotToken,true);assert.ok(changed.savedAt);assert.notEqual(changed.revision,state.revision);
  assert.equal(writes[0].onebot.accessToken,'private-test-token');assert.equal(writes.length,1);assert.equal(restarts,1);
  const unchanged=await(await post(payload,changed.revision)).json();
  assert.equal(unchanged.changed,false);assert.equal(writes.length,1);assert.equal(restarts,1);assert.equal(unchanged.savedAt,changed.savedAt);
  assert.equal((await post({...payload,persona:'stale'},state.revision)).status,409);assert.equal(writes.length,1);
  const invalid=await post({...payload,social:{...payload.social,probability:0.9}},changed.revision);
  assert.equal(invalid.status,400);assert.equal((await invalid.json()).field,'probability');assert.equal(writes.length,1);
  const final=await(await fetch(base+'/api/state',{headers})).json();assert.equal(final.config.persona,'new persona');assert.equal(final.config.onebot.accessToken,'');
  assert.equal(JSON.stringify(final).includes('private-test-token'),false);
  for(const resource of ['/','/app.js','/app.css','/form-state.js','/vendor/pico.css']){
    const response=await fetch(base+resource);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),resource==='/vendor/pico.css'?/style-src 'self'/:/script-src 'self'/);assert.ok((await response.text()).length>0);
  }
});
test('revision is independent of object key ordering and connection errors give actionable, credential-free explanations',()=>{
  assert.equal(configRevision({b:{y:2,x:1},a:1}),configRevision({a:1,b:{x:1,y:2}}));
  assert.match(connectionError({code:'ECONNREFUSED'}),/未启动|未监听/);
  assert.match(connectionError({message:'Unexpected server response: 401'}),/令牌/);
  assert.match(connectionError({message:'Opening handshake has timed out'}),/超时/);
  assert.equal(connectionError({message:'ws://127.0.0.1/?access_token=secret'}).includes('secret'),false);
});
test('persona presets save, list, apply and delete; apply persists and invokes selective configuration',async t=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-personas-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'personas.json');
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456',persona:'base persona'});
  const writes=[];let restarts=0;
  const bridge={config,status:()=>({enabled:true,qqConnected:true}),configure(){restarts++;}};
  const server=createConsole(bridge,{token:'t',config,persist:next=>writes.push(next),personasFile:file});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));config.consolePort=server.address().port;t.after(()=>server.close());
  const base=`http://127.0.0.1:${config.consolePort}`,headers={Authorization:'Bearer t','Content-Type':'application/json'};
  const call=(method,url,body)=>fetch(base+url,{method,headers,body:body?JSON.stringify(body):undefined});
  assert.deepEqual((await (await call('GET','/api/personas')).json()).presets,{});
  const saved=await (await call('POST','/api/personas',{name:'蒸馏版',text:'distilled persona'})).json();
  assert.equal(saved.ok,true);assert.equal(saved.presets['蒸馏版'].text,'distilled persona');
  assert.equal((await call('POST','/api/personas',{name:'bad name!',text:'x'})).status,400);
  const applied=await (await call('POST','/api/personas/apply',{name:'蒸馏版'})).json();
  assert.equal(applied.ok,true);assert.equal(applied.persona,'distilled persona');
  assert.equal(writes.at(-1).persona,'distilled persona');assert.equal(restarts,1);
  const state=await (await fetch(base+'/api/state',{headers})).json();
  assert.equal(state.config.persona,'distilled persona');assert.equal(state.revision,applied.revision);
  const deleted=await (await call('DELETE','/api/personas',{name:'蒸馏版'})).json();
  assert.deepEqual(deleted.presets,{});
  assert.equal((await call('POST','/api/personas/apply',{name:'蒸馏版'})).status,400);
});
