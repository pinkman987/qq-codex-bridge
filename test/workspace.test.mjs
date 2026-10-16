import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Bridge} from '../src/bridge.mjs';
import {defaults,validateConfig} from '../src/config.mjs';
import {createConsole} from '../src/server.mjs';
import {pickWorkDirectory,resolveWorkDirectory} from '../src/workspace.mjs';

class FakeEngine extends EventEmitter{
  constructor(role){super();this.role=role;this.turns=new Map();this.ready=false;this.stops=0;this.options=[];}
  stop(){this.stops++;}
  async thread(saved,options){this.options.push(options);return saved||`fake-${this.role}-${this.options.length}`;}
}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-workspace-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'中文项目');fs.mkdirSync(directory);const second=path.join(root,'second');fs.mkdirSync(second);
  const config=validateConfig({...defaults,ownerQQ:'123456',projects:{已有项目:directory}});
  const onebot=new EventEmitter();Object.assign(onebot,{connected:false,close(){},connect(){}});
  const work=new FakeEngine('work'),social=new FakeEngine('social'),stateFile=path.join(root,'sessions.json');
  const options={onebot,work,social,stateFile};const bridge=new Bridge(config,options);bridge.privateMode='chat';bridge.outreach.mode('chat');
  return {root,directory,second,config,bridge,work,options};
}

test('directory selection reuses canonical configured directories and rejects invalid paths without exposing them',t=>{
  const f=fixture(t);assert.equal(resolveWorkDirectory(f.config,{directory:f.directory}).project,'已有项目');
  const next=resolveWorkDirectory(f.config,{directory:f.second});assert.equal(next.config.projects[next.project],fs.realpathSync(f.second));assert.equal(Object.keys(f.config.projects).length,1);
  const file=path.join(f.root,'file');fs.writeFileSync(file,'fake-private');
  for(const directory of ['relative',file,path.join(f.root,'missing')])assert.throws(()=>resolveWorkDirectory(f.config,{directory}),e=>e.message==='请填写已存在的文件夹绝对路径。');
  assert.throws(()=>resolveWorkDirectory(f.config,{project:'missing'}));assert.equal(resolveWorkDirectory(f.config,{project:''}).project,'');
});

test('project selection persists across restart and work threads receive its actual directory; idle guard prevents rerouting',async t=>{
  const f=fixture(t);f.bridge.selectProject('已有项目');assert.equal(f.bridge.privateMode,'chat');assert.equal(f.work.stops,1);
  await f.bridge.ensureThread(f.work,'private:123456',{cwd:f.config.projects[f.bridge.project]});assert.equal(f.work.options[0].cwd,fs.realpathSync(f.directory));
  const restored=new Bridge(f.config,f.options);assert.equal(restored.project,'已有项目');assert.equal(restored.privateMode,'chat');
  f.work.turns.set('active',{});assert.throws(()=>f.bridge.selectProject(''),e=>e.status===409);assert.equal(f.bridge.project,'已有项目');f.work.turns.clear();
  f.bridge.approvals.set('approval',{});assert.throws(()=>f.bridge.selectProject(''),e=>e.status===409);f.bridge.approvals.clear();
  f.bridge.selectProject('');assert.equal(f.bridge.project,'');assert.equal(f.work.stops,2);
});

test('authenticated workspace routes register and select directories, retain credentials, and reject conflicts and busy changes',async t=>{
  const f=fixture(t);let persisted;const server=createConsole(f.bridge,{token:'fake-console',config:f.config,persist:next=>{persisted=structuredClone(next);},chooseWorkDirectory:async()=>f.second,savedAt:null,distillJobFile:path.join(f.root,'distill.json')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());f.config.consolePort=server.address().port;
  const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer fake-console','Content-Type':'application/json'};
  const state=()=>fetch(base+'/api/state',{headers}).then(r=>r.json());
  let snapshot=await state();assert.equal(snapshot.capabilities.workspaceSelection,true);
  assert.equal((await fetch(base+'/api/workspace/pick',{method:'POST'})).status,401);
  assert.equal((await fetch(base+'/api/workspace/pick',{method:'POST',headers:{...headers,Origin:'https://other.example'}})).status,403);
  const picked=await fetch(base+'/api/workspace/pick',{method:'POST',headers});assert.equal((await picked.json()).directory,f.second);assert.equal(persisted,undefined);
  const apply=body=>fetch(base+'/api/workspace',{method:'POST',headers:{...headers,'If-Match':snapshot.revision},body:JSON.stringify(body)});
  const selected=await apply({directory:f.second});assert.equal(selected.status,200);const result=await selected.json();assert.equal(persisted.projects[result.project],fs.realpathSync(f.second));assert.equal(persisted.chat.apiKey,f.config.chat.apiKey);assert.equal(f.bridge.project,result.project);assert.equal(f.bridge.privateMode,'chat');
  assert.equal((await apply({project:''})).status,409);snapshot=await state();assert.equal(snapshot.status.workDirectory,fs.realpathSync(f.second));
  f.work.turns.set('active',{});assert.equal((await apply({project:''})).status,409);assert.equal(f.bridge.project,result.project);f.work.turns.clear();
  assert.equal((await apply({directory:'not-absolute'})).status,400);assert.equal((await apply({project:''})).status,200);assert.equal(f.bridge.project,'');
});

test('folder chooser preserves Unicode paths, handles cancellation and hides process failure output',async()=>{
  const directory='C:\\测试项目';const run=async(command,args,options)=>{assert.equal(command,'powershell.exe');assert.ok(args.includes('-STA'));assert.ok(args.includes('-WindowStyle'));assert.equal(options.windowsHide,true);assert.ok(Buffer.from(args.at(-1),'base64').toString('utf16le').includes('OutputEncoding'));return {stdout:JSON.stringify(directory)};};
  assert.equal(await pickWorkDirectory({platform:'win32',run}),directory);
  assert.equal(await pickWorkDirectory({platform:'win32',run:async()=>({stdout:'null'})}),null);
  await assert.rejects(pickWorkDirectory({platform:'win32',run:async()=>{throw new Error('fake-private-output');}}),e=>!e.message.includes('fake-private-output'));
});
