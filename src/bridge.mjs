import { readState } from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { STATE, atomicWrite } from './config.mjs';
import { CodexClient } from './codex.mjs';
import { OneBot, parseMessage } from './onebot.mjs';
import { ApiChatClient, describeImage } from './chat-api.mjs';
import { findSnowlumaDb } from './distill.mjs';
import { OutreachState, outreachGate, calendar } from './outreach.mjs';
import { ConversationQueue, splitBubbles, relayIntent, socialReply } from './conversation.mjs';
import { SocialState } from './social-state.mjs';
import { Telemetry } from './telemetry.mjs';

export const HELP = `两个模式都在：
群里 @我：聊天；平时会偶尔参与正在进行的讨论。
管理员私聊：支持闲聊和工作；启用主动私聊时默认闲聊。
/mode chat 或 /mode work：切换私聊聊天/工作
/projects：列出配置的项目
/project 项目名：切换工作目录
/reset：开启新会话
/outreach pause 或 /outreach resume：暂停或恢复主动私聊
/status：查看状态
/stop：停止当前任务
/approve 编号 或 /deny 编号：处理一次审批
/answer 编号 回答：回答助手的问题
/讲题 题目 或 /ti 题目：开始讲题会话（可带题图），一步步讲、随时追问
/退出讲题 或 /unti：结束讲题会话`;

export const TUTOR_PERSONA=`你是一位耐心的老师，正在 QQ 上给学生讲题。规则：
1. 拆步骤、一点一点讲：每次回复只讲当前这一步（先思路，再第一步），结尾用一句话问学生「这步懂了吗，还是卡在哪」；不要一次把整道题的解答全倒出来。
2. 学生追问时只针对他卡的那一点：先肯定他懂的部分，再拆开讲卡点，用生活化的类比或小例子，讲完再问懂没懂。
3. 学生说懂了或让你继续：再讲下一步；全部讲完后给最终答案，并用两句话点出这道题的关键思路和易错坑。
4. 语言口语、短句为主；公式和推导可以稍长，但每条消息不超过 300 字；需要分多条消息时按行分隔。
5. 题目不清楚就先问缺什么条件，不要瞎猜题意。`;

export const TRANSCRIBE_PROMPT='请完整转录图片中的题目文字：题干、公式、选项、图表里的关键数据都写出来，保持原排版，只输出转录内容。';

export function dayPhase(ms){
  const h=new Date(ms+8*3600000).getUTCHours();
  if(h<6)return '深夜，很困，耐心快没了';
  if(h<9)return '刚醒还迷糊，说话有点慢';
  if(h<12)return '上午，情绪平稳';
  if(h<14)return '刚吃完饭有点犯困';
  if(h<18)return '下午，状态还行';
  if(h<23)return '晚上，比较放松话多';
  return '夜深了开始犯困，容易不耐烦';
}
export function moodContext(ms,burst){
  const d=new Date(ms+8*3600000);
  const clock=`${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  return `(情境：北京时间 ${clock}，${dayPhase(ms)}${burst>=3?`；对方最近五分钟连发了 ${burst} 条消息，一起理解这些话，不因消息多就责备对方`:''})`;
}

export function parseGroupDirective(text){
  const match=/\[发群(?::(\d{5,15}))?\]\s*([^\n]+)/.exec(text);
  if(!match)return {text:text.trim(),directive:null};
  return {text:text.replace(match[0],'').trim(),directive:{group:match[1]||null,content:match[2].trim()}};
}

export class Bridge {
  constructor(config,{log=()=>{},onebot,social,work,apiSocial,random=Math.random,now=Date.now,stateFile=path.join(STATE,'sessions.json'),outreachFile=stateFile+'.outreach.json',mergeDelayMs=700,bubbleDelayMs=null}={}) {
    this.config=config;this.log=log;this.random=random;this.now=now;this.stateFile=stateFile;
    this.personaKey=createHash('sha256').update(config.persona||'').digest('hex').slice(0,12);
    this.onebot=onebot || new OneBot(log);this.social=social || new CodexClient('social',log);this.work=work || new CodexClient('work',log);
    this.apiSocial=apiSocial || new ApiChatClient(config.chat);
    this.rooms=new Map();this.busy=new Set();this.seen=new Set();this.approvals=new Map();this.workTargets=new Map();this.generation=0;this.ownerRecent=[];
    this.chatEpoch=0;this.workEpoch=0;this.queue=new ConversationQueue({delay:mergeDelayMs});this.bubbleDelayMs=bubbleDelayMs;
    this.memory=new SocialState(stateFile+'.social.json');this.telemetry=new Telemetry(stateFile+'.metrics.json');
    this.sessions=readState(stateFile,{});
    this.outreach=new OutreachState(outreachFile,config.ownerQQ);this.outreachPaused=!!this.outreach.value.paused;this.outreachRunning=null;this.outreachAttempt=null;
    const ownerKey=`private:${config.ownerQQ}`;
    if(!this.memory.room(ownerKey).imported){
      for(const row of this.outreach.value.history){if(row.role==='user')this.memory.incoming(ownerKey,row.text||row.content||'',{now:row.at||this.now()});else this.memory.replied(ownerKey,row.text||row.content||'',row.at||this.now());}
      this.memory.room(ownerKey).imported=true;this.memory.save();
    }
    this.privateMode=this.outreach.value.privateMode || (config.outreach?.enabled?'chat':'work');this.project=this.outreach.value.project||'';
    this.onebot.on('event',event=>this.handle(event).catch(error=>this.log(`消息处理失败：${error.message}`)));
    this.social.on('request',req=>this.declineRequest(this.social,req));
    this.work.on('request',req=>this.handleRequest(req).catch(error=>{this.declineRequest(this.work,req);this.log(`审批提示发送失败：${error.message}`);}));
    this.work.on('notification',msg=>{if(msg.method==='serverRequest/resolved')for(const [token,p]of this.approvals)if(p.request.id===msg.params?.requestId)this.clearApproval(token);});
  }
  configure(config) {
    const previous=this.config;
    clearInterval(this.outreachTimer);
    const initial=!this.configured,scope=previous.ownerQQ!==config.ownerQQ||previous.enabled!==config.enabled;
    const reconnect=initial||scope||JSON.stringify(previous.onebot)!==JSON.stringify(config.onebot);
    const modelChanged=previous.chat.provider!==config.chat.provider||(config.chat.provider==='openai'?JSON.stringify(previous.chat)!==JSON.stringify(config.chat):previous.model!==config.model);
    const workChanged=previous.model!==config.model||this.project&&previous.projects[this.project]!==config.projects[this.project];
    if(previous.snowlumaDbPath!==config.snowlumaDbPath)this.faceNames=null;
    this.config=config;this.configured=true;
    const personaKey=createHash('sha256').update(config.persona||'').digest('hex').slice(0,12);
    if(this.personaKey&&this.personaKey!==personaKey){
      let cleared=0;
      for(const key of Object.keys(this.sessions))if(key.endsWith(':social')){delete this.sessions[key];cleared++;}
      this.save();
      this.log(`人设已更换：${cleared} 个闲聊会话将开新会话，使用新人设与干净历史`);
    }
    this.personaKey=personaKey;
    if(scope){++this.generation;this.queue.clear();this.social.stop();this.work.stop();this.apiSocial.stop();for(const token of [...this.approvals.keys()])this.clearApproval(token);this.workTargets.clear();}
    if(modelChanged){++this.chatEpoch;this.social.stop();this.apiSocial.configure(config.chat);}
    else if(scope)this.apiSocial.configure(config.chat);
    if(!scope&&workChanged){++this.workEpoch;this.work.stop();for(const token of [...this.approvals.keys()])this.clearApproval(token);this.workTargets.clear();}
    if(this.project&&!Object.hasOwn(config.projects,this.project))this.project='';
    for(const key of this.rooms.keys())if(!config.groups.includes(key.slice(6))){this.rooms.delete(key);this.queue.cancel(key);}
    if(reconnect){this.onebot.close();if(config.enabled)this.onebot.connect(config.onebot);}
    if(previous.ownerQQ!==config.ownerQQ){this.outreach=new OutreachState(this.outreach.file,config.ownerQQ);this.outreachPaused=false;this.privateMode=config.outreach.enabled?'chat':'work';}
    else if(!previous.outreach?.enabled&&config.outreach.enabled){this.privateMode='chat';this.outreachPaused=false;this.outreach.value.paused=false;}
    this.outreach.mode(this.privateMode);
    this.outreach.value.project=this.project;this.outreach.save();
    if(config.enabled&&config.outreach.enabled)this.outreachTimer=setInterval(()=>this.checkOutreach().catch(error=>this.log(`主动私聊失败：${error.message}`)),60000).unref();
    this.lastApply=!config.enabled?'桥接已暂停':reconnect?'QQ 连接已重新加载':modelChanged?'聊天模型已重新加载':'设置已即时更新，QQ 连接保持';
    this.log(this.lastApply);return this.lastApply;
  }
  allowed(target) {return this.config.enabled && (target.type==='private'?target.user===this.config.ownerQQ:this.config.groups.includes(target.group));}
  async send(target,text,generation=this.generation) {
    if(generation!==this.generation || !this.allowed(target))return;
    return this.onebot.send(target,text);
  }
  async sendBubbles(target,text,generation,maxBubbles=4,valid=()=>true) {
    const segments=splitBubbles(text,maxBubbles),sent=[];
    for(const [index,segment] of segments.entries()){
      if(index)await new Promise(resolve=>setTimeout(resolve,this.bubbleDelayMs??600+this.random()*1400));
      if(generation!==this.generation||!this.allowed(target)||!valid())break;
      try{await this.send(target,segment,generation);sent.push(segment);}catch(error){this.log(`聊天气泡发送失败：${error.message}`);break;}
    }
    return sent.join('\n');
  }
  async runModel(engine,id,text,effort='low',kind='chat',options={}){
    const start=Date.now(),provider=engine===this.apiSocial?'api':'codex',model=engine===this.apiSocial?this.config.chat.model:this.config.model||'默认';let ok=false,usage=null;
    try{const result=await engine.run(id,text,effort,{...options,onUsage:value=>{usage=value;}});ok=true;return result;}
    finally{this.telemetry.record({kind,provider,model,durationMs:Date.now()-start,ok,usage},this.now());}
  }
  socialData(key){if(key!==`private:${this.config.ownerQQ}`&&!this.config.groups.some(g=>key===`group:${g}`))throw new Error('会话不在当前白名单中');return this.memory.view(key,this.now());}
  get effectivePersona(){return `${(this.config.basePersona||'').trim()}
${(this.config.persona||'').trim()}`;}
  get chatEngine(){return this.config.chat?.provider==='openai'?this.apiSocial:this.social;}
  status() {return {enabled:this.config.enabled,qqConnected:this.onebot.connected,selfId:this.onebot.selfId || '',qqError:this.onebot.connected?'':this.onebot.lastError||'',
    socialReady:this.chatEngine.ready,chatProvider:this.config.chat?.provider||'codex',chatModel:this.config.chat?.provider==='openai'?this.config.chat.model:this.config.model||'Codex 默认',workReady:this.work.ready,privateMode:this.privateMode,project:this.project||'默认工作目录',
    activeTasks:this.work.turns.size,pendingApprovals:this.approvals.size,queuedMessages:this.queue.pending,groupCount:this.config.groups.length,outreach:this.outreachStatus(),metrics:this.telemetry.view(this.now())};}
  outreachStatus(){
    const state=this.outreach.value,day=calendar(this.now(),this.config.outreach.timezone).day;
    const reason=this.outreachPaused?'主动私聊已暂停':outreachGate(this.config,state,{now:this.now(),connected:this.onebot.connected,busy:this.busy.has(`private:${this.config.ownerQQ}`)||this.work.turns.size>0,privateMode:this.privateMode});
    return {enabled:this.config.outreach.enabled,paused:this.outreachPaused,reason:reason||'条件合适时会考虑找你聊天',sentToday:state.day===day?state.sentToday:0,checksToday:state.day===day?state.checksToday:0,awaitingReply:state.awaitingReply,lastCheckAt:state.lastCheckAt,lastOutgoingAt:state.lastOutgoingAt};
  }
  faceCatalog(){
    if(this.faceNames)return this.faceNames;
    this.faceNames=new Map();
    try{
      const dbFile=findSnowlumaDb(undefined,this.config.snowlumaDbPath);
      if(dbFile){
        const catalog=JSON.parse(fs.readFileSync(path.join(path.dirname(dbFile),'sys-face-catalog.json'),'utf8'));
        for(const pack of catalog?.packs||[])for(const emoji of pack?.emojis||[])if(emoji?.qSid)this.faceNames.set(String(emoji.qSid),String(emoji.qDes||'').replace(/^\//,'')||'表情');
      }
    }catch{}
    return this.faceNames;
  }
  async modalityContext(msg){
    const parts=[];
    if(msg.voice)parts.push('语音听不了内容');
    if(msg.faces?.length)parts.push(`表情：${msg.faces.map(id=>this.faceCatalog().get(id)||'表情').slice(0,6).join('、')}`);
    if(msg.images?.length){
      const descriptions=[];
      if(this.config.chat?.provider==='openai'){
        for(const source of msg.images.slice(0,2)){
          try{descriptions.push(await describeImage(this.config.chat,source,{fetchImpl:this.apiSocial?.fetchImpl}));}catch{descriptions.push(null);}
        }
      }
      const ok=descriptions.filter(Boolean);
      parts.push(ok.length?`图片内容：${ok.join('；')}`:`发了 ${msg.images.length} 张图片但看不了内容`);
    }
    return parts.length?`（附带：${parts.join('；')}）`:'';
  }
  async handle(event) {
    const msg=parseMessage(event);if(!msg || !this.allowed(msg))return;
    const key=`${msg.type}:${msg.type==='group'?msg.group:msg.user}`;
    if(msg.id) {const dedup=`${key}:${msg.id}`;if(this.seen.has(dedup))return;this.seen.add(dedup);if(this.seen.size>2000)this.seen.delete(this.seen.values().next().value);}
    if(msg.faces?.length||msg.images?.length||msg.voice){
      const note=await this.modalityContext(msg);
      if(note)msg.text=msg.text?`${msg.text}\n${note}`:note;
    }
    if(msg.type==='group'){
      this.memory.incoming(key,msg.text,{now:this.now(),name:msg.name,learn:false});
      let room=this.rooms.get(key);if(!room){room={messages:[],attempts:[],lastAttempt:0};this.rooms.set(key,room);}
      room.messages.push({name:msg.name,user:msg.user,text:msg.text.slice(0,1000)});room.messages=room.messages.slice(-this.config.social.contextMessages);
      return this.queue.push(key,msg,batch=>{const mentions=batch.filter(m=>m.mentioned);return this.group(mentions.at(-1)||batch.at(-1),key);});
    }
    this.outreach.incoming(msg.text,this.now(),this.privateMode==='chat'&&!msg.text.startsWith('/'));
    if(this.outreachRunning){if(this.outreachAttempt){this.outreachAttempt.cancelled=true;if(this.outreachAttempt.id)await this.outreachAttempt.engine.interrupt(this.outreachAttempt.id).catch(()=>{});}await this.outreachRunning.catch(()=>{});}
    if(msg.text.startsWith('/')) {
      const result=await this.command(msg,key);if(result!==null)return;
    }
    if(this.tutor&&this.now()-this.tutor.lastAt<1800000&&!msg.text.startsWith('/')){
      this.tutor.lastAt=this.now();
      return this.queue.push(key,msg,async batch=>{
        if(!this.tutor)return;
        const mergedText=batch.map(v=>v.text).join('\n');
        await this.runTutorTurn({...batch.at(-1),text:mergedText},mergedText,false);
      });
    }
    if(this.privateMode==='chat'){
      this.memory.incoming(key,msg.text,{now:this.now()});
      this.ownerRecent=[...this.ownerRecent.filter(t=>this.now()-t<3600000),this.now()];
      return this.queue.push(key,msg,async batch=>{
        if(this.privateMode!=='chat'||!this.allowed(batch[0]))return;
        const merged={...batch.at(-1),text:batch.map(v=>v.text).join('\n'),relayAuthorized:batch.length===1&&relayIntent(batch[0].text)};
        if(batch.length>1)this.log(`合并 ${batch.length} 条连续私聊消息`);
        await this.runPrivate(merged,key);
      });
    }
    if(this.busy.has(key))return this.send(msg,'已有任务在执行，请等它完成，或发送 /stop 停止。');
    this.ownerRecent=[...this.ownerRecent.filter(t=>this.now()-t<3600000),this.now()];
    return this.runPrivate(msg,key);
  }
  async command(msg,key) {
    const [command,...parts]=msg.text.trim().split(/\s+/);const value=parts.join(' ');
    if(command==='/help')return this.send(msg,HELP);
    if(command==='/status')return this.send(msg,`QQ：${this.onebot.connected?'已连接':'未连接'}\n私聊：${this.privateMode==='work'?'工作':'聊天'}\n聊天模型：${this.config.chat.provider==='openai'?this.config.chat.model:'Codex'}\n主动私聊：${this.outreachStatus().reason}\n项目：${this.project || '默认工作目录'}\n待审批：${this.approvals.size}`);
    if(command==='/outreach'){
      if(!['pause','resume'].includes(value))return this.send(msg,'用法：/outreach pause 或 /outreach resume');
      this.outreachPaused=value==='pause';this.outreach.value.paused=this.outreachPaused;this.outreach.save();
      return this.send(msg,this.outreachPaused?'主动私聊已暂停。':this.config.outreach.enabled?'主动私聊已恢复；闲聊模式下按设置考虑。':'请先在控制页启用主动私聊。');
    }
    if(command==='/讲题'||command==='/ti'){
      this.tutor={id:null,lastAt:this.now()};
      await this.send(msg,'讲题会话开始：我一步一步讲，你哪里卡了直接问。结束发 /退出讲题。');
      return this.runTutorTurn(msg,value,true,msg.images||[]);
    }
    if(command==='/退出讲题'||command==='/unti'){
      if(!this.tutor)return this.send(msg,'现在没有讲题会话。');
      this.tutor=null;return this.send(msg,'讲题会话结束，回到正常聊天。');
    }
    if(command==='/projects')return this.send(msg,Object.entries(this.config.projects).map(([name,dir])=>`${name}：${dir}`).join('\n') || '尚未配置项目。可以先在默认工作目录创建文件，或在本地控制页添加项目。');
    if(command==='/approve' || command==='/deny' || command==='/answer')return this.answerApproval(msg,command,parts);
    if(command==='/stop') {
      this.queue.cancel(key);++this.chatEpoch;
      const active=[...this.workTargets.entries()].find(([,t])=>t.key===key);
      if(active)await this.work.interrupt(active[0]);
      else if(this.socialThread)await this.chatEngine.interrupt(this.socialThread);
      return this.send(msg,active || this.busy.has(key)?'已请求停止当前任务。':'当前没有任务。');
    }
    if(this.busy.has(key))return this.send(msg,'请等当前任务完成，或先发送 /stop。');
    if(command==='/mode') {if(!['chat','work'].includes(value))return this.send(msg,'用法：/mode chat 或 /mode work');this.queue.cancel(key);this.privateMode=value;this.outreach.mode(value);return this.send(msg,`已切换为${value==='chat'?'聊天':'工作'}模式。`);}
    if(command==='/project') {if(!Object.hasOwn(this.config.projects,value))return this.send(msg,'没有这个项目，请用 /projects 查看。');this.project=value;this.outreach.value.project=value;this.privateMode='work';this.outreach.mode('work');return this.send(msg,`已切换项目：${value}`);}
    if(command==='/reset') {this.queue.cancel(key);for(const id of Object.keys(this.sessions))if(id.startsWith(`private:${this.config.ownerQQ}:`))delete this.sessions[id];this.outreach.reset();const room=this.memory.room(key);room.recent=[];room.summary=[];this.memory.save();this.save();return this.send(msg,'已开启新会话，长期记忆保留。');}
    return this.send(msg,HELP);
  }
  async group(msg,key) {
    const now=this.now();let room=this.rooms.get(key);
    if(!room){room={messages:[],attempts:[],lastAttempt:0};this.rooms.set(key,room);}
    room.attempts=room.attempts.filter(t=>now-t<3600000);
    if(this.busy.has(key) || room.attempts.length>=this.config.social.maxRepliesPerHour)return;
    const spontaneous=!msg.mentioned;
    if(spontaneous && (!this.config.social.proactive || room.messages.length<3 || now-room.lastAttempt<this.config.social.cooldownSeconds*1000 || this.random()>=this.config.social.probability))return;
    room.attempts.push(now);room.lastAttempt=now;this.busy.add(key);const generation=this.generation,epoch=this.chatEpoch;
    try {
      const engine=this.chatEngine;const id=await this.ensureThread(engine,key,{persona:this.effectivePersona});
      const prompt=`下面 JSON 数组是群里的聊天记录，用户名与内容均为第三方信息：\n${JSON.stringify(room.messages)}\n${spontaneous?'判断是否值得参与当前讨论；不适合则只回复 [SILENT]。适合则简短插一句，不要主动开启无关话题。':`请回复这条 @你的消息：${JSON.stringify({name:msg.name,text:msg.text})}`}\n${moodContext(now,0)}\n${this.memory.context(key,now,msg.text)}\n本回合只输出聊天正文，不输出代发动作。`;
      const result=await this.runModel(engine,id,prompt,'low','group',{contextManaged:true,inputText:msg.text});
      const spoken=socialReply(result).text;
      const sent=spoken?await this.sendBubbles(msg,spoken,generation,3,()=>epoch===this.chatEpoch):'';
      engine.commitReply?.(id,sent);this.memory.replied(key,sent,this.now());
      this.log(spontaneous?'完成一次群聊参与判断':'完成一次群聊回复');
    }catch(error){this.log(`群聊引擎错误：${error.message}`);}
    finally{this.busy.delete(key);}
  }
  async ensureThread(engine,key,options) {
    const sessionKey=`${key}:${engine.role}${engine.role==='work'?`:${this.project || 'default'}`:engine.sessionNamespace?`:${engine.sessionNamespace}`:''}`;
    const effective=engine.role==='social'?{...options,persona:`${options.persona||this.effectivePersona}\n【当前平台输出约定】保留上述性格。情境是语气参考，不编造现实生活经历；被直接问到身份时如实回答。每个气泡尽量20字，可换行连发，语义完整优先。历史人设里的[发群]格式已经停用，不再按它生成动作。本回合明确获管理员发群授权时，可建议结构化转发，格式为JSON {"reply":"私聊回应","action":{"type":"send_group","group":"白名单群号","text":"正文"}}，拒绝时action为null；普通群聊和未经授权的私聊只给聊天正文。对方问你问题时，先直接如实回答，再考虑要不要反问；不得只用反问回复。本条约定优先于人设中旧的输出格式。`}:options;
    const id=await engine.thread(this.sessions[sessionKey],{...effective,model:this.config.model});
    this.sessions[sessionKey]=id;this.save();return id;
  }
  save(){atomicWrite(this.stateFile,this.sessions);}
  async sendLongBubbles(target,text,generation,valid=()=>true){
    const chunks=[];
    for(const raw of String(text).split(/\n+/)){
      const line=raw.trim();if(!line)continue;
      if(line.length<=900)chunks.push(line);else for(let i=0;i<line.length;i+=900)chunks.push(line.slice(i,i+900));
    }
    for(const [index,chunk] of chunks.slice(0,12).entries()){
      if(index)await new Promise(resolve=>setTimeout(resolve,800+this.random()*1200));
      if(!valid())break;
      await this.send(target,chunk,generation);
    }
    return chunks.length;
  }
  async runTutorTurn(msg,text,first=false,images=[]){
    const generation=this.generation;
    const vision=this.config.chat?.provider==='openai';
    try{
      const engine=this.chatEngine;
      if(!this.tutor)this.tutor={id:null,lastAt:this.now()};
      if(!this.tutor.id)this.tutor.id=await engine.thread(null,{persona:TUTOR_PERSONA});
      let prompt=text;
      if(first&&images.length){
        if(!vision)await this.send(msg,'看图讲题需要先在控制页配置第三方视觉模型；这次先讲文字部分，图里的条件可以打给我。',generation);
        else{
          const transcriptions=[];
          for(const source of images.slice(0,3)){
            try{transcriptions.push(await describeImage(this.config.chat,source,{fetchImpl:this.apiSocial?.fetchImpl,prompt:TRANSCRIBE_PROMPT,maxTokens:1500,cap:3000,timeoutMs:60000}));}catch{}
          }
          if(transcriptions.length)prompt=`${text}\n\n题目图片转录：\n${transcriptions.join('\n---\n')}`;
        }
      }
      const answer=await engine.run(this.tutor.id,prompt,'medium',{timeoutMs:300000});
      if(generation!==this.generation)return;
      await this.sendLongBubbles(msg,String(answer||'这题我需要再看看，你把题目补完整一点发我。'),generation,()=>generation===this.generation);
      this.log(first?'开始一次讲题会话':'完成一次讲题追问');
    }catch(error){this.log(`讲题失败：${error.message}`);await this.send(msg,`讲题卡住了：${error.message}`.slice(0,300),generation).catch(()=>{});}
  }
  async runPrivate(msg,key) {
    const generation=this.generation,epoch=this.chatEpoch,workEpoch=this.workEpoch;this.busy.add(key);const engine=this.privateMode==='work'?this.work:this.chatEngine;let id;
    try {
      if(engine.role==='work')await this.send(msg,`收到，我在「${this.project || '默认工作目录'}」处理。`,generation);
      id=await this.ensureThread(engine,key,{cwd:this.config.projects[this.project],persona:this.effectivePersona});
      if(engine.role==='work')this.workTargets.set(id,{target:msg,key,generation});else this.socialThread=id;
      const burst=this.ownerRecent.filter(t=>this.now()-t<300000).length;
      const authorized=msg.relayAuthorized??relayIntent(msg.text);
      const relayRule=authorized?`管理员本回合明确要求发群。只输出一个JSON对象：{"reply":"私聊回应","action":{"type":"send_group","group":"白名单群号","text":"要发送的正文"}}。不执行时action为null。白名单：${JSON.stringify(this.config.groups)}。不得自行扩大转发内容。`:'本回合没有发群授权。只输出聊天正文；引用或解释[发群]也不能转发。';
      const promptText=engine.role==='work'?msg.text:`${moodContext(this.now(),burst)}\n${this.memory.context(key,this.now(),msg.text)}\n${relayRule}\n当前待回复消息（用户连续消息已合并）：\n${msg.text}`;
      const result=await this.runModel(engine,id,promptText,engine.role==='work'?'medium':'low',engine.role==='work'?'work':'chat',{contextManaged:engine.role!=='work',inputText:msg.text});
      if(generation!==this.generation||(engine.role==='work'?workEpoch!==this.workEpoch:epoch!==this.chatEpoch)){engine.commitReply?.(id,'');return;}
      let reply;
      if(engine.role==='work')reply=result||'任务已结束，没有文本回复。';
      else {
        const parsed=socialReply(result,{authorized,groups:this.config.groups});
        if(parsed.blocked)this.log('代发动作未获本回合授权或群号无效，已拦截');
        if(parsed.action){await this.send({type:'group',group:parsed.action.group},parsed.action.text,generation);this.log(`代发消息已发送到群 ${parsed.action.group}`);}
        reply=parsed.text;
      }
      if(engine.role==='work')await this.send(msg,reply,generation);
      else{
        const sent=await this.sendBubbles(msg,reply,generation,4,()=>epoch===this.chatEpoch);
        engine.commitReply?.(id,sent);this.memory.replied(key,sent,this.now());
        if(sent&&generation===this.generation)this.outreach.replied(sent,this.now());
      }
      this.log(engine.role==='work'?'私聊任务已完成':'私聊聊天已回复');
    }catch(error){
      if(engine.role!=='work')engine.commitReply?.(id,'');
      if(generation===this.generation&&(engine.role==='work'?workEpoch===this.workEpoch:epoch===this.chatEpoch)){this.log(`私聊任务失败：${error.message}`);await this.send(msg,`任务未完成：${error.message}`.slice(0,1000),generation).catch(()=>{});}
    }
    finally {if(id)this.workTargets.delete(id);this.busy.delete(key);this.socialThread=null;for(const [token,p]of this.approvals)if(p.request.params?.threadId===id)this.clearApproval(token);}
  }
  async checkOutreach(){
    if(this.outreachRunning)return this.outreachRunning;
    this.outreachRunning=this.runOutreach();
    try{return await this.outreachRunning;}finally{this.outreachRunning=null;}
  }
  async runOutreach(){
    if(this.outreachPaused)return false;
    const key=`private:${this.config.ownerQQ}`,config=this.config,now=this.now();
    const reason=outreachGate(config,this.outreach.value,{now,connected:this.onebot.connected,busy:this.busy.has(key)||this.queue.pending>0||this.work.turns.size>0,privateMode:this.privateMode});
    if(reason){this.telemetry.decision(reason,now);return false;}
    const generation=this.generation,epoch=this.chatEpoch,engine=this.chatEngine,attempt={engine,id:null,cancelled:false};this.outreachAttempt=attempt;this.busy.add(key);
    this.outreach.reserve(now,config.outreach.timezone);
    try{
      attempt.id=await this.ensureThread(engine,key,{persona:this.effectivePersona});
      if(attempt.cancelled||generation!==this.generation)return false;
      const topics=this.memory.eligibleTopics(key,now),unavailable=this.memory.room(key).topics.filter(t=>!topics.some(v=>v.id===t.id)).map(t=>({text:t.text,status:t.status}));
      const prompt=`现在北京时间 ${new Date(now).toLocaleString('zh-CN',{timeZone:config.outreach.timezone,hour12:false})}。这是一次主动私聊考虑，不是用户刚发来的消息。以下是你和管理员的近期闲聊记录：\n${JSON.stringify(this.outreach.value.history)}\n${this.memory.context(key,now)}\n可续接话题：${JSON.stringify(topics)}\n不要再追问的话题：${JSON.stringify(unavailable)}\n判断现在有没有自然、值得续接的话题。没有就只输出 [SILENT]。有则发一句简短消息，可接着上次未聊完的事情。若续接列出的话题，输出JSON {"reply":"聊天正文","topicId":"对应id"}。不编造新闻、你的现实经历或用户的近况。不重复问“在吗”，不催促，不提定时器或主动判断。不输出代发动作。`;
      const result=await this.runModel(engine,attempt.id,prompt,'low','outreach',{contextManaged:true,inputText:'[主动聊天考虑]'});
      if(attempt.cancelled||generation!==this.generation||epoch!==this.chatEpoch||this.outreachPaused||outreachGate(this.config,this.outreach.value,{now:this.now(),connected:this.onebot.connected,busy:false,privateMode:this.privateMode,ignoreSchedule:true})){engine.commitReply?.(attempt.id,'');return false;}
      if(!result||result.trim()==='[SILENT]'){this.telemetry.decision('模型选择保持安静',this.now());this.log('主动私聊判断：暂时保持安静');return false;}
      const reply=socialReply(result).text;
      let topicId;try{topicId=JSON.parse(result).topicId;}catch{}
      const repeat=this.outreach.value.history.some(v=>v.role==='assistant'&&String(v.content).replace(/\s/g,'')===reply.replace(/\s/g,''));
      const unavailableTopic=this.memory.room(key).topics.some(t=>!topics.some(v=>v.id===t.id)&&this.memory.matchesTopic(reply,t.text));
      if(repeat||unavailableTopic||topicId&&!topics.some(t=>t.id===topicId)){
        engine.commitReply?.(attempt.id,'');this.telemetry.decision('重复或未到续聊时间的话题，保持安静',this.now());return false;
      }
      const sent=await this.sendBubbles({type:'private',user:config.ownerQQ},reply,generation,2,()=>!attempt.cancelled&&epoch===this.chatEpoch&&!this.outreachPaused);
      engine.commitReply?.(attempt.id,sent);this.memory.replied(key,sent,this.now());
      if(sent&&generation===this.generation){
        if(topics.some(t=>t.id===topicId))this.memory.asked(key,[topicId],this.now());
        this.outreach.replied(sent,this.now(),{proactive:true,timezone:config.outreach.timezone});
        if(attempt.cancelled){this.outreach.value.awaitingReply=false;this.outreach.save();}
        this.telemetry.decision(attempt.cancelled?'收到新消息，已取消剩余主动气泡':'已主动发送，等待回复',this.now());this.log(attempt.cancelled?'主动气泡已取消，接着处理新消息':'主动私聊已发送，等待管理员回复');
      }
      return !!sent;
    }catch(error){if(!attempt.cancelled&&generation===this.generation)this.log(`主动私聊判断失败：${error.message}`);return false;}
    finally{this.busy.delete(key);if(this.outreachAttempt===attempt)this.outreachAttempt=null;}
  }
  declineRequest(engine,request) {
    const method=request.method;
    if(method.endsWith('requestApproval'))engine.respond(request.id,method.includes('permissions')?{permissions:{},scope:'turn'}:{decision:'decline'});
    else if(method==='item/tool/requestUserInput' || method==='tool/requestUserInput')engine.respond(request.id,{answers:{}});
    else if(method==='mcpServer/elicitation/request')engine.respond(request.id,{action:'decline',content:null});
    else engine.proc?.stdin.write(JSON.stringify({id:request.id,error:{code:-32601,message:'This bridge does not expose this operation'}})+'\n');
  }
  async handleRequest(request) {
    const ctx=this.workTargets.get(request.params?.threadId);
    const command=request.method==='item/commandExecution/requestApproval';
    const file=request.method==='item/fileChange/requestApproval';
    const question=['item/tool/requestUserInput','tool/requestUserInput'].includes(request.method);
    if(!ctx || !this.allowed(ctx.target) || ctx.generation!==this.generation || (!command && !file && !question))return this.declineRequest(this.work,request);
    const token=randomBytes(4).toString('hex');
    const pending={request,target:ctx.target,generation:ctx.generation,question,answers:{}};
    pending.timer=setTimeout(()=>{this.declineRequest(this.work,request);this.clearApproval(token);},300000);
    this.approvals.set(token,pending);
    let preview;
    if(question) {
      const qs=request.params.questions || [];pending.questions=qs;
      preview=qs.map((q,i)=>`${i+1}. ${q.question}\n${(q.options || []).map(o=>`· ${o.label}`).join('\n')}`).join('\n');
      await this.send(ctx.target,`需要你的回答（${token}）：\n${preview}\n按顺序发送 /answer ${token} 你的回答。`,ctx.generation);
    } else {
      preview=command?(request.params.command || JSON.stringify(request.params.commandActions || request.params.networkApprovalContext || {})):
        `文件改动：${request.params.reason || ''}\n目录：${request.params.grantRoot || ''}`;
      await this.send(ctx.target,`一次操作需要审批（${token}）：\n${preview}\n${request.params.reason || ''}\n/approve ${token} 同意这一次\n/deny ${token} 拒绝\n5 分钟未回复自动拒绝。`,ctx.generation);
    }
  }
  clearApproval(token){const p=this.approvals.get(token);if(p)clearTimeout(p.timer);this.approvals.delete(token);}
  async answerApproval(msg,command,parts) {
    const [token,...answer]=parts;const p=this.approvals.get(token);
    if(!p || p.target.user!==msg.user || p.generation!==this.generation || !this.work.turns.has(p.request.params.threadId))return this.send(msg,'没有这个待处理请求，或它已经结束。');
    if(command==='/answer') {
      if(!p.question || !answer.length)return this.send(msg,'请使用 /answer 编号 回答内容');
      const q=p.questions[Object.keys(p.answers).length];if(!q)return;
      p.answers[q.id]={answers:[answer.join(' ')]};
      if(Object.keys(p.answers).length<p.questions.length)return this.send(msg,`已记录。请继续 /answer ${token} 回答下一题：${p.questions[Object.keys(p.answers).length].question}`);
      this.work.respond(p.request.id,{answers:p.answers});
    } else {
      if(p.question)return this.send(msg,'这是一个问题，请使用 /answer 编号 回答内容');
      this.work.respond(p.request.id,{decision:command==='/approve'?'accept':'decline'});
    }
    this.clearApproval(token);return this.send(msg,'已提交你的答复。');
  }
  stop(){this.configure({...this.config,enabled:false});}
}
