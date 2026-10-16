import {legacyProvider,validateProviders} from './provider-state.js';
export function createProviderEditor({$,onChange,confirm}){
  let profiles=[],selected='';
  const active=()=>profiles.find(p=>p.id===selected);
  const capture=()=>{const p=active();if(!p)return;p.name=$('providerName').value;p.baseUrl=$('apiBase').value;p.protocol=$('apiProtocol').value;p.enabled=$('providerEnabled').checked;p.apiKey=$('apiKey').value;p.clearKey=$('clearApiKey').checked;p.model=$('apiModel').value;};
  function keyState(){const p=active();$('apiKeyState').textContent=p?.hasKey?'该供应商密钥已保存':'尚未保存密钥';$('apiKey').placeholder=p?.hasKey?'已保存，留空保留该供应商的密钥':'填写该供应商的 API Key';$('providerKeyReveal').disabled=!$('apiKey').value;}
  function modelOptions(){const p=active();const models=p?.models.filter(m=>m.trim())||[];$('apiModel').replaceChildren(...(models.length?models.map(m=>new Option(m,m)):[new Option('请先添加模型','')]));$('apiModel').value=p?.model||models[0]||'';if(p)p.model=$('apiModel').value;}
  function renderModels(){const p=active();$('providerModels').replaceChildren();for(const [index,model] of (p?.models||[]).entries()){
    const row=document.createElement('div');row.className='provider-model-row';
    const input=document.createElement('input');input.value=model;input.maxLength=120;input.placeholder='服务商提供的模型 ID';input.setAttribute('aria-label',`模型 ${index+1} ID`);input.autocomplete='off';input.spellcheck=false;
    input.addEventListener('input',()=>{const old=p.models[index];p.models[index]=input.value;if(p.model===old)p.model=input.value;modelOptions();onChange();});
    const use=document.createElement('button');use.type='button';use.className='secondary';use.textContent='使用';use.setAttribute('aria-label',`使用模型 ${index+1}`);use.addEventListener('click',()=>{p.model=p.models[index];modelOptions();onChange();});
    const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='移除';remove.setAttribute('aria-label',`移除模型 ${index+1}`);remove.addEventListener('click',()=>{p.models.splice(index,1);if(!p.models.includes(p.model))p.model=p.models[0]||'';modelOptions();renderModels();onChange();});
    row.append(input,use,remove);$('providerModels').append(row);
  }}
  function renderList(){const list=$('providerList');list.replaceChildren();const add=(name,id,p)=>{const b=document.createElement('button');b.type='button';b.className='provider-item';b.dataset.enabled=p?String(p.enabled):'account';const label=document.createElement('span');label.textContent=name;const meta=document.createElement('small');meta.textContent=p?(p.enabled?'已启用':'已禁用'):'登录账户';b.append(label,meta);const chosen=id==='codex'?$('chatProvider').value==='codex':$('chatProvider').value==='openai'&&id===selected;b.classList.toggle('active',chosen);b.setAttribute('aria-pressed',String(chosen));b.addEventListener('click',()=>{capture();if(id==='codex')$('chatProvider').value='codex';else{selected=id;$('chatProvider').value='openai';fill();}renderList();onChange();});list.append(b);};add('Codex','codex');for(const p of profiles)add(p.name||'未命名供应商',p.id,p);}
  function fill(){const p=active();$('providerEmpty').hidden=!!p;$('providerEditorFields').hidden=!p;$('codexProviderNotice').hidden=$('chatProvider').value!=='codex';if(!p)return;
    $('providerName').value=p.name;$('providerEnabled').checked=p.enabled;$('apiBase').value=p.baseUrl;$('apiProtocol').value=p.protocol;$('apiKey').value=p.apiKey||'';$('apiKey').type='password';$('providerKeyReveal').textContent='显示';$('clearApiKey').checked=!!p.clearKey;modelOptions();renderModels();keyState();
  }
  for(const id of ['providerName','providerEnabled','apiProtocol'])$(id).addEventListener('input',()=>{capture();renderList();onChange();});
  $('apiKey').addEventListener('input',keyState);
  $('providerKeyReveal').addEventListener('click',()=>{const show=$('apiKey').type==='password';$('apiKey').type=show?'text':'password';$('providerKeyReveal').textContent=show?'隐藏':'显示';$('providerKeyReveal').setAttribute('aria-pressed',String(show));});
  $('providerAdd').addEventListener('click',()=>{capture();const p={id:'p_'+crypto.randomUUID().replaceAll('-',''),name:'新供应商',enabled:true,baseUrl:'https://api.openai.com/v1',protocol:'openai',apiKey:'',hasKey:false,models:[],model:''};profiles.push(p);selected=p.id;$('chatProvider').value='openai';fill();renderList();onChange();$('providerName').focus();});
  $('providerDelete').addEventListener('click',async()=>{const p=active();if(!p)return;if(!await confirm(`删除供应商「${p.name||'未命名'}」？保存后才会从配置中移除。`))return;profiles=profiles.filter(v=>v.id!==p.id);selected=profiles[0]?.id||'';$('chatProvider').value=selected?'openai':'codex';fill();renderList();onChange();});
  $('providerModelAdd').addEventListener('click',()=>{capture();const p=active();if(!p)return;p.models.push('');renderModels();onChange();$('providerModels').lastElementChild?.querySelector('input').focus();});
  return {
    load(config,flags={},hasRootKey=false){profiles=structuredClone(config.modelProviders??legacyProvider(config.chat,hasRootKey)).map(p=>({...p,apiKey:'',hasKey:flags[p.id]??(p.id==='legacy'&&hasRootKey),clearKey:false}));selected=config.chat.providerId||profiles[0]?.id||'';fill();renderList();},
    read(){capture();const p=active();return {providerProfiles:JSON.stringify(profiles.map(({hasKey,clearKey,...v})=>({...v,apiKey:v.apiKey.trim()||(!clearKey&&hasKey?'__KEEP__':'')}))),apiProviderId:p?.id||'',providerHasKey:!!p?.hasKey,apiProtocol:p?.protocol||'auto'};},
    validate(){const data=this.read();validateProviders(JSON.parse(data.providerProfiles));const p=active();if($('chatProvider').value==='openai'&&(!p||!p.enabled)){const e=new Error('请选择已启用的供应商。');e.field='providerEnabled';throw e;}},
    focus(id){if(profiles.some(p=>p.id===id)){capture();selected=id;$('chatProvider').value='openai';fill();renderList();}},
    refreshKeyState:keyState,
  };
}
