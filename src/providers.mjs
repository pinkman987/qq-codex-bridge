import {validateProviders,legacyProvider} from '../public/provider-state.js';
function fail(field,message,providerId){const error=new Error(message);error.field=field;error.providerId=providerId;throw error;}
export function resolveProviderCredentials(input,current){
  const previous=current.modelProviders||legacyProvider(current.chat,!!current.chat?.apiKey);
  if(input.modelProviders!==undefined){
    input.modelProviders=validateProviders(input.modelProviders).map(p=>{
      if(p.apiKey!=='__KEEP__')return p;
      const old=previous.find(v=>v.id===p.id);
      if(!old||new URL(old.baseUrl).origin!==new URL(p.baseUrl).origin)fail('apiKey','更换供应商地址后，请重新填写该供应商的 API Key。',p.id);
      return {...p,apiKey:old.apiKey};
    });
  }
  if(input.chat?.providerId){
    const profile=(input.modelProviders||previous).find(p=>p.id===input.chat.providerId);
    if(!profile)fail('apiModel','请选择已保存的供应商。',input.chat.providerId);
    if(input.chat.apiKey==='__KEEP__'){
      if(new URL(input.chat.baseUrl).origin!==new URL(profile.baseUrl).origin)fail('apiKey','更换供应商地址后，请重新填写 API Key。',profile.id);
      input.chat.apiKey=profile.apiKey;
    }
  }
  return input;
}
export function applySelectedProvider(cfg){
  if(cfg.modelProviders!==undefined)cfg.modelProviders=validateProviders(cfg.modelProviders);
  cfg.chat.protocol??='auto';
  if(!['auto','openai','anthropic'].includes(cfg.chat.protocol))fail('apiProtocol','请选择支持的 API 格式。');
  if(cfg.chat.provider==='openai'&&cfg.chat.providerId){
    const p=cfg.modelProviders?.find(p=>p.id===cfg.chat.providerId);
    if(!p||!p.enabled)fail('providerEnabled','请选择已启用的供应商。',cfg.chat.providerId);
    if(!p.models.includes(cfg.chat.model))fail('apiModel','请选择供应商模型列表中的模型。',p.id);
    cfg.chat={...cfg.chat,baseUrl:p.baseUrl,apiKey:p.apiKey,protocol:p.protocol};
  }
  return cfg;
}
export function providerKeyFlags(cfg){return Object.fromEntries((cfg.modelProviders||legacyProvider(cfg.chat,!!cfg.chat?.apiKey)).map(p=>[p.id,!!p.apiKey]));}
