export function legacyProvider(chat,hasKey=false){
  if(!chat?.model&&!hasKey&&!chat?.apiKey)return [];
  return [{id:'legacy',name:'已有模型服务',enabled:true,baseUrl:chat.baseUrl,protocol:chat.protocol||'auto',apiKey:chat.apiKey||'',models:chat.model?[chat.model]:[],model:chat.model||''}];
}
export function validateProviders(profiles){
  const fail=(p,field,message)=>{const error=new Error(message);error.field=field;error.providerId=p?.id;throw error;};
  if(!Array.isArray(profiles)||profiles.length>30)fail(null,'providerName','供应商列表格式不正确，最多保存30个。');
  const ids=new Set();
  return profiles.map(p=>{
    if(!p||typeof p!=='object'||typeof p.id!=='string'||p.id==='codex'||!/^[a-zA-Z0-9_-]{1,64}$/.test(p.id)||ids.has(p.id))fail(p,'providerName','供应商标识无效或重复。');
    ids.add(p.id);
    if(typeof p.name!=='string'||!p.name.trim()||p.name.trim().length>40)fail(p,'providerName','供应商名称须为1–40个字符。');
    if(typeof p.enabled!=='boolean')fail(p,'providerEnabled','供应商启用状态不正确。');
    if(!['auto','openai','anthropic'].includes(p.protocol))fail(p,'apiProtocol','请选择支持的 API 格式。');
    let url;try{url=new URL(p.baseUrl);}catch{fail(p,'apiBase','请填写有效的供应商地址。');}
    const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||(url.protocol==='http:'&&!local))fail(p,'apiBase','供应商使用 HTTPS；本机可用 HTTP，地址不能含凭证或查询参数。');
    if(typeof p.apiKey!=='string'||p.apiKey.length>4096||/[\r\n]/.test(p.apiKey))fail(p,'apiKey','API Key 格式不正确。');
    if(!Array.isArray(p.models)||p.models.length>50||p.models.some(m=>typeof m!=='string'||!m.trim()||m.trim().length>120)||new Set(p.models.map(m=>m.trim())).size!==p.models.length)fail(p,'providerModels','模型列表须为不重复的模型 ID，最多50个，每项最多120字符。');
    const models=p.models.map(m=>m.trim());
    if(typeof p.model!=='string'||p.model&&!models.includes(p.model.trim()))fail(p,'apiModel','当前模型必须在该供应商的模型列表中。');
    return {id:p.id,name:p.name.trim(),enabled:p.enabled,baseUrl:String(p.baseUrl).trim().replace(/\/+$/,''),protocol:p.protocol,apiKey:p.apiKey.trim(),models,model:p.model.trim()};
  });
}
