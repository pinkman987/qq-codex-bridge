import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function findSnowlumaDb(home=process.env.USERPROFILE||process.env.HOME,configuredPath=''){
  if(configuredPath){
    if(fs.existsSync(configuredPath)&&fs.statSync(configuredPath).isFile())return configuredPath;
    throw new Error('配置的 SnowLuma 消息库不存在，请在账号连接中更新 messages.db 路径');
  }
  if(!home)return null;
  const desktops=[path.join(home,'Desktop'),path.join(home,'OneDrive','Desktop'),...(process.env.OneDrive?[path.join(process.env.OneDrive,'Desktop')]:[])];
  const found=new Set();
  // Bounded discovery: direct Desktop installs and one parent folder only.
  const entries=dir=>{try{return fs.readdirSync(dir,{withFileTypes:true}).filter(v=>v.isDirectory()&&!v.isSymbolicLink());}catch{return [];}};
  for(const desktop of new Set(desktops)){
    for(const top of entries(desktop)){
      const dir=path.join(desktop,top.name);
      const installs=/^SnowLuma/i.test(top.name)?[dir]:entries(dir).filter(v=>/^SnowLuma/i.test(v.name)).map(v=>path.join(dir,v.name));
      for(const install of installs)for(const user of entries(path.join(install,'data'))){
        const file=path.join(install,'data',user.name,'messages.db');
        if(fs.existsSync(file)&&fs.statSync(file).isFile())found.add(fs.realpathSync(file));
      }
    }
  }
  if(found.size>1)throw new Error('发现多个 SnowLuma 消息库，请在账号连接中指定机器人账号的 messages.db 路径');
  return [...found][0]||null;
}

export function extractChatLog(dbFile,{selfId,sessionId,limit=null}={}){
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try{
    const params=[];
    const where=sessionId?(params.push(Number(sessionId)),'where session_id=?'):'';
    const limited=Number.isInteger(limit)&&limit>0;
    if(limited)params.push(limit);
    const rows=db.prepare(`select data from messages ${where} order by timestamp desc, sequence desc${limited?' limit ?':''}`).all(...params);
    const lines=[];
    for(const row of rows.reverse()){
      let event;try{event=JSON.parse(row.data);}catch{continue;}
      if(event.post_type!=='message'&&event.post_type!=='message_sent')continue;
      const text=(Array.isArray(event.message)?event.message:[]).filter(seg=>seg?.type==='text').map(seg=>String(seg.data?.text||'')).join('').trim();
      if(!text||/^\[CQ:/.test(text))continue;
      const isBot=event.post_type==='message_sent'||(selfId&&String(event.user_id)===String(selfId));
      const who=isBot?'机器人':(event.sender?.card||event.sender?.nickname||String(event.user_id||'?'));
      lines.push(`${who}：${text.slice(0,200)}`);
    }
    return lines;
  }finally{db.close();}
}

export function listSessions(dbFile){
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try{
    return db.prepare("select session_id,is_group,count(*) n,min(timestamp) first,max(timestamp) last from messages group by session_id,is_group order by last desc limit 20").all();
  }finally{db.close();}
}

const WECHAT_TS=/^\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}$|^(昨天|前天|星期一|星期二|星期三|星期四|星期五|星期六|星期日|周[一二三四五六日天])\s+\d{1,2}:\d{2}$|^\d{1,2}:\d{2}$/;
function parseCsvLine(line){
  const out=[];let cur='',inQuotes=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(inQuotes){
      if(ch==='"'){if(line[i+1]==='"'){cur+='"';i++;}else inQuotes=false;}
      else cur+=ch;
    }else if(ch==='"')inQuotes=true;
    else if(ch===','){out.push(cur);cur='';}
    else cur+=ch;
  }
  out.push(cur);return out;
}
export function parseStructuredLog(text){
  const trimmed=String(text||'').trim();
  if(!trimmed)return null;
  if(trimmed.startsWith('[')||trimmed.startsWith('{')){
    let data=null;
    try{data=JSON.parse(trimmed);}catch{
      if(trimmed.startsWith('{')){
        const rows=[];
        for(const line of trimmed.split(/\r?\n/)){
          const one=line.trim();if(!one)continue;
          try{const parsed=JSON.parse(one);if(parsed&&typeof parsed==='object')rows.push(parsed);}catch{if(rows.length)break;}
        }
        if(rows.length)data=rows;
      }
      if(!data)return null;
    }
    const senders=Array.isArray(data?.senders)?data.senders:null;
    const rows=Array.isArray(data)?data:Array.isArray(data?.messages)?data.messages:null;
    if(!rows||!rows.length||typeof rows[0]!=='object')return null;
    const session=data?.session;
    const sessionName=session?String(session.remark||session.displayName||session.nickname||''):'';
    const selfRow=rows.find(row=>row.isSend===1||row.isSend===true||row.is_self||row.self||row.mine);
    const selfUsername=selfRow?String(selfRow.senderUsername||selfRow.sender_wxid||selfRow.wxid||''):'';
    const lines=[];
    for(const row of rows){
      const content=String(row.content??row.text??row.msg??row.message??row.Content??row.c??'').trim();
      if(!content)continue;
      let sender;
      if(row.is_self||row.self||row.mine||row.isSend===1||row.isSend===true||row.is_sender===1||(selfUsername&&String(row.senderUsername||row.sender_wxid||row.wxid||'')===selfUsername))sender='我';
      else{
        const index=row.s??row.sender_idx;
        if(senders&&Number.isInteger(index)){const entry=senders[index];sender=entry&&typeof entry==='object'?String(entry.name||entry.nickname||entry.displayName||'?'):String(entry??'?');}
        else{
          const raw=row.senderDisplayName??row.sender_display_name??row.sender_name??row.senderName??row.sender??row.nickname??row.nickName??row.nick??row.from??row.talker??row.sender_wxid??row.wxid??row.role;
          const named=raw&&typeof raw==='object'?String(raw.name||raw.nickname||raw.displayName||''):String(raw??'');
          sender=(named&&named!=='?')?named:(sessionName||'?');
        }
      }
      lines.push(`${sender}：${content.slice(0,200)}`);
    }
    return lines.length?lines:null;
  }
  const [headerLine,...rest]=trimmed.split(/\r?\n/);
  if(!headerLine||!headerLine.includes(','))return null;
  const header=parseCsvLine(headerLine).map(cell=>cell.trim().toLowerCase());
  const senderIdx=header.findIndex(cell=>/昵称|sender|nickname|^name$/.test(cell));
  const contentIdx=header.findIndex(cell=>/内容|content|^msg$|^text$|message/.test(cell));
  if(senderIdx<0||contentIdx<0)return null;
  const lines=[];
  for(const line of rest){
    if(!line.trim())continue;
    const cells=parseCsvLine(line);
    const content=String(cells[contentIdx]||'').trim();
    if(!content)continue;
    lines.push(`${String(cells[senderIdx]||'?').trim()}：${content.slice(0,200)}`);
  }
  return lines.length?lines:null;
}

const WECHAT_DATE_LOOSE=/^\d{4}年/;
const WECHAT_JUNK=/^(的)?聊天记录$|^.{0,12}的聊天记录$|^─+$|^─+$/;
export function normalizePastedLog(text){
  const rawLines=String(text||'').split(/\r?\n/).map(line=>line.trim());
  if(!rawLines.some(line=>WECHAT_TS.test(line)||WECHAT_DATE_LOOSE.test(line)))return rawLines.filter(Boolean);
  const lines=[];let name='';
  for(const line of rawLines){
    if(!line||WECHAT_JUNK.test(line)||WECHAT_TS.test(line)||WECHAT_DATE_LOOSE.test(line))continue;
    if(line.includes('：')&&line.indexOf('：')<=12&&!name){lines.push(line);continue;}
    if(!name){name=line;continue;}
    lines.push(`${name}：${line}`);name='';
  }
  return lines;
}

export function linesFromBubbles(ocrLines,{selfSide='right',otherName='对方'}={}){
  const messages=[];let pending=null;
  const flush=()=>{if(pending)messages.push(pending);pending=null;};
  for(const item of ocrLines){
    const text=item?.text?.trim();
    if(!text)continue;
    if(WECHAT_JUNK.test(text)||WECHAT_TS.test(text)||WECHAT_DATE_LOOSE.test(text)){flush();continue;}
    const geometry=Number.isFinite(item.y)&&Number.isFinite(item.height)&&item.height>0;
    const sameBlock=geometry&&pending?.geometry&&item.y-(pending.lastY+pending.lastHeight)<=Math.max(item.height,pending.lastHeight)*.85;
    const aligned=sameBlock&&Number.isFinite(item.x)&&Math.abs(item.x-pending.x)<=Math.max(12,(item.imageWidth||1080)*.025);
    // Wrapped short lines may have a different center; preserve their aligned bubble's side.
    const side=aligned?pending.side:item.ratio>=0.5?'right':'left';
    if(pending&&pending.side===side&&(!geometry||!pending.geometry||sameBlock)){
      pending.text+=text;pending.lastY=item.y;pending.lastHeight=item.height;continue;
    }
    flush();pending={side,text,geometry,x:item.x,lastY:item.y,lastHeight:item.height};
  }
  flush();
  return messages.map(item=>`${item.side===selfSide?'我':otherName}：${item.text}`);
}

export function distillPrompt(lines,targets=[],background=''){
  const focus=targets.length?`只分析这些昵称的说话风格：${targets.join('、')}；其他昵称的内容只作为对话上下文参考，不要把他们的风格总结进规则。\n`:'';
  const bg=background?`管理员提供的背景信息（视为事实，可直接引用）：\n${background}\n提炼回忆与示例时结合这些背景，不要与它矛盾。\n`:'';
  return `${focus}${bg}下面是真实聊天记录摘录，格式为「昵称：内容」，其中「机器人」是机器人自己说的话，分析时只看其他人的说话方式。
请提炼这些人的聊天风格：口头禅、常用句式、句长与节奏、标点与表情习惯、称呼方式、接话与反应方式。
注意：记录可能来自截图 OCR，含个别识别错字（如行首孤立单字或数字、残缺字、同音错字）。只有当同一习惯在多条不同记录里反复出现时才可总结为规则；单个错字、乱码或疑似识别错误绝不可写成风格规则或示例。示例发言必须是通顺自然的中文，不得以孤立单字或数字开头。
输出要求：
1. 先输出 6–10 条风格规则，每行一条，每条不超过 40 字，用第二人称「你」写成可直接执行的指令；
2. 再输出一行 [示例]，其后 5–8 行模仿该风格的示例发言，每行不超过 20 字；
3. 再输出一行 [回忆]，其后最多 20 行从记录里提取的共同回忆与共识（只能来自聊天记录或 M: 观察，禁止编造或润饰其中不存在的情节；宁少勿假）：一起经历过的事（尽量带时间或地点）、只有你们懂的梗和外号、重要的人和物、彼此的约定与喜好，每行不超过 40 字，写成「你」也亲历过的记忆（如「三月俩人去青岛玩被雨淋透」）；记录里没有就只输出 [回忆] 一行。
只输出以上内容，不要解释，不要输出聊天记录原文。

聊天记录：
${lines.join('\n')}`;
}

export function chunkLines(lines,size=100){const out=[];for(let i=0;i<lines.length;i+=size)out.push(lines.slice(i,i+size));return out;}
export function flattenChatRecords(lines){return lines.map(line=>String(line).replace(/\r\n|[\n\r\u2028\u2029]/g,' ').trim().slice(0,300));}
export function observationPrompt(chunk,targets=[],background=''){
  const focus=targets.length?`只分析这些昵称的说话方式：${targets.join('、')}；其他人的内容只作上下文参考。\n`:'';
  const bg=background?`管理员提供的背景信息（视为事实）：${background}\n`:'';
  return `${focus}${bg}下面是真实聊天记录摘录（可能来自截图 OCR，含个别识别错字；孤立错字、乱码一律忽略）。请提取原始观察，只用两种前缀行：
S: 风格观察（口头禅、常用句式、句长与节奏、接话与反应、称呼方式；一行一条，每条不超过 40 字；只记在多条不同记录里反复出现的习惯）；
M: 回忆候选（一起经历过的事、只有你们懂的梗和外号、重要的人和物、约定与喜好；一行一条，每条不超过 40 字，写成「你」也亲历过的记忆；每条必须能从记录原文直接指认出处，禁止编造记录里没有的情节、时间或地点，拿不准的就不要写）。
只输出 S: 或 M: 开头的行；没有就什么都不输出。不要解释，不要输出聊天记录原文。

聊天记录：
${chunk.join('\n')}`;
}
export function synthesizePrompt(observations,targets=[],background=''){
  const focus=targets.length?`只总结这些昵称的风格：${targets.join('、')}。\n`:'';
  const bg=background?`管理员提供的背景信息（视为事实）：${background}\n`:'';
  return `${focus}${bg}下面是从同一个人的聊天记录里分批提取的原始观察（S: 风格，M: 回忆；可能重复、矛盾或混入识别错字）。请合并为最终人设素材：
1. 先输出 6–10 条风格规则，每行一条，每条不超过 40 字，用第二人称「你」写成可直接执行的指令；合并同义项，丢弃明显错字、乱码或只出现过一次的怪癖；
2. 再输出一行 [示例]，其后 5–8 行模仿该风格的示例发言，每行不超过 20 字，通顺自然的中文，不得以孤立单字或数字开头；
3. 再输出一行 [回忆]，其后最多 20 行合并后的共同回忆，每行不超过 40 字；没有就只输出 [回忆] 一行。
只输出以上内容，不要解释。

原始观察：
${observations.join('\n')}`;
}
export function mergeObservationsPrompt(observations,targets=[],background=''){
  const focus=targets.length?`只归并这些昵称的观察：${targets.join('、')}。\n`:'';
  const bg=background?`管理员背景信息：${background}\n`:'';
  return `${focus}${bg}请归并原始观察。这是大量聊天记录的中间分析阶段，不生成最终人设。\n检查下面的全部观察，合并同义风格与重复回忆，保留反复出现的习惯、重要经历以及分歧，丢弃明显 OCR 错字与乱码。不能因为条目靠后而忽略，不编造新事实。\n只输出 S: 风格观察 或 M: 回忆候选 开头的行，合计最多 60 行，每行不超过 100 字。没有依据的内容不要输出。\n\n原始观察：\n${observations.join('\n')}`;
}
export function notesToPersona(notes){
  const block=notes.trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  return `\n【从真实聊天记录蒸馏的风格】\n${block.join('\n')}`;
}
