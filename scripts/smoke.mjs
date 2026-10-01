import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { ROOT, defaults } from '../src/config.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-bridge-smoke-'));
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
let child,ws;
const outgoing=[];
const apiServer=http.createServer(async(req,res)=>{for await(const chunk of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'本地模拟回复'}}],usage:{prompt_tokens:1,completion_tokens:1}}));});
const qqServer=http.createServer();
try{
  for(const file of ['src','public','scripts','config.example.json','package.json','package-lock.json','node_modules'])fs.cpSync(path.join(ROOT,file),path.join(root,file),{recursive:true});
  await listen(apiServer);await listen(qqServer);
  ws=new WebSocketServer({server:qqServer});let peer;
  ws.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
    const request=JSON.parse(String(raw));
    if(request.action==='send_private_msg')outgoing.push(request.params.message);
    socket.send(JSON.stringify({echo:request.echo,status:'ok',retcode:0,data:request.action==='get_login_info'?{user_id:1234567,nickname:'Smoke'}:{message_id:1}}));
  });});
  const reservation=net.createServer();await listen(reservation);const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const config={...structuredClone(defaults),consolePort:port,ownerQQ:'',groups:[],enabled:false,chat:{provider:'openai',baseUrl:`http://127.0.0.1:${apiServer.address().port}/v1`,apiKey:'',model:'mock'},onebot:{wsUrl:`ws://127.0.0.1:${qqServer.address().port}`,accessToken:''}};
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
  child=spawn(process.execPath,['src/server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,CODEX_HOME:path.join(root,'empty-codex-home'),QQ_CODEX_BIN:''}});
  // Do not print raw server output: startup includes the console credential.
  let stderr='';child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-2000);});
  const tokenPath=path.join(root,'state','console-token');
  for(let i=0;i<100&&!fs.existsSync(tokenPath)&&child.exitCode===null;i++)await pause();
  assert(fs.existsSync(tokenPath),'Fresh server failed to start (no console credential created)');
  const headers={Authorization:'Bearer '+fs.readFileSync(tokenPath,'utf8').trim(),'Content-Type':'application/json'};
  const base=`http://127.0.0.1:${port}`;
  const request=async(route,options={})=>{
    const res=await fetch(base+route,{...options,headers,signal:AbortSignal.timeout(10000)});
    const data=await res.json();assert(res.ok,`${route} returned HTTP ${res.status}`);return data;
  };
  let state;
  for(let i=0;i<50;i++){try{state=await request('/api/state');break;}catch{await pause();}}
  assert(state&&!state.status.enabled&&state.capabilities.unlimitedDistillRecords,'Fresh defaults are not paused or unlimited import capability is missing');
  assert(!state.config.chat.apiKey&&!state.config.onebot.accessToken,'State exposes credentials');
  const environment=await request('/api/environment');assert(environment.ok,'API-only environment incorrectly requires Codex');
  await request('/api/chat/test',{method:'POST',body:JSON.stringify({chat:config.chat})});
  await request('/api/config',{method:'POST',body:JSON.stringify({...config,enabled:true,ownerQQ:'123456',revision:state.revision})});
  for(let i=0;i<70;i++){state=await request('/api/state');if(state.status.qqConnected)break;await pause();}
  assert(state.status.qqConnected&&peer,'Mock OneBot login handshake failed');
  const message=text=>peer.send(JSON.stringify({post_type:'message',message_type:'private',self_id:1234567,user_id:123456,message_id:Math.random().toString(),message:[{type:'text',data:{text}}],sender:{nickname:'Test'}}));
  message('/mode chat');
  for(let i=0;i<50&&!outgoing.length;i++)await pause();
  message('你好');
  for(let i=0;i<100&&!outgoing.some(v=>JSON.stringify(v).includes('本地模拟回复'));i++)await pause();
  assert(outgoing.some(v=>JSON.stringify(v).includes('本地模拟回复')),'QQ → compatible model → QQ roundtrip failed');
  const page=await fetch(base);assert(page.ok&&(await page.text()).includes('environmentCheck'),'Console missing first-run diagnostics');
  console.log('全新目录冒烟通过：首次启动、默认暂停、鉴权、环境检查、模型测试、OneBot 登录、模拟私聊往返。无真实账号、模型调用或 QQ 消息。');
}finally{
  if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000).unref();});}
  if(ws){for(const client of ws.clients)client.terminate();await new Promise(resolve=>ws.close(resolve));}
  await Promise.all([apiServer,qqServer].map(server=>new Promise(resolve=>server.close(resolve))));
  const target=path.resolve(root);
  if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('qq-bridge-smoke-'))throw new Error('Unsafe temporary cleanup target');
  fs.rmSync(target,{recursive:true,force:true});
}
