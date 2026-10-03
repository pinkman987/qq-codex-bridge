import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const STATE = path.join(ROOT, 'state');


export const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
export function validateConfig(input, previous = defaults) {
  const fail=(field,message)=>{const error=new Error(message);error.field=field;throw error;};
  const cfg = { ...structuredClone(previous), ...input,
    onebot: { ...previous.onebot, ...input.onebot }, social: { ...previous.social, ...input.social },
    chat: { ...defaults.chat, ...previous.chat, ...input.chat },
    voice: { ...defaults.voice, ...previous.voice, ...input.voice },
    outreach: { ...defaults.outreach, ...previous.outreach, ...input.outreach } };
  if (typeof cfg.enabled !== 'boolean') fail('enabled','启用 QQ 桥接必须是开关值');
  cfg.ownerQQ = String(cfg.ownerQQ || '').trim();
  if (cfg.ownerQQ && !/^\d{5,15}$/.test(cfg.ownerQQ)) fail('owner','管理员 QQ 号格式不正确，应为 5–15 位数字');
  if (cfg.enabled && !cfg.ownerQQ) fail('owner','启用前请填写管理员 QQ 号');
  if (!Array.isArray(cfg.groups)) fail('groups','群号必须是数组');
  cfg.groups = [...new Set(cfg.groups.map(String))];
  if (cfg.groups.some(id => !/^\d{5,15}$/.test(id))) fail('groups','群号格式不正确，应为 5–15 位数字');
  let url;try{url = new URL(cfg.onebot.wsUrl);}catch{fail('ws','OneBot 地址格式不正确，例如 ws://127.0.0.1:3001/');}
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) fail('ws','OneBot 必须使用本机 ws:// 地址');
  if (typeof cfg.onebot.accessToken !== 'string' || /[\r\n]/.test(cfg.onebot.accessToken)) fail('onebotToken','连接令牌格式不正确');
  if (typeof cfg.model !== 'string' || cfg.model.length > 120) fail('model','模型名称最多 120 个字符');
  cfg.snowlumaDbPath=String(cfg.snowlumaDbPath ?? '').trim();
  if(cfg.snowlumaDbPath && (!path.isAbsolute(cfg.snowlumaDbPath) || !fs.existsSync(cfg.snowlumaDbPath) || !fs.statSync(cfg.snowlumaDbPath).isFile() || path.basename(cfg.snowlumaDbPath).toLowerCase()!=='messages.db'))
    fail('snowlumaDbPath','消息库请填写已存在的 messages.db 文件的绝对路径；不使用消息库可留空');
  if (!['codex','openai'].includes(cfg.chat.provider)) fail('chatProvider','请选择 Codex 或 OpenAI 兼容接口');
  if (typeof cfg.chat.baseUrl !== 'string') fail('apiBase','模型服务地址格式不正确');
  cfg.chat.baseUrl=cfg.chat.baseUrl.trim().replace(/\/+$/,'');
  let apiUrl;try{apiUrl=new URL(cfg.chat.baseUrl);}catch{fail('apiBase','请填写模型服务地址，例如 https://api.openai.com/v1');}
  if ((!['https:','http:'].includes(apiUrl.protocol)) || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash ||
    (apiUrl.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(apiUrl.hostname))) fail('apiBase','模型服务使用 HTTPS；本机服务可使用 http://127.0.0.1 地址，地址不能带密钥或查询参数');
  if (typeof cfg.chat.apiKey !== 'string' || cfg.chat.apiKey.length>4096 || /[\r\n]/.test(cfg.chat.apiKey)) fail('apiKey','API Key 格式不正确');
  if (typeof cfg.chat.model !== 'string' || cfg.chat.model.length>120) fail('apiModel','模型名称最多 120 个字符');
  cfg.chat.model=cfg.chat.model.trim();
  if(cfg.chat.provider==='openai'&&!cfg.chat.model)fail('apiModel','使用兼容接口时必须填写模型名称');
  if(cfg.chat.provider==='openai'&&!cfg.chat.apiKey&& !['127.0.0.1','localhost','[::1]'].includes(apiUrl.hostname))fail('apiKey','请填写该服务的 API Key；本机模型可留空');
  if(typeof cfg.voice.enabled!=='boolean')fail('voiceEnabled','语音识别必须是开关值');
  cfg.voice.mode??='transcribe';
  if(!['transcribe','omni'].includes(cfg.voice.mode))fail('voiceMode','请选择语音转写或 Omni 原生聊天');
  if(typeof cfg.voice.baseUrl!=='string')fail('voiceBase','语音识别服务地址格式不正确');
  cfg.voice.baseUrl=cfg.voice.baseUrl.trim().replace(/\/+$/,'');
  let voiceUrl;try{voiceUrl=new URL(cfg.voice.baseUrl);}catch{fail('voiceBase','请填写有效的语音识别服务地址');}
  const localVoice=['127.0.0.1','localhost','[::1]'].includes(voiceUrl.hostname);
  if(!['https:','http:'].includes(voiceUrl.protocol)||voiceUrl.username||voiceUrl.password||voiceUrl.search||voiceUrl.hash||(voiceUrl.protocol==='http:'&&!localVoice))fail('voiceBase','语音识别使用 HTTPS；本机服务可使用 HTTP，地址不能带密钥');
  if(typeof cfg.voice.model!=='string'||cfg.voice.model.length>120)fail('voiceModel','语音模型名称最多120字符');
  cfg.voice.model=cfg.voice.model.trim();
  if(cfg.voice.mode==='omni'&&cfg.voice.enabled&&!/^qwen3\.8-omni-flash(?:-[\w-]+)?$/.test(cfg.voice.model))fail('voiceModel','原生 Omni 模式请使用 qwen3.8-omni-flash 或对应快照，不支持 realtime 型号');
  if(cfg.voice.mode==='omni'&&/realtime/.test(cfg.voice.model))fail('voiceModel','实时语音模型使用另一种协议，请填写 qwen3.8-omni-flash');
  if(typeof cfg.voice.apiKey!=='string'||cfg.voice.apiKey.length>4096||/[\r\n]/.test(cfg.voice.apiKey))fail('voiceKey','语音 API Key 格式不正确');
  if(cfg.voice.enabled&&!cfg.voice.model)fail('voiceModel','开启语音识别前请填写模型名称');
  if(cfg.voice.enabled&&!localVoice&&!cfg.voice.apiKey)fail('voiceKey','开启语音识别前请填写该服务的 API Key');
  for(const [key,field,min,max]of [['memoryTurns','memoryTurns',1,30],['contextChars','contextChars',2000,20000],['mergeDelayMs','mergeDelayMs',0,5000],['mergeMaxWaitMs','mergeMaxWaitMs',100,10000]]){
    cfg.social[key]??=defaults.social[key];
    if(!Number.isInteger(cfg.social[key])||cfg.social[key]<min||cfg.social[key]>max)fail(field,`${field} 必须为 ${min}–${max} 的整数`);
  }
  if(cfg.social.mergeMaxWaitMs<cfg.social.mergeDelayMs)fail('mergeMaxWaitMs','最长聚合等待必须大于或等于聚合窗口');
  if (typeof cfg.persona !== 'string' || cfg.persona.length > 6000) fail('persona','人设最多 6000 字符');
  if (typeof cfg.basePersona !== 'string' || cfg.basePersona.length > 6000) fail('basePersona','基础规则必须是 6000 字符内的文本');
  if (typeof cfg.social.proactive !== 'boolean') fail('proactive','插话开关格式不正确');
  if(typeof cfg.outreach.enabled!=='boolean')fail('outreachEnabled','主动私聊必须是开关值');
  for(const [key,field,min,max,label]of [['startHour','outreachStart',0,23,'开始时间'],['endHour','outreachEnd',1,24,'结束时间'],['idleMinutes','outreachIdle',30,10080,'安静时长'],['checkMinutes','outreachCheck',15,1440,'考虑间隔'],['maxPerDay','outreachMax',1,10,'每日主动消息上限']]){
    if(!Number.isInteger(cfg.outreach[key])||cfg.outreach[key]<min||cfg.outreach[key]>max)fail(field,`${label}必须是 ${min}–${max} 之间的整数`);
  }
  if(cfg.outreach.startHour>=cfg.outreach.endHour)fail('outreachEnd','结束时间必须晚于开始时间，活动时段不能跨天');
  if(cfg.outreach.timezone!=='Asia/Shanghai')fail('outreachStart','活动时段使用北京时间');
  const rangeFields={probability:['probability','插话概率必须在 0%–50% 之间'],cooldownSeconds:['cooldown','插话间隔必须在 30–86400 秒之间'],maxRepliesPerHour:['hourly','每群每小时 AI 调用上限必须在 1–100 之间'],contextMessages:['persona','聊天上下文条数必须在 1–50 之间']};
  for (const [key, min, max] of [['probability',0,0.5],['cooldownSeconds',30,86400],['maxRepliesPerHour',1,100],['contextMessages',1,50]]) {
    if (typeof cfg.social[key] !== 'number' || !Number.isFinite(cfg.social[key]) || cfg.social[key] < min || cfg.social[key] > max) fail(...rangeFields[key]);
    if (key !== 'probability' && !Number.isInteger(cfg.social[key])) fail(rangeFields[key][0],rangeFields[key][1]+'，并且为整数');
  }
  if (!Number.isInteger(cfg.consolePort) || cfg.consolePort < 1024 || cfg.consolePort > 65535) throw new Error('控制台端口格式不正确');
  if (!cfg.projects || typeof cfg.projects !== 'object' || Array.isArray(cfg.projects)) fail('projects','项目配置格式不正确');
  for (const [name, dir] of Object.entries(cfg.projects)) {
    if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)) fail('projects','项目名只支持中文、字母、数字、下划线和短横线');
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail('projects',`项目 ${name} 必须指向已存在的绝对目录`);
    cfg.projects[name] = fs.realpathSync(dir);
  }
  return cfg;
}
export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
export function loadConfig() {
  fs.mkdirSync(STATE, { recursive: true });
  const file = path.join(ROOT, 'config.json');
  let input=defaults;
  if(fs.existsSync(file)){
    try{input=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
    catch{throw new Error('config.json 无法读取或 JSON 格式损坏。请备份原文件后修正 JSON；程序不会覆盖你的配置。');}
  }
  return validateConfig(input);
}
