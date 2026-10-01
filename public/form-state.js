export class FieldError extends Error {
  constructor(field,message){super(message);this.field=field;}
}
export function configToDraft(config){
  return {owner:config.ownerQQ,groups:config.groups.join(', '),ws:config.onebot.wsUrl,onebotToken:'',model:config.model,snowlumaDbPath:config.snowlumaDbPath||'',
    chatProvider:config.chat?.provider||'codex',apiBase:config.chat?.baseUrl||'https://api.openai.com/v1',apiModel:config.chat?.model||'',apiKey:'',clearApiKey:false,
    outreachEnabled:config.outreach?.enabled||false,outreachStart:String(config.outreach?.startHour??10),outreachEnd:String(config.outreach?.endHour??22),outreachIdle:String(config.outreach?.idleMinutes??120),outreachCheck:String(config.outreach?.checkMinutes??60),outreachMax:String(config.outreach?.maxPerDay??2),
    basePersona:config.basePersona||'',projects:Object.entries(config.projects).map(([name,dir])=>`${name}=${dir}`).join('\n'),persona:config.persona,
    proactive:config.social.proactive,probability:String(Math.round(config.social.probability*100)),
    cooldown:String(config.social.cooldownSeconds),hourly:String(config.social.maxRepliesPerHour),enabled:config.enabled};
}
export function buildConfig(draft,current,hasToken,hasApiKey=false){
  const fail=(field,message)=>{throw new FieldError(field,message);};
  const owner=draft.owner.trim();
  if(draft.enabled&&!owner)fail('owner','启用桥接前，请填写管理员 QQ 号。');
  if(owner&&!/^\d{5,15}$/.test(owner))fail('owner','管理员 QQ 号应为 5–15 位数字。');
  const groups=[...new Set(draft.groups.trim().split(/[,，\s]+/).filter(Boolean))];
  if(groups.some(id=>!/^\d{5,15}$/.test(id)))fail('groups','群号应为 5–15 位数字，多个群号用逗号或空格分隔。');
  const ws=draft.ws.trim();let url;
  try{url=new URL(ws);}catch{fail('ws','请填写有效地址，例如 ws://127.0.0.1:3001/。');}
  if(url.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)fail('ws','OneBot 地址必须是本机 ws:// 地址。');
  if(/[\r\n]/.test(draft.onebotToken))fail('onebotToken','连接令牌不能包含换行。');
  const model=draft.model.trim();if(model.length>120)fail('model','模型名称最多 120 个字符。');
  if(!['codex','openai'].includes(draft.chatProvider))fail('chatProvider','请选择聊天模型来源。');
  const baseUrl=draft.apiBase.trim().replace(/\/+$/,'');let apiUrl;
  try{apiUrl=new URL(baseUrl);}catch{fail('apiBase','请填写有效的模型服务地址。');}
  const local=['127.0.0.1','localhost','[::1]'].includes(apiUrl.hostname);
  if(!['http:','https:'].includes(apiUrl.protocol)||apiUrl.username||apiUrl.password||apiUrl.search||apiUrl.hash||(apiUrl.protocol==='http:'&&!local))fail('apiBase','使用 HTTPS 地址；本机模型可用 HTTP，地址不能带密钥或查询参数。');
  const apiModel=draft.apiModel.trim();if(apiModel.length>120)fail('apiModel','模型名称最多 120 个字符。');
  if(draft.chatProvider==='openai'&&!apiModel)fail('apiModel','请填写服务商提供的模型名称。');
  if(/[\r\n]/.test(draft.apiKey)||draft.apiKey.length>4096)fail('apiKey','API Key 格式不正确。');
  const sameOrigin=!current.chat?.baseUrl||new URL(current.chat.baseUrl).origin===apiUrl.origin;
  if(hasApiKey&&!sameOrigin&&!draft.apiKey&&!draft.clearApiKey)fail('apiKey','更换模型服务后，请重新填写该服务的 API Key。');
  const apiKey=draft.apiKey.trim()||(!draft.clearApiKey&&hasApiKey&&sameOrigin?'__KEEP__':'');
  if(draft.chatProvider==='openai'&&!apiKey&&!local)fail('apiKey','请填写该服务的 API Key；本机模型可留空。');
  if(draft.persona.length>6000)fail('persona','群聊人设最多 6000 个字符。');
  const number=(field,min,max,label)=>{const value=String(draft[field]).trim();const parsed=Number(value);
    if(!value||!Number.isInteger(parsed)||parsed<min||parsed>max)fail(field,`${label}必须填写 ${min}–${max} 之间的整数。`);return parsed;};
  const probability=number('probability',0,50,'插话概率');
  const cooldownSeconds=number('cooldown',30,86400,'插话间隔');
  const maxRepliesPerHour=number('hourly',1,100,'每小时 AI 调用上限');
  const startHour=number('outreachStart',0,23,'活动开始时间'),endHour=number('outreachEnd',1,24,'活动结束时间');
  if(endHour<=startHour)fail('outreachEnd','结束时间必须晚于开始时间，活动时段不能跨天。');
  const idleMinutes=number('outreachIdle',30,10080,'安静时长'),checkMinutes=number('outreachCheck',15,1440,'考虑间隔'),maxPerDay=number('outreachMax',1,10,'每日主动消息上限');
  const projects=Object.create(null);
  for(const [index,line]of draft.projects.split(/\r?\n/).entries()){
    if(!line.trim())continue;const separator=line.indexOf('=');
    if(separator<1)fail('projects',`项目第 ${index+1} 行格式不对，请填写「项目名=文件夹绝对路径」。`);
    const name=line.slice(0,separator).trim(),dir=line.slice(separator+1).trim();
    if(!/^[\p{L}\p{N}_-]{1,32}$/u.test(name))fail('projects',`项目第 ${index+1} 行：名称只支持中文、字母、数字、下划线和短横线。`);
    if(Object.hasOwn(projects,name))fail('projects',`项目第 ${index+1} 行：名称「${name}」重复。`);
    if(!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(dir))fail('projects',`项目第 ${index+1} 行：请填写文件夹绝对路径。`);
    projects[name]=dir;
  }
  return {...current,ownerQQ:owner,groups,enabled:draft.enabled,model,persona:draft.persona,projects,snowlumaDbPath:(draft.snowlumaDbPath||'').trim(),
    basePersona:draft.basePersona,chat:{provider:draft.chatProvider,baseUrl,model:apiModel,apiKey,...(current.chat?.distillModel?{distillModel:current.chat.distillModel}:{})},
    outreach:{enabled:draft.outreachEnabled,startHour,endHour,idleMinutes,checkMinutes,maxPerDay,timezone:'Asia/Shanghai'},
    onebot:{wsUrl:ws,accessToken:draft.onebotToken||(hasToken?'__KEEP__':'')},
    social:{...current.social,proactive:draft.proactive,probability:probability/100,cooldownSeconds,maxRepliesPerHour}};
}
export function draftEqual(a,b){return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>a[key]===b[key]);}

export function reviewLines(text){return String(text||'').split(/\r\n|[\n\r\u2028\u2029]/).map(line=>line.trim()).filter(Boolean);}
export function validateReviewedLog(text){
  const lines=reviewLines(text);
  if(lines.length<10)throw new Error(`当前只有 ${lines.length} 条聊天记录，至少需要 10 条；每行表示一条消息。`);
  if(lines.some(line=>line.length>300))throw new Error('单条聊天记录不能超过 300 字');
  return lines;
}
