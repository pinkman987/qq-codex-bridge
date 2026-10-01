import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, STATE, loadConfig, validateConfig, atomicWrite, defaults } from './config.mjs';
import { Bridge } from './bridge.mjs';
import { chatCompletion } from './chat-api.mjs';
import { findSnowlumaDb, extractChatLog, listSessions, distillPrompt, normalizePastedLog, parseStructuredLog, linesFromBubbles, chunkLines, observationPrompt, synthesizePrompt, mergeObservationsPrompt, flattenChatRecords } from './distill.mjs';
import { validateReviewedLog } from '../public/form-state.js';
import { inspectEnvironment } from './environment.mjs';
import { ocrImageFile } from './ocr.mjs';

export function configRevision(config) {
  const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  return createHash('sha256').update(JSON.stringify(stable(config))).digest('hex');
}
async function readBody(req,limit,message){
  const chunks=[];let bytes=0;
  for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw new Error(message);chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
export function createConsole(bridge, { token, logs=[],config=bridge.config,onSave=()=>{},
  testChat=(chat,onUsage)=>chatCompletion(chat,[{role:'user',content:'连接测试。只回复：连接成功。'}],{timeoutMs:15000,onUsage}),
  persist=next=>atomicWrite(path.join(ROOT,'config.json'),next),
  personasFile=path.join(STATE,'personas.json'),
  distillJobFile=path.join(STATE,'distill-job.json'),
  savedAt=fs.existsSync(path.join(ROOT,'config.json'))?fs.statSync(path.join(ROOT,'config.json')).mtime.toISOString():null }={}) {
  let current=config,lastSavedAt=savedAt;
  let testing=false;
  let distillProgress=null,distillTask=null;
  try{distillProgress=JSON.parse(fs.readFileSync(distillJobFile,'utf8'));}catch{}
  if(distillProgress && !['done','error','cancelled'].includes(distillProgress.phase)){
    distillProgress={...distillProgress,phase:'error',detail:'桥接程序重启，未完成的蒸馏已中断；请重新选择记录。',at:Date.now()};
    atomicWrite(distillJobFile,distillProgress);
  }
  const setDistillProgress=(task,update)=>{
    if(distillTask!==task)return;
    distillProgress={...distillProgress,...update,id:task.id,startedAt:distillProgress?.startedAt||Date.now(),at:Date.now()};
    const {preview,...durable}=distillProgress;
    atomicWrite(distillJobFile,durable);
  };
  const checkDistill=task=>{if(task.controller.signal.aborted||distillTask!==task)throw new Error('蒸馏任务已取消');};
  const endDistill=(task,phase,detail)=>{
    if(distillTask!==task)return;
    setDistillProgress(task,{phase,detail,percent:phase==='done'?100:0});
    clearTimeout(task.timer);task.preparedLines=null;distillTask=null;testing=false;
  };
  const cancelDistill=(task,detail='蒸馏任务已取消',phase='cancelled')=>{
    if(distillTask!==task)return;
    task.controller.abort();
    if(typeof task.engine?.interrupt==='function')for(const id of task.threadIds||[])Promise.resolve().then(()=>task.engine.interrupt(id)).catch(()=>{});
    endDistill(task,phase,detail);
  };
  const resolveChat=input=>{
    if(input.chat?.apiKey==='__KEEP__'){
      if(new URL(input.chat.baseUrl||current.chat.baseUrl).origin!==new URL(current.chat.baseUrl).origin){const error=new Error('更换模型服务后，请重新填写该服务的 API Key');error.field='apiKey';throw error;}
      input.chat.apiKey=current.chat.apiKey;
    }
    return input;
  };
  const prepareDistill=async(task,input)=>{
    let lines,recognition=null,imageMode=false;
    if(typeof input.text==='string'&&input.text.trim()){
      lines=parseStructuredLog(input.text)??normalizePastedLog(input.text);
    }else if((Array.isArray(input.images)&&input.images.length>0)||(typeof input.image==='string'&&input.image.startsWith('data:image/'))){
      imageMode=true;
      const dataUrls=(Array.isArray(input.images)&&input.images.length?input.images:[input.image]).map(String);
      if(dataUrls.length>20)throw new Error('一次最多提交 20 张截图');
      const messages=[],recognitions=[];
      for(const [index,dataUrl] of dataUrls.entries()){
        checkDistill(task);
        setDistillProgress(task,{phase:'ocr',detail:`识别截图 ${index+1}/${dataUrls.length}（本机 OCR）`,percent:2+Math.round(38*index/dataUrls.length),done:index,total:dataUrls.length});
        const match=/^data:image\/(png|jpe?g|webp|bmp);base64,(.+)$/s.exec(dataUrl);
        if(!match)throw new Error(`第 ${index+1} 张图片格式不支持，请上传 PNG/JPG/WebP/BMP 截图`);
        const tmp=path.join(os.tmpdir(),`qq-distill-${randomUUID()}.${match[1]==='jpeg'?'jpg':match[1]}`);
        fs.writeFileSync(tmp,Buffer.from(match[2],'base64'));
        try{
          const result=await ocrImageFile(tmp,{details:true,signal:task.controller.signal});
          checkDistill(task);
          const part=linesFromBubbles(result.lines,{selfSide:input.selfSide==='left'?'left':'right',otherName:'对方'});
          recognitions.push({width:result.width,height:result.height,tiles:result.tiles,textLines:result.lines.length,messages:part.length});
          messages.push(...part);
        }finally{fs.rmSync(tmp,{force:true});}
      }
      const totalTextLines=recognitions.reduce((sum,item)=>sum+item.textLines,0);
      if(!totalTextLines)throw new Error('所有图片都未识别到文字。请使用文字清晰的原图或粘贴聊天记录。');
      recognition={images:recognitions.length,width:recognitions[0].width,height:recognitions.reduce((sum,item)=>sum+item.height,0),tiles:recognitions.reduce((sum,item)=>sum+item.tiles,0),textLines:totalTextLines,messages:messages.length};
      lines=messages;
    }else{
      const dbFile=findSnowlumaDb(undefined,current.snowlumaDbPath);
      if(!dbFile)throw new Error('没有找到 SnowLuma 本地消息库，请改用粘贴聊天记录');
      lines=extractChatLog(dbFile,{selfId:bridge.status().selfId,sessionId:input.session||undefined});
    }
    checkDistill(task);
    if(lines.length<10)throw new Error(recognition?`已识别 ${recognition.textLines} 行文字，但只整理出 ${lines.length} 条聊天气泡（至少 10 条）。请检查截图是否是聊天页面及气泡左右设置。`:`可用聊天记录太少（${lines.length} 条，至少 10 条）。`);
    task.preparedLines=flattenChatRecords(lines);
    task.targets=imageMode&&!input.bothSides?['对方']:[];
    if(!task.targets.length&&!input.bothSides){
      const names=new Set(task.preparedLines.map(line=>line.split('：')[0]));
      if(names.size===2&&names.has('我'))task.targets=[...names].filter(name=>name!=='我');
    }
    task.background=String(input.background||'').trim().slice(0,2000);
    clearTimeout(task.timer);task.timer=null;
    setDistillProgress(task,{phase:'review',detail:'请校对识别文字；确认后才会发送给模型',percent:40,recognition,lines:lines.length,preview:task.preparedLines.join('\n')});
  };
  const generateDistill=async(task,lines)=>{
    try{
      checkDistill(task);
      const engine=bridge.chatEngine;
      task.engine=engine;task.threadIds=new Set();
      const runDistill=async prompt=>{
        checkDistill(task);
        const chatCfg=bridge.config.chat;
        if(chatCfg?.provider==='openai'&&chatCfg.distillModel){
          const remaining=task.deadline-Date.now();
          if(remaining<=0)throw new Error('蒸馏总时长超过 30 分钟，任务已停止');
          const result=await chatCompletion({...chatCfg,model:chatCfg.distillModel},[{role:'system',content:'你是聊天风格分析师，只输出分析结果。'},{role:'user',content:prompt}],{timeoutMs:Math.min(180000,remaining),signal:task.controller.signal});
          checkDistill(task);return String(result||'');
        }
        let id;
        try{
          // A model session admits one turn at a time; parallel chunks need independent sessions.
          id=await engine.thread(null,{persona:'你是聊天风格分析师，只输出分析结果。'});
          checkDistill(task);task.threadIds.add(id);
          const remaining=task.deadline-Date.now();
          if(remaining<=0)throw new Error('蒸馏总时长超过 30 分钟，任务已停止');
          const options={timeoutMs:Math.min(180000,remaining),signal:task.controller.signal,contextManaged:true,persistHistory:false};
          const result=bridge.runModel?await bridge.runModel(engine,id,prompt,'low','distill',options):await engine.run(id,prompt,'low',options);
          checkDistill(task);return String(result||'');
        }finally{if(id){task.threadIds.delete(id);engine.releaseThread?.(id);}}
      };
      let notes;const droppedLines=[];const chunks=chunkLines(lines,100);
      if(chunks.length>1){
        let observations=[];
        const CONC=4;
        for(let start=0;start<chunks.length;start+=CONC){
          const wave=chunks.slice(start,start+CONC);
          setDistillProgress(task,{phase:'observe',detail:`提取风格观察：第 ${start+1}–${Math.min(start+CONC,chunks.length)} 块 / 共 ${chunks.length} 块（4 路并行）`,percent:40+Math.round(45*start/chunks.length),done:start,total:chunks.length});
          const results=await Promise.all(wave.map(async(chunk,index)=>{
            const dropped=[];let isolationCalls=0;
            const observe=async part=>{
              const prompt=observationPrompt(part,task.targets,task.background);
              for(let attempt=1;attempt<=2;attempt++){
                try{
                  if(++isolationCalls>32)throw new Error('本块定位被拒记录已达到 32 次调用上限，请检查模型配置或手动清理记录后重试');
                  const out=await runDistill(prompt);
                  const rows=String(out).split(/\r?\n/).map(line=>line.trim().slice(0,120)).filter(line=>/^[SM]:/.test(line)).slice(0,120);
                  if(!rows.length)throw new Error('模型没有返回有效的风格观察');
                  return rows;
                }catch(error){
                  const retryable=/HTTP (400|5\d\d)/.test(error.message);
                  if(attempt===1&&retryable)continue;
                  if(error.contentRejected===true&&part.length>1){
                    const mid=Math.ceil(part.length/2);
                    const left=await observe(part.slice(0,mid));
                    const right=await observe(part.slice(mid));
                    return [...left,...right];
                  }
                  if(error.contentRejected===true){dropped.push(part[0]);return [];}
                  throw new Error(`第 ${start+index+1} 块分析失败${attempt>1?'（已自动重试一次）':''}：${error.message}`);
                }
              }
            };
            const rows=await observe(chunk);
            return {rows,dropped};
          }));
          for(const result of results){observations.push(...result.rows);droppedLines.push(...result.dropped);}
        }
        if(!observations.length)throw new Error('模型没有从记录里提取到任何观察，请检查校对后的记录');
        // Every input record is analyzed. Reduce observations in bounded batches instead of sampling source records.
        let level=0;
        while(observations.length>200){
          const groups=chunkLines(observations,200),merged=[];
          level++;
          for(let start=0;start<groups.length;start+=CONC){
            checkDistill(task);
            setDistillProgress(task,{phase:'merge',detail:`归并观察：第 ${level} 轮，第 ${start+1}–${Math.min(start+CONC,groups.length)} 批 / 共 ${groups.length} 批`,percent:87,done:start,total:groups.length});
            const results=await Promise.all(groups.slice(start,start+CONC).map(async(group,index)=>{
              try{
                const part=await runDistill(mergeObservationsPrompt(group,task.targets,task.background));
                const rows=part.split('\n').map(line=>line.trim().slice(0,120)).filter(line=>/^[SM]:/.test(line)).slice(0,60);
                if(!rows.length)throw new Error('模型没有返回有效的归并观察');
                return rows;
              }catch(error){throw new Error(`第 ${level} 轮、第 ${start+index+1} 批归并失败：${error.message}`);}
            }));
            for(const rows of results)merged.push(...rows);
          }
          observations=merged;
        }
        setDistillProgress(task,{phase:'synthesize',detail:`合并观察，蒸馏最终规则与回忆…${droppedLines.length?`（已自动剔除 ${droppedLines.length} 条触发服务端审核的记录）`:''}`,percent:90,done:chunks.length,total:chunks.length});
        notes=await runDistill(synthesizePrompt(observations,task.targets,task.background));
      }else{
        setDistillProgress(task,{phase:'distill',detail:'正在蒸馏风格与回忆…',percent:50,done:0,total:1});
        notes=await runDistill(distillPrompt(lines,task.targets,task.background));
      }
      if(!notes.trim())throw new Error('模型没有返回蒸馏结果，请重试');
      setDistillProgress(task,{phase:'done',detail:`蒸馏完成，结果已保存在本机${droppedLines.length?`；另有 ${droppedLines.length} 条记录因服务端内容拒绝被排除，结果仅基于其余记录`:''}`,excludedRecords:droppedLines.length,percent:100,notes:notes.trim().slice(0,16000),preview:null});
      endDistill(task,'done',distillProgress.detail);
    }catch(error){if(distillTask===task)cancelDistill(task,error.message,'error');}
  };
  const server=http.createServer(async(req,res)=>{
    const expectedHosts=new Set([`127.0.0.1:${current.consolePort}`,`localhost:${current.consolePort}`]);
    const origin=req.headers.origin;
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
    const reply=(status,body)=>{res.writeHead(status,headers);res.end(JSON.stringify(body));};
    let validOrigin=!origin;
    if(origin)try{const parsed=new URL(origin);validOrigin=parsed.protocol==='http:' && expectedHosts.has(parsed.host);}catch{}
    if(!expectedHosts.has(req.headers.host) || !validOrigin)return reply(403,{error:'只接受本地控制页请求'});
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET'&&url.pathname==='/vendor/pico.css'){
      res.writeHead(200,{...headers,'Content-Type':'text/css; charset=utf-8',
        'Content-Security-Policy':"default-src 'none'; style-src 'self'"});
      return res.end(fs.readFileSync(path.join(ROOT,'node_modules','@picocss','pico','css','pico.min.css')));
    }
    const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],
      '/form-state.js':['form-state.js','text/javascript'],'/app.css':['app.css','text/css']};
    if(req.method==='GET' && Object.hasOwn(assets,url.pathname)) {
      const [file,type]=assets[url.pathname];
      res.writeHead(200,{...headers,'Content-Type':`${type}; charset=utf-8`,
        'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});
      return res.end(fs.readFileSync(path.join(ROOT,'public',file)));
    }
    if(req.method==='GET' && url.pathname==='/healthz')return reply(200,{ok:true,app:'qq-codex-bridge',version:'0.2.0-beta.1'});
    const supplied=String(req.headers.authorization || '').replace(/^Bearer /,'');
    const suppliedBytes=Buffer.from(supplied),tokenBytes=Buffer.from(token);
    if(suppliedBytes.length!==tokenBytes.length || !timingSafeEqual(suppliedBytes,tokenBytes))return reply(401,{error:'请从启动器或启动日志中的完整地址打开控制页'});
    if(req.method==='GET' && url.pathname==='/api/environment')return reply(200,inspectEnvironment(current));
    if(req.method==='GET' && url.pathname==='/api/state') {
      const safe=structuredClone(current);safe.onebot.accessToken='';safe.chat.apiKey='';
      return reply(200,{config:safe,capabilities:{unlimitedDistillRecords:true},hasOnebotToken:!!current.onebot.accessToken,hasApiKey:!!current.chat.apiKey,revision:configRevision(current),savedAt:lastSavedAt,status:bridge.status(),logs:logs.slice(-50),baseDefault:defaults.basePersona});
    }
    if(url.pathname==='/api/social'){
      try{
        const key=url.searchParams.get('scope')||`private:${current.ownerQQ}`;
        bridge.socialData(key);
        if(req.method==='POST'){
          let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>4096)throw new Error('内容太长');}
          bridge.memory.edit(key,JSON.parse(raw),bridge.now());
        }else if(req.method!=='GET')return reply(405,{error:'不支持此方法'});
        return reply(200,{scope:key,data:bridge.socialData(key)});
      }catch(error){return reply(400,{error:error.message});}
    }
    if(req.method==='POST' && url.pathname==='/api/config') {
      try {
        if(req.headers['if-match'] && req.headers['if-match']!==configRevision(current))
          return reply(409,{error:'后台配置已更新，尚未覆盖你的输入。请撤销修改、载入最新配置后再编辑。'});
        let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>65536)throw new Error('配置内容太大');}
        if(req.headers['if-match'] && req.headers['if-match']!==configRevision(current))return reply(409,{error:'后台配置已更新，尚未覆盖你的输入。请撤销修改、载入最新配置后再编辑。'});
        const input=resolveChat(JSON.parse(raw));if(input.onebot?.accessToken==='__KEEP__')input.onebot.accessToken=current.onebot.accessToken;
        const next=validateConfig(input,current);
        if(next.consolePort!==current.consolePort)throw new Error('控制页不修改端口，请手动编辑 config.json 后重启');
        const changed=configRevision(next)!==configRevision(current);
        let applied='设置没有变化';
        if(changed){persist(next);current=next;lastSavedAt=new Date().toISOString();onSave(next);applied=bridge.configure(next);}
        return reply(200,{ok:true,changed,applied,revision:configRevision(current),savedAt:lastSavedAt,hasOnebotToken:!!current.onebot.accessToken,hasApiKey:!!current.chat.apiKey});
      }catch(error){return reply(400,{error:error.message,field:error.field||null});}
    }
    if(req.method==='POST' && url.pathname==='/api/chat/test'){
      if(testing)return reply(409,{error:'已有模型连接测试正在运行，请稍候'});
      testing=true;
      try{
        let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>16384)throw new Error('测试配置太大');}
        const input=resolveChat(JSON.parse(raw));const next=validateConfig({...current,chat:{...input.chat,provider:'openai'}},current);
        const start=Date.now();let usage=null,ok=false;
        try{await testChat(next.chat,value=>{usage=value;});ok=true;}
        finally{bridge.telemetry?.record({kind:'test',provider:'api',model:next.chat.model,durationMs:Date.now()-start,ok,usage});}
        return reply(200,{ok:true,message:'模型连接成功，可以保存并应用。测试仅发送固定测试文字，没有发送聊天记录。'});
      }catch(error){return reply(400,{error:error.message,field:error.field||null});}finally{testing=false;}
    }
    if(req.method==='GET' && url.pathname==='/api/distill/progress')return reply(200,distillProgress||{phase:'idle'});
    if(req.method==='GET' && url.pathname==='/api/distill/sessions'){
      try{
        const dbFile=findSnowlumaDb(undefined,current.snowlumaDbPath);
        if(!dbFile)return reply(200,{sessions:[],source:null});
        return reply(200,{source:dbFile,sessions:listSessions(dbFile)});
      }catch(error){return reply(400,{error:error.message});}
    }
    if(req.method==='POST' && url.pathname==='/api/distill'){
      if(testing)return reply(409,{error:'已有模型测试或蒸馏任务正在运行，请稍候'});
      try{
        const raw=await readBody(req,67108864,'提交内容超过 64 MiB；请分批提交文件或图片（一次最多 20 张截图）');
        const input=JSON.parse(raw);
        if(!input||typeof input!=='object')throw new Error('蒸馏请求格式不正确');
        if(testing)return reply(409,{error:'已有模型测试或蒸馏任务正在运行，请稍候'});
        const task={id:randomUUID(),controller:new AbortController(),deadline:null,preparedLines:null,engine:null,threadIds:new Set()};
        testing=true;distillTask=task;distillProgress=null;
        setDistillProgress(task,{phase:'start',detail:'准备聊天记录…',percent:2,done:0,total:0,startedAt:Date.now()});
        task.timer=setTimeout(()=>cancelDistill(task,'蒸馏总时长超过 30 分钟，任务已停止','error'),30*60000).unref();
        void prepareDistill(task,input).catch(error=>{if(distillTask===task)endDistill(task,'error',error.message);});
        return reply(202,{ok:true,id:task.id});
      }catch(error){return reply(400,{error:error.message});}
    }
    if(req.method==='POST' && url.pathname==='/api/distill/confirm'){
      try{
        const task=distillTask;
        if(!task||distillProgress?.phase!=='review')return reply(409,{error:'当前没有等待校对的蒸馏任务'});
        const raw=await readBody(req,67108864,'校对内容超过 64 MiB；请分批提交');
        const input=JSON.parse(raw);
        if(distillTask!==task||distillProgress?.phase!=='review')return reply(409,{error:'任务已更新或已开始分析，请刷新进度后再确认'});
        if(input.id!==task.id)return reply(409,{error:'任务已更新，请刷新进度后再确认'});
        const lines=validateReviewedLog(input.text);
        if(typeof input.background==='string')task.background=input.background.trim().slice(0,2000);
        task.preparedLines=null;
        task.deadline=Date.now()+30*60000;
        task.timer=setTimeout(()=>cancelDistill(task,'模型分析超过 30 分钟，任务已停止','error'),30*60000).unref();
        setDistillProgress(task,{phase:'analyze',detail:'已确认记录，开始调用模型…',percent:40,lines:lines.length,preview:null});
        void generateDistill(task,lines);
        return reply(202,{ok:true,id:task.id});
      }catch(error){return reply(400,{error:error.message});}
    }
    if(req.method==='POST' && url.pathname==='/api/distill/cancel'){
      const task=distillTask;
      if(!task)return reply(409,{error:'当前没有运行中的蒸馏任务'});
      try{
        let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>1024)throw new Error('请求太长');}
        if(distillTask!==task)return reply(409,{error:'任务已更新，请刷新进度后再取消'});
        if(JSON.parse(raw).id!==task.id)return reply(409,{error:'任务已更新，请刷新进度后再取消'});
        cancelDistill(task);return reply(200,{ok:true,id:task.id});
      }catch(error){return reply(400,{error:error.message});}
    }    if(url.pathname==='/api/personas'){
      const file=personasFile;
      const load=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
      try{
        if(req.method==='GET')return reply(200,{presets:load()});
        let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>65536)throw new Error('内容太大');}
        const input=JSON.parse(raw);
        const name=String(input.name||'').trim();
        if(!/^[\p{L}\p{N}_-]{1,32}$/u.test(name))return reply(400,{error:'预设名称只支持中文、字母、数字、下划线和短横线，最多 32 字'});
        const presets=load();
        if(req.method==='DELETE'){delete presets[name];atomicWrite(file,presets);return reply(200,{ok:true,presets});}
        const text=String(input.text||'');
        if(text.length>6000)return reply(400,{error:'人设最多 6000 字符'});
        presets[name]={text,updatedAt:new Date().toISOString()};
        atomicWrite(file,presets);return reply(200,{ok:true,presets});
      }catch(error){return reply(400,{error:error.message});}
    }
    if(req.method==='POST' && url.pathname==='/api/personas/apply'){
      try{
        let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>16384)throw new Error('内容太大');}
        const input=JSON.parse(raw);
        const name=String(input.name||'').trim();
        const presets=fs.existsSync(personasFile)?JSON.parse(fs.readFileSync(personasFile,'utf8')):{};
        if(!Object.hasOwn(presets,name))return reply(400,{error:'没有这个人设预设'});
        const next={...current,persona:presets[name].text};
        persist(next);current=next;lastSavedAt=new Date().toISOString();onSave(next);bridge.configure(next);
        return reply(200,{ok:true,revision:configRevision(current),savedAt:lastSavedAt,persona:current.persona});
      }catch(error){return reply(400,{error:error.message});}
    }
    reply(404,{error:'接口不存在'});
  });
  return server;
}
export async function main() {
  const config=loadConfig();const tokenFile=path.join(STATE,'console-token');
  const token=fs.existsSync(tokenFile)?fs.readFileSync(tokenFile,'utf8').trim():randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile,token,{mode:0o600});
  const logs=[];const log=message=>{const entry={time:new Date().toLocaleTimeString('zh-CN',{hour12:false}),message};logs.push(entry);if(logs.length>100)logs.shift();console.log(`[${entry.time}] ${message}`);};
  const bridge=new Bridge(config,{log});
  const server=createConsole(bridge,{token,logs,config});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.consolePort,'127.0.0.1',resolve);});
  console.log(`控制页：http://127.0.0.1:${config.consolePort}/#${token}`);
  bridge.configure(config);
  const shutdown=()=>{bridge.stop();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  return {server,bridge,token};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(`启动失败：${error.message}`);process.exitCode=1;});
