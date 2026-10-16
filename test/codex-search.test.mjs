import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CodexClient,socialCatalog} from '../src/codex.mjs';
import {defaults,validateConfig} from '../src/config.mjs';
import {buildConfig,configToDraft} from '../public/form-state.js';
import {Bridge} from '../src/bridge.mjs';

test('Codex search can be saved without Omni and unsupported API providers remain rejected',()=>{
  const config=validateConfig({...defaults,chat:{...defaults.chat,provider:'codex'},voice:{...defaults.voice,enabled:false},search:{enabled:true,imageFollowup:false}});
  const draft=configToDraft(config);
  assert.equal(buildConfig(draft,config,false).search.enabled,true);
  const api={...config,chat:{provider:'openai',baseUrl:'http://127.0.0.1:9999/v1',model:'ordinary',apiKey:''}};
  assert.throws(()=>validateConfig(api),e=>e.field==='searchEnabled');
  assert.throws(()=>buildConfig(configToDraft(api),api,false),e=>e.field==='searchEnabled');
});

test('search-capable social catalog still disables all local operation tools',()=>{
  const result=socialCatalog({models:[{slug:'test',shell_type:'unified_exec',experimental_supported_tools:['clock']}]},{allowSearch:true}).models[0];
  assert.equal(result.supports_search_tool,true);
  assert.equal(result.shell_type,'disabled');assert.equal(result.apply_patch_tool_type,null);
  assert.deepEqual(result.experimental_supported_tools,[]);assert.equal(result.node_repl_disabled,true);
});

test('Codex search threads use live hosted search and retain read-only local permissions',async()=>{
  const client=new CodexClient('social',()=>{}),requests=[];
  client.start=async()=>{};client.defaultCwd=os.tmpdir();client.defaultModel='test';client.mcpNames=['private-mcp'];
  client.request=async(method,params)=>{requests.push({method,params});return {thread:{id:'search-thread'}};};
  await client.thread(null,{allowSearch:true,persona:'测试人设'});
  const params=requests[0].params;
  assert.equal(params.config.web_search,'live');assert.equal(params.config['mcp_servers.private-mcp.enabled'],false);
  assert.equal(params.sandbox,'read-only');assert.equal(params.approvalPolicy,'never');
  assert.match(params.developerInstructions,/网页和搜索结果/);
  client.request=async(method,params)=>{requests.push({method,params});return {turn:{id:'turn-1'}};};
  let searchStats;
  const run=client.run('search-thread','查公开信息','low',{allowSearch:true,onSearch:value=>searchStats=value});
  const turn=requests.at(-1).params;
  assert.equal(turn.sandboxPolicy.networkAccess,false);assert.equal(turn.sandboxPolicy.type,'readOnly');
  for(let n=0;n<2;n++)client.receive({method:'item/completed',params:{threadId:'search-thread',item:{type:'webSearch',id:'web-1',query:'public query'}}});
  client.receive({method:'item/completed',params:{threadId:'search-thread',item:{type:'agentMessage',id:'answer',phase:'final_answer',text:'已核对公开信息'}}});
  client.receive({method:'turn/completed',params:{threadId:'search-thread',turn:{status:'completed'}}});
  assert.equal(await run,'已核对公开信息');assert.deepEqual(searchStats,{count:1,verified:true});
});

test('a searchable Codex thread cannot be used for an unapproved round',async()=>{
  const client=new CodexClient('social',()=>{});client.start=async()=>{};client.defaultCwd=os.tmpdir();client.defaultModel='test';
  client.request=async()=>({thread:{id:'search-thread'}});
  await client.thread(null,{allowSearch:true});
  let started=false;client.request=async()=>{started=true;return {turn:{id:'bad'}};};
  await assert.rejects(client.run('search-thread','普通插话','low',{allowSearch:false}),/搜索权限/);
  assert.equal(started,false);
});

test('Codex private, mentioned group, spontaneous group and tutor have separate search gates',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-codex-search-'));
  class Engine extends EventEmitter{
    constructor(role){super();this.role=role;this.turns=new Map();this.threads=[];this.calls=[];}
    stop(){}configure(){}
    async thread(saved,options){const id=saved||this.role+'-'+this.threads.length;this.threads.push({id,options});return id;}
    async run(id,text,effort,options){this.calls.push({id,options});return '答复'+this.calls.length;}
  }
  class QQ extends EventEmitter{constructor(){super();this.connected=true;this.sent=[];}connect(){}close(){}async send(target,text){this.sent.push({target,text});}}
  const social=new Engine('social'),work=new Engine('work'),onebot=new QQ();
  const config=validateConfig({...defaults,enabled:true,ownerQQ:'123456',groups:['654321'],chat:{...defaults.chat,provider:'codex'},voice:{...defaults.voice,enabled:false},search:{enabled:true,imageFollowup:false},social:{...defaults.social,proactive:true,probability:0.5,cooldownSeconds:30}});
  let clock=Date.now();
  const bridge=new Bridge(config,{social,work,onebot,stateFile:path.join(dir,'sessions.json'),random:()=>0,now:()=>clock,mergeDelayMs:0,bubbleDelayMs:0});bridge.privateMode='chat';
  t.after(()=>{bridge.stop();fs.rmSync(dir,{recursive:true,force:true});});
  const message=(id,text,group=false,at=false)=>({post_type:'message',message_type:group?'group':'private',user_id:123456,self_id:999999,group_id:654321,message_id:id,message:[...(at?[{type:'at',data:{qq:'999999'}}]:[]),{type:'text',data:{text}}]});
  await bridge.handle(message(1,'查公开信息'));
  assert.equal(social.threads[0].options.allowSearch,true);assert.equal(social.calls[0].options.allowSearch,true);
  await bridge.handle(message(2,'查新闻',true,true));
  const direct=social.calls.at(-1);assert.equal(direct.options.allowSearch,true);
  clock+=31000;
  for(let i=3;i<6;i++)await bridge.handle(message(i,'普通群话题'+i,true));
  const spontaneous=social.calls.at(-1);assert.equal(spontaneous.options.allowSearch,false);
  assert.notEqual(spontaneous.id,direct.id);
  await bridge.handle(message(6,'/讲题 查公开的题目背景'));
  assert.equal(social.threads.at(-1).options.allowSearch,true);assert.equal(social.calls.at(-1).options.allowSearch,true);
  bridge.configure({...config,search:{enabled:false,imageFollowup:false}});
  await bridge.handle(message(7,'/退出讲题'));
  await bridge.handle(message(8,'你好'));
  assert.equal(social.calls.at(-1).options.allowSearch,false);
});
