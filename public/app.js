import {configToDraft,buildConfig,draftEqual,reviewLines,validateReviewedLog} from './form-state.js';
const $=id=>document.getElementById(id);
const viewMeta={"styleSettings":{"label":"聊天风格","eyebrow":"PERSONALITY"},"socialMemory":{"label":"记忆与话题","eyebrow":"MEMORY"},"distill":{"label":"记录蒸馏","eyebrow":"DISTILLATION"},"chatSettings":{"label":"聊天模型","eyebrow":"MODEL"},"outreachSettings":{"label":"主动聊天","eyebrow":"OUTREACH"},"connection":{"label":"账号连接","eyebrow":"CONNECTION"},"advanced":{"label":"工作空间","eyebrow":"WORKSPACE"},"metricsPanel":{"label":"运行统计","eyebrow":"ANALYTICS"}};
const viewCopy={styleSettings:['让每次聊天，都有自己的风格。','调整人设与聊天节奏，打造你喜欢的群聊伙伴。'],socialMemory:['记住重要的事，接着上次聊。','管理长期记忆和待续话题，让对话更有延续感。'],distill:['从真实对话里，找到说话的感觉。','导入记录、校对内容，再提炼成可编辑的风格规则。'],chatSettings:['选一个适合聊天的模型。','连接 Codex 或兼容接口，统一管理聊天模型与密钥。'],outreachSettings:['合适的时候，主动打个招呼。','设置活动时段和聊天频率，给主动聊天留一点分寸。'],connection:['连接账号，让机器人在线。','管理 QQ、群号与 OneBot 服务，随时查看连接状态。'],advanced:['把聊天与工作，安排得更顺手。','设置任务模型和项目目录，在 QQ 私聊里切换工作空间。'],metricsPanel:['每次响应，都有迹可循。','查看调用次数、响应速度和用量，了解机器人的运行表现。']};
let activeView='styleSettings';
function selectView(id,{scroll=true}={}){
  if(!viewMeta[id])return;
  activeView=id;
  document.querySelectorAll('#form > .panel').forEach(panel=>panel.classList.toggle('is-active',panel.id===id));
  const active=document.getElementById(id);
  if(active&&active.tagName==='DETAILS')active.open=true;
  document.querySelectorAll('[data-jump]').forEach(button=>{const selected=button.dataset.jump===id;button.classList.toggle('active',selected);if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  $('viewCrumb').textContent=viewMeta[id].label;$('viewEyebrow').textContent=viewMeta[id].eyebrow;
  [$('viewTitle').textContent,$('viewDescription').textContent]=viewCopy[id];
  const target=$(id);if(target.tagName==='DETAILS')target.open=true;
  if(scroll)window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
}
document.body.classList.add('enhanced');
selectView('styleSettings',{scroll:false});
document.querySelectorAll('[data-jump]').forEach(button=>button.addEventListener('click',()=>selectView(button.dataset.jump)));
document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();selectView('styleSettings');});
document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();$('form').setAttribute('tabindex','-1');$('form').focus();$('form').scrollIntoView({block:'start'});});
// Summaries stay natively clickable; selecting a view auto-opens its panel.
const fields=['snowlumaDbPath','owner','groups','ws','onebotToken','model','projects','basePersona','persona','proactive','probability','cooldown','hourly','enabled','chatProvider','apiBase','apiModel','apiKey','clearApiKey','outreachEnabled','outreachStart','outreachEnd','outreachIdle','outreachCheck','outreachMax','voiceMode','voiceEnabled','voiceBase','voiceModel','voiceKey','clearVoiceKey','memoryTurns','contextChars','mergeDelayMs','mergeMaxWaitMs'];
const toggles=new Set(['proactive','enabled','clearApiKey','outreachEnabled','voiceEnabled','clearVoiceKey']);
const token=location.hash.slice(1);
let current,revision,hasToken=false,savedDraft,dirty=false,saving=false,backendReady=false,lastStatus,lastSavedAt,refreshing=false,noticeKind='',saveFeedback=false;
let hasApiKey=false,hasVoiceKey=false,testing=false,backendUnlimitedRecords=false,backendCompanion=false,backendNativeOmni=false,baseDefault=null;
const readDraft=()=>Object.fromEntries(fields.map(id=>[id,toggles.has(id)?$(id).checked:$(id).value]));
function fillDraft(draft){for(const id of fields){if(toggles.has(id))$(id).checked=draft[id];else $(id).value=draft[id];}updateCounter();updateProvider();}
function updateProvider(){
  $('apiFields').hidden=$('chatProvider').value!=='openai';
  const omni=$('voiceMode').value==='omni';$('omniHint').hidden=!omni;$('testOmni').hidden=!omni;
  $('voiceProtocolHint').textContent=omni?'使用 /chat/completions 原生音频，模型填写 qwen3.8-omni-flash；不支持 realtime。':'语音转写需支持 /audio/transcriptions。';
  $('voiceLimits').textContent=omni?'开启后文字、图片及允许处理的语音会发给所填 Omni 服务。音频仅本轮上传；单文件最多7 MB，整轮媒体大小另有上限，模型请求最多120秒。需要 OneBot 导出 WAV/MP3；未@的群媒体不上传。费用由下方密钥所属账户承担。':'需要 OneBot 支持 get_record 及 WAV/MP3 转换。语音转写：单文件最多20 MiB、识别请求最多30秒。费用由下方密钥所属账户承担。';
}
function updateCounter(){$('personaCount').textContent=`${$('persona').value.length} / 6000`;}
function notify(message,kind='info'){$('notice').textContent=message;$('notice').className=`notice ${kind}`;$('notice').hidden=!message;noticeKind=kind;if(kind=='error')showModal('出错了',message,{kind:'error'});else if(kind=='warning')showModal('请注意',message,{kind:'warning'});}
let modalResolver=null,modalReturnFocus=null;
function showModal(title,message,{confirmLabel='知道了',cancelLabel=null,kind='info'}={}){return new Promise(resolve=>{if(modalResolver)modalResolver(false);modalReturnFocus=document.activeElement;$('modalTitle').textContent=title;$('modalMessage').textContent=message;$('modalCard').className=`modal-card ${kind}`;$('modalOk').textContent=confirmLabel;$('modalCancel').hidden=!cancelLabel;if(cancelLabel)$('modalCancel').textContent=cancelLabel;$('modalOverlay').hidden=false;$('modalOk').focus();modalResolver=resolve;});}
function closeModal(value){$('modalOverlay').hidden=true;const resolver=modalResolver;modalResolver=null;if(modalReturnFocus?.isConnected&&modalReturnFocus.getClientRects().length)modalReturnFocus.focus();modalReturnFocus=null;resolver?.(value);}
$('modalOk').addEventListener('click',()=>closeModal(true));
$('modalCancel').addEventListener('click',()=>closeModal(false));
$('modalOverlay').addEventListener('click',event=>{if(event.target===$('modalOverlay'))closeModal(false);});
$('modalOverlay').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeModal(false);}else if(event.key==='Tab'){event.preventDefault();const buttons=[$('modalCancel'),$('modalOk')].filter(button=>!button.hidden);const index=buttons.indexOf(document.activeElement);buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length].focus();}});
window.addEventListener('beforeunload',event=>{if(dirty&&!saving){event.preventDefault();event.returnValue='';}});
function clearErrors(){for(const id of fields){$(id).removeAttribute('aria-invalid');const error=$(id+'Error');if(error){error.hidden=true;error.textContent='';}}}
function fieldError(field,message){const element=$(field);if(!element)return;const error=$(field+'Error');if(error){error.textContent=message;error.hidden=false;}element.setAttribute('aria-invalid','true');selectView(element.closest('#form > .panel')?.id,{scroll:false});const section=element.closest('details');if(section)section.open=true;if(!$('modalOverlay').hidden)modalReturnFocus=element;else element.focus();element.scrollIntoView({block:'center',behavior:'smooth'});}
function updateActions(){
  $('save').disabled=saving||!backendReady;
  $('discard').disabled=saving||!dirty;
  $('save').textContent=saving?'正在保存…':'保存并应用';
  $('draftState').textContent=saving?'正在保存设置…':!backendReady?'后台暂时未连接':dirty?'有修改尚未保存':'设置已保存';
  $('draftState').className=dirty&&!saving?'dirty':'';
  const connection=!lastStatus?'':lastStatus.qqConnected?' · QQ 已连接':!lastStatus.enabled?' · 桥接已暂停':' · QQ 尚未连接';
  $('saveHint').textContent=saving?'请稍候，正在核对保存结果。':!backendReady?'点击上方重试连接，输入的内容会保留。':dirty?'人设和聊天节奏即时更新；更换模型只重载聊天引擎，修改 QQ 地址或令牌才重连。':lastSavedAt?`最后保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN',{hour12:false})}${connection}`:'可修改设置，然后点击「保存并应用」。';
}
async function api(url,{timeout=10000,...options}={}){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch(url,{...options,signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...options.headers}});
    let result;try{result=await response.json();}catch(error){if(error.name==='AbortError')throw error;throw new Error(`后台返回了无法读取的内容（HTTP ${response.status}）。`);}
    if(!response.ok){const error=new Error(result.error||`请求失败（HTTP ${response.status}）。`);error.field=result.field;error.status=response.status;throw error;}return result;
  }catch(error){
    if(error.name==='AbortError')throw new Error('请求超时，输入的设置已保留。请检查桥接程序是否运行，再重试。');
    if(error instanceof TypeError)throw new Error('无法连接本机后台。请启动桥接程序后重试，输入的设置已保留。');throw error;
  }finally{clearTimeout(timer);}
}
function renderStatus(data){
  lastStatus=data.status;const s=lastStatus;
  $('badge').textContent=s.qqConnected?'QQ 已连接':s.enabled?'QQ 尚未连接':'桥接已暂停';
  $('badge').className=`badge ${s.qqConnected?'online':'offline'}`;
  $('selfId').textContent=s.selfId||(s.qqConnected?'正在识别账号':'等待登录');$('socialState').textContent=s.chatProvider==='omni'?`Omni · ${s.chatModel}`:s.chatProvider==='openai'?s.chatModel:(s.socialReady?'Codex 已就绪':'Codex · 收到消息时启动');
  $('privateState').textContent=s.privateMode==='work'?'工作':'聊天';$('activeState').textContent=String(s.activeTasks);
  const metrics=s.metrics,today=metrics?.today;
  if(today){
    $('metricCalls').textContent=String(today.calls);$('metricLatency').textContent=today.calls?`${(today.averageMs/1000).toFixed(1)} 秒`:'—';
    $('metricTokens').textContent=today.calls===today.unknownUsage?(today.calls?'未知':'—'):`${today.inputTokens.toLocaleString()} / ${today.outputTokens.toLocaleString()}${today.unknownUsage?'（已知部分）':''}`;$('metricQueue').textContent=String(s.queuedMessages||0);
    $('metricDetail').textContent=`失败 ${today.failures} 次；用量未知 ${today.unknownUsage} 次。`+Object.entries(today.kinds).map(([k,n])=>` ${kindLabel(k)} ${n} 次`).join('，');
    $('metricAggregation').textContent=`今日 ${today.receivedMessages||0} 条消息聚合为 ${today.batches||0} 批，合并减少 ${today.mergedRequests||0} 次逐条聊天请求。此统计不包含重写、图片和语音预处理，不能直接换算为 token 节省比例。`;
    textRows('metricRecent',metrics.recent.slice().reverse().map(v=>`${clock(v.at)} · ${kindLabel(v.kind)} · ${v.model} · ${(v.durationMs/1000).toFixed(1)} 秒 · ${v.ok?'完成':'失败'} · ${v.usage?`${v.usage.input}/${v.usage.output} token`:'用量未知'}`));
    textRows('metricDecisions',metrics.decisions.slice().reverse().map(v=>`${clock(v.at)} · ${v.reason}`));
  }
  const outreach=s.outreach;$('outreachStatus').textContent=outreach?`${outreach.reason}\n今天已主动发送 ${outreach.sentToday} 次，考虑 ${outreach.checksToday} 次。`:'主动私聊状态暂不可用，请更新并重启桥接程序。';
  $('projectState').textContent=s.project;$('workState').textContent=s.workReady?'工作引擎已就绪。':'工作引擎会在收到任务时启动。';
  const entries=data.logs.slice().reverse();$('latestLog').textContent=entries[0]?`${entries[0].time} ${entries[0].message}`:'暂无运行记录';
  $('logs').replaceChildren(...entries.map(entry=>{const row=document.createElement('div');row.textContent=`${entry.time} ${entry.message}`;row.className=/失败|错误|中断/.test(entry.message)?'bad':/完成|就绪|已建立/.test(entry.message)?'good':'';return row;}));
  if(saveFeedback&&noticeKind==='success')renderSaveFeedback();
}
function renderSaveFeedback(){
  const s=lastStatus;const time=lastSavedAt?new Date(lastSavedAt).toLocaleTimeString('zh-CN',{hour12:false}):'';
  const connection=s?.qqConnected?'QQ 已连接。':s&&!s.enabled?'桥接已暂停。':s?.qqError?`QQ 尚未连接：${s.qqError}`:'QQ 尚未连接，后台会自动重试；请确认 SnowLuma 的机器人账号已登录。';
  notify(`设置已保存${time?'（'+time+'）':''}。\n${connection}`,'success');
}
function renderToken(){
  $('tokenState').textContent=hasToken?'令牌已保存':'尚未保存令牌';
  $('onebotToken').placeholder=hasToken?'已保存，留空保留原令牌':'填写 SnowLuma 中的 accessToken';
  $('apiKeyState').textContent=hasApiKey?'API Key 已保存':'尚未保存 API Key';
  $('apiKey').placeholder=hasApiKey?'已保存，留空保留原值':'填写该服务的 API Key；本机模型可留空';
  $('voiceKey').placeholder=hasVoiceKey?'已保存，留空保留原值':'填写 Omni / 语音服务的 API Key';
  $('voiceKeyState').textContent=hasVoiceKey?'语音密钥已保存':'尚未保存语音密钥';
}
function acceptState(data,{replaceDraft=false}={}){
  const firstLoad=!savedDraft;
  const changed=revision&&revision!==data.revision;
  current=data.config;hasToken=data.hasOnebotToken;baseDefault=data.baseDefault??baseDefault;hasApiKey=!!data.hasApiKey;hasVoiceKey=!!data.hasVoiceKey;lastSavedAt=data.savedAt;backendReady=true;backendUnlimitedRecords=data.capabilities?.unlimitedDistillRecords===true;backendCompanion=data.capabilities?.companionOptimizations===true;
  backendNativeOmni=data.capabilities?.nativeOmni===true;
  $('companionUpgrade').hidden=backendCompanion&&backendNativeOmni;
  const scope=$('memoryScope'),scopes=[`private:${current.ownerQQ}`,...current.groups.map(g=>`group:${g}`)];
  if(JSON.stringify([...scope.options].map(v=>v.value))!==JSON.stringify(scopes)){const old=scope.value;scope.replaceChildren(...scopes.map(v=>new Option(v.startsWith('private:')?'你的私聊':`群 ${v.slice(6)}`,v)));if(scopes.includes(old))scope.value=old;}
  if(!savedDraft||replaceDraft||(!dirty&&!saving&&changed)){
    revision=data.revision;savedDraft=configToDraft(current);fillDraft(savedDraft);dirty=false;
  }else if(changed&&!saving&&noticeKind!=='error')notify('后台配置已在其他页面更新。你的输入仍然保留；请点击「撤销修改」载入最新配置后再编辑。','warning');
  $('setupGuide').hidden=!!current.ownerQQ;
  if(firstLoad&&!current.ownerQQ)selectView('connection',{scroll:false});
  renderToken();renderStatus(data);$('retry').hidden=true;updateActions();
}
async function refresh(){
  if(refreshing||saving)return;refreshing=true;
  try{const data=await api('/api/state');const wasOffline=!backendReady;acceptState(data);if(wasOffline&&noticeKind==='error')notify('已重新连接后台，输入的设置已保留。','success');}
  catch(error){backendReady=false;$('badge').textContent='后台未连接';$('badge').className='badge offline';$('retry').hidden=false;saveFeedback=false;notify(error.message,'error');updateActions();}
  finally{refreshing=false;}
}
async function save(){
  if(saving)return;clearErrors();if(!current||!backendReady){notify('请先连接后台，再保存设置。','error');return;}
  const draft=readDraft();let config;
  if(draft.voiceMode==='omni'&&!backendNativeOmni){notify('后台尚未加载 Omni 更新，请重启机器人桥接后再保存。输入仍然保留。','warning');return;}
  if(!backendCompanion){notify('后台尚未载入记忆和语音更新，请重启机器人桥接后再保存。你的输入仍然保留。','warning');return;}
  try{config=buildConfig(draft,current,hasToken,hasApiKey,hasVoiceKey);}catch(error){saveFeedback=false;notify(`还没有保存：${error.message}`,'error');fieldError(error.field,error.message);return;}
  saving=true;saveFeedback=false;updateActions();notify('正在保存并核对配置…');
  try{
    const result=await api('/api/config',{method:'POST',headers:{'If-Match':revision},body:JSON.stringify(config)});
    // The POST confirms the write. Readback trouble must not claim the committed save failed.
    config.onebot.accessToken='';config.chat.apiKey='';config.voice.apiKey='';current=config;hasToken=result.hasOnebotToken;hasApiKey=!!result.hasApiKey;hasVoiceKey=!!result.hasVoiceKey;revision=result.revision;lastSavedAt=result.savedAt;
    savedDraft=configToDraft(config);fillDraft(savedDraft);dirty=false;renderToken();
    try{acceptState(await api('/api/state'),{replaceDraft:true});}catch{backendReady=false;$('retry').hidden=false;}
    saveFeedback=true;renderSaveFeedback();
    {const s=lastStatus;const time=lastSavedAt?new Date(lastSavedAt).toLocaleTimeString('zh-CN',{hour12:false}):'';
    const conn=s?.qqConnected?'QQ 已连接。':s&&!s.enabled?'桥接已暂停。':s?.qqError?`QQ 尚未连接：${s.qqError}`:'QQ 尚未连接，后台会自动重试。';
    showModal('保存成功',`设置已保存${time?'（'+time+'）':''}，已即时生效。
${conn}`,{kind:'success'});}
    if(!backendReady)notify('配置已保存；暂时无法读取连接状态，请点击重试。','success');
    else if(result.changed===false)notify('已核对：设置没有变化，连接保持不变。\n'+(lastStatus?.qqConnected?'QQ 已连接。':lastStatus?.enabled?'QQ 尚未连接，后台会自动重试。':'桥接已暂停。'),'success');
  }catch(error){saveFeedback=false;notify(`保存失败：${error.message}`,'error');fieldError(error.field,error.message);}
  finally{saving=false;updateActions();}
}
for(const id of fields){$(id).addEventListener('input',()=>{dirty=savedDraft?!draftEqual(readDraft(),savedDraft):true;updateCounter();updateProvider();const error=$(id+'Error');if(error)error.hidden=true;$(id).removeAttribute('aria-invalid');if(['chatProvider','apiBase','apiModel','apiKey','clearApiKey'].includes(id))$('testResult').textContent='';saveFeedback=false;if(noticeKind==='success')notify('');updateActions();});}
$('testChat').addEventListener('click',async()=>{
  if(testing||!current)return;clearErrors();let config;
  try{config=buildConfig(readDraft(),current,hasToken,hasApiKey,hasVoiceKey);}catch(error){fieldError(error.field,error.message);$('testResult').textContent=error.message;return;}
  testing=true;$('testChat').disabled=true;$('testResult').textContent='正在测试模型连接…';
  try{const result=await api('/api/chat/test',{method:'POST',body:JSON.stringify({chat:config.chat}),timeout:20000});$('testResult').textContent=result.message;}
  catch(error){$('testResult').textContent='连接测试失败：'+error.message;fieldError(error.field,error.message);}
  finally{testing=false;$('testChat').disabled=false;}
});
$('omniPreset').addEventListener('click',()=>{
  $('voiceMode').value='omni';$('voiceModel').value='qwen3.8-omni-flash';
  dirty=!draftEqual(readDraft(),savedDraft);saveFeedback=false;updateProvider();updateActions();
  $('omniTestResult').textContent='已选择原生 Omni。请填写百炼业务空间的基础地址和对应 API Key，再开启并保存；预设不自动复制密钥。';
});
$('testOmni').addEventListener('click',async()=>{
  if(testing||!current)return;clearErrors();let config;
  if(!backendNativeOmni){$('omniTestResult').textContent='请重启机器人桥接以加载 Omni 更新。';return;}
  try{config=buildConfig({...readDraft(),voiceEnabled:true},current,hasToken,hasApiKey,hasVoiceKey);}catch(error){fieldError(error.field,error.message);$('omniTestResult').textContent=error.message;return;}
  testing=true;$('testOmni').disabled=true;$('omniTestResult').textContent='正在发送固定测试文字，不发送音频或聊天记录…';
  try{const result=await api('/api/omni/test',{method:'POST',body:JSON.stringify({voice:config.voice}),timeout:20000});$('omniTestResult').textContent=result.message;}
  catch(error){$('omniTestResult').textContent='Omni 测试失败：'+error.message;fieldError(error.field,error.message);}
  finally{testing=false;$('testOmni').disabled=false;}
});
const DISTILL_MARKER='【从真实聊天记录蒸馏的风格】';
const DISTILL_END='【蒸馏块结束】';
function stripDistillBlock(text){
  const start=text.indexOf(DISTILL_MARKER);
  if(start<0)return null;
  const end=text.indexOf(DISTILL_END,start);
  const cut=end>=0?end+DISTILL_END.length:text.length;
  return (text.slice(0,start)+text.slice(cut)).replace(/[ \t]*\n{3,}/g,'\n\n').replace(/\s+$/,'');
}
async function loadPresets(){
  const list=$('presetList');
  try{
    const data=await api('/api/personas');
    const names=Object.keys(data.presets);
    $('presetEmpty').hidden=names.length>0;
    list.replaceChildren(...names.map(name=>{
      const preset=data.presets[name];
      const card=document.createElement('div');card.className='preset-card';card.dataset.name=name;
      const head=document.createElement('div');head.className='preset-head';
      const strong=document.createElement('strong');strong.textContent=name;
      const when=document.createElement('span');when.textContent=preset.updatedAt?new Date(preset.updatedAt).toLocaleString('zh-CN',{hour12:false}):'';
      head.append(strong,when);
      const preview=document.createElement('p');preview.className='preset-preview';
      preview.textContent=(preset.text||'').replace(/\s+/g,' ').slice(0,80)||'（空人设）';
      const actions=document.createElement('div');actions.className='preset-row';
      for(const [act,label,cls] of [['apply','应用',''],['load','载入编辑','secondary'],['delete','删除','secondary']]){
        const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.act=act;if(cls)button.className=cls;
        actions.append(button);
      }
      card.append(head,preview,actions);
      return card;
    }));
  }catch{}
}
$('presetList').addEventListener('click',async event=>{
  const button=event.target.closest('button[data-act]');
  if(!button)return;
  const name=button.closest('.preset-card')?.dataset.name;
  if(!name)return;
  const act=button.dataset.act;
  if(act==='apply'){
    if(dirty){const go=await showModal('有修改尚未保存',`当前页面有还没保存的修改，应用预设「${name}」会丢弃这些修改。要继续吗？`,{kind:'warning',confirmLabel:'丢弃修改并切换',cancelLabel:'取消'});if(!go)return;}
    try{
      const result=await api('/api/personas/apply',{method:'POST',body:JSON.stringify({name})});
      revision=result.revision;lastSavedAt=result.savedAt;
      await acceptState(await api('/api/state'),{replaceDraft:true});
      showModal('切换成功',`已切换到人设「${name}」并生效，下一轮聊天就用新性格。`,{kind:'success'});
    }catch(error){notify(error.message,'error');}
  }else if(act==='load'){
    if(dirty){const go=await showModal('有修改尚未保存',`载入预设「${name}」会覆盖文本框里还没保存的修改。要继续吗？`,{kind:'warning',confirmLabel:'覆盖并载入',cancelLabel:'取消'});if(!go)return;}
    try{
      const data=await api('/api/personas');
      $('persona').value=data.presets[name]?.text||'';
      $('persona').dispatchEvent(new Event('input',{bubbles:true}));
      notify(`预设「${name}」已载入人设框，改完记得点「保存并应用」。`,'info');
    }catch(error){notify(error.message,'error');}
  }else if(act==='delete'){
    const go=await showModal('删除预设',`确定删除预设「${name}」？只删存档，不影响正在用的人设。`,{kind:'warning',confirmLabel:'删除',cancelLabel:'取消'});
    if(!go)return;
    try{await api('/api/personas',{method:'DELETE',body:JSON.stringify({name})});await loadPresets();notify(`已删除预设「${name}」。`,'info');}
    catch(error){notify(error.message,'error');}
  }
});
$('personaPresetSave').addEventListener('click',async()=>{
  const name=$('personaPresetName').value.trim();
  if(!name){notify('请先填写预设名称。','error');return;}
  try{
    await api('/api/personas',{method:'POST',body:JSON.stringify({name,text:$('persona').value})});
    $('personaPresetName').value='';await loadPresets();
    notify(`已把当前人设存为预设「${name}」。`,'success');
  }catch(error){notify(error.message,'error');}
});
$('environmentCheck').addEventListener('click',async()=>{
  const button=$('environmentCheck');button.disabled=true;$('environmentResult').textContent='正在检查已保存的配置…';
  try{const result=await api('/api/environment');$('environmentResult').textContent=result.checks.map(c=>({ok:'✓',warning:'提示',error:'失败',info:'说明'}[c.level])+' '+c.message).join('\n')+(dirty?'\n页面有未保存的修改，本次检查使用已保存配置。':'');}
  catch(error){$('environmentResult').textContent=error.message;}finally{button.disabled=false;}
});
$('basePersonaReset').addEventListener('click',()=>{
  if(baseDefault===null){notify('还没读到默认规则，请稍候重试。','error');return;}
  $('basePersona').value=baseDefault;
  $('basePersona').dispatchEvent(new Event('input',{bubbles:true}));
  notify('已恢复默认 15 条基础规则，点「保存并应用」生效。','info');
});
$('personaStrip').addEventListener('click',()=>{
  const stripped=stripDistillBlock($('persona').value);
  if(stripped===null){notify('人设里没有蒸馏块。','info');return;}
  $('persona').value=stripped;
  $('persona').dispatchEvent(new Event('input',{bubbles:true}));
  notify('蒸馏块已从人设中移除，请点「保存并应用」。','info');
});
async function loadDistillSessions(){
  const select=$('distillSession');
  try{
    const data=await api('/api/distill/sessions');
    select.replaceChildren(new Option('全部会话（全部记录）',''),...data.sessions.map(session=>new Option(`${session.is_group?'群':'私聊'} ${session.session_id}（${session.n} 条）`,String(session.session_id))));
  }catch{select.replaceChildren(new Option('全部会话（全部记录）',''));}
}
$('distill').addEventListener('toggle',()=>{if($('distill').open&&$('distillSession').options.length<=1)loadDistillSessions();});
$('distillSource').addEventListener('change',()=>{
  const source=$('distillSource').value;
  $('distillPasteWrap').hidden=source!=='paste';
  $('distillFilesWrap').hidden=source!=='files';
  $('distillImageWrap').hidden=source!=='image';
  $('distillImageOpts').hidden=source!=='image';
  $('distillSessionWrap').hidden=source!=='snowluma';
});
let distillRawFiles=[];
const RAW_FILE_EXT=/\.(json|jsonl|csv|txt)$/i;
const rawFileKey=file=>file.webkitRelativePath||`${file.name}:${file.size}`;
function renderDistillRawState(){
  const total=distillRawFiles.reduce((sum,file)=>sum+file.size,0);
  $('distillRawState').textContent=distillRawFiles.length?`已载入 ${distillRawFiles.length} 个记录文件（共 ${(total/1048576).toFixed(1)} MB）：${distillRawFiles.map(file=>file.name).join('、')}。蒸馏时直接解析，不进文本框。`:'尚未选择文件或文件夹。';
}
function addRawFiles(list){
  let added=0;
  for(const file of Array.from(list||[])){
    if(!RAW_FILE_EXT.test(file.name))continue;
    const key=rawFileKey(file);
    if(distillRawFiles.some(kept=>rawFileKey(kept)===key))continue;
    distillRawFiles.push(file);added++;
  }
  renderDistillRawState();
  return added;
}
$('distillRawFile').addEventListener('change',()=>addRawFiles($('distillRawFile').files));
$('distillFolderFile').addEventListener('change',()=>{
  const added=addRawFiles($('distillFolderFile').files);
  notify(added?`已从文件夹读入 ${added} 个记录文件（图片/语音/视频自动忽略）。`:'这个文件夹里没有找到支持的记录文件（.json / .jsonl / .csv / .txt）。',added?'info':'warning');
});
$('distillRawClear').addEventListener('click',()=>{distillRawFiles=[];$('distillRawFile').value='';$('distillFolderFile').value='';renderDistillRawState();});
function readImageAsDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result));
    reader.onerror=()=>reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}
let distillImageFiles=[];
function renderDistillImageState(){
  $('distillImageState').textContent=distillImageFiles.length?`已选 ${distillImageFiles.length} 张：${distillImageFiles.map(file=>file.name).join('、')}`:'尚未选择图片';
}
$('distillImage').addEventListener('change',()=>{
  for(const file of Array.from($('distillImage').files||[]))if(!distillImageFiles.some(kept=>kept.name===file.name&&kept.size===file.size))distillImageFiles.push(file);
  renderDistillImageState();
});
$('distillImageClear').addEventListener('click',()=>{distillImageFiles=[];$('distillImage').value='';renderDistillImageState();});
let distillPollTimer=null,activeDistillId=null,shownDistillResultId=null;
function renderReviewCount(){
  const count=reviewLines($('distillPreview').value).length;
  const label=$('distillReviewCount');label.textContent=`当前 ${count.toLocaleString('zh-CN')} 条聊天记录（至少 10 条；每行一条消息）。${backendUnlimitedRecords?'无条数上限。':'后台仍是旧版，请重启 QQ 桥接程序并刷新页面，加载取消上限的更新。'}`;
  label.classList.toggle('field-error',count<10);
}
$('distillPreview').addEventListener('input',renderReviewCount);
function renderDistillJob(job){
  if(!job||job.phase==='idle')return;
  activeDistillId=job.id;
  const active=!['done','error','cancelled'].includes(job.phase);
  if(active)$('distill').open=true;
  $('distillProgress').hidden=false;
  $('distillProgressBar').style.width=`${Math.max(0,Math.min(100,job.percent||0))}%`;
  const elapsed=Math.round((Date.now()-(job.startedAt||Date.now()))/1000);
  $('distillProgressText').textContent=`${job.detail||'处理中…'} · 已用时 ${elapsed} 秒`;
  $('distillRun').disabled=active;
  $('distillRun').textContent=active?'蒸馏进行中…':'开始蒸馏';
  $('distillCancel').hidden=!active;
  if(job.id&&job.phase!=='idle')activeDistillId=job.id;
  $('distillReview').hidden=job.phase!=='review';
  if(job.phase==='review')renderReviewCount();
  if(job.phase==='review'&&$('distillPreview').dataset.jobId!==job.id){
    $('distillPreview').value=job.preview||'';$('distillPreview').dataset.jobId=job.id;
    renderReviewCount();
    showModal('蒸馏暂停：等你校对记录',`记录已整理好（共 ${job.lines} 条），正在「聊天记录蒸馏」面板的校对框里等你检查。\n改正错字、删掉不想发送的内容后，点「确认记录并开始分析」才会送给模型。\n不点确认它会一直等着，不会自己继续。`,{kind:'warning',confirmLabel:'去看校对框'});
    selectView('distill',{scroll:false});
    $('distillReview').scrollIntoView({block:'center',behavior:'smooth'});
  }
  if(job.recognition)$('distillRecognition').textContent=`已识别 ${job.recognition.images} 张图、${job.recognition.textLines} 行文字、${job.recognition.messages} 条聊天气泡；选取 ${job.lines} 条。`;
  else if(job.lines)$('distillRecognition').textContent=`已整理 ${job.lines} 条聊天记录。`;
  if(job.phase==='done'&&shownDistillResultId!==job.id){
    shownDistillResultId=job.id;
    let savedDraft=null;
    try{if(localStorage.getItem('distillNotesJobId')===job.id)savedDraft=localStorage.getItem('distillNotesDraft');}catch{}
    $('distillNotes').value=savedDraft??job.notes??'';$('distillMemoryReviewed').checked=false;
    try{localStorage.setItem('distillNotesJobId',job.id);localStorage.setItem('distillNotesDraft',$('distillNotes').value);}catch{}
  }
  if(job.phase==='error'){$('distillError').textContent=job.detail||'蒸馏失败';$('distillError').hidden=false;}
  if(active&&!distillPollTimer)distillPollTimer=setInterval(()=>syncDistillJob().catch(()=>{}),2000);
  if(!active&&distillPollTimer){clearInterval(distillPollTimer);distillPollTimer=null;}
}
async function syncDistillJob(){renderDistillJob(await api('/api/distill/progress',{timeout:5000}));}
$('distillRun').addEventListener('click',async()=>{
  $('distillError').hidden=true;$('distillRecognition').textContent='';
  const button=$('distillRun');button.disabled=true;button.textContent='正在提交记录…';
  try{
    if(!backendUnlimitedRecords)throw new Error('后台仍是旧版，请重启 QQ 桥接程序并刷新页面，加载取消条数上限的更新。');
    const source=$('distillSource').value;let body;
    if(source==='paste')body={text:$('distillPaste').value};
    else if(source==='files'){
      if(!distillRawFiles.length)throw new Error('请先选择记录文件或导出文件夹。');
      const texts=[];
      for(const file of distillRawFiles)texts.push(await file.text());
      body={text:texts.join('\n')};
    }
    else if(source==='image'){
      const files=distillImageFiles.length?distillImageFiles:Array.from($('distillImage').files||[]);
      if(!files.length)throw new Error('请先选择聊天截图（可分多次选，会自动累加）。');
      if(files.length>20)throw new Error(`一次最多 20 张截图，当前已选 ${files.length} 张。`);
      body={images:await Promise.all(files.map(readImageAsDataUrl)),selfSide:$('distillSelfSide').value,bothSides:$('distillBothSides').checked};
    }else body={session:$('distillSession').value||undefined};
    body.background=$('distillBackground').value.trim();
    const result=await api('/api/distill',{method:'POST',body:JSON.stringify(body),timeout:120000});
    activeDistillId=result.id;shownDistillResultId=null;$('distillPreview').dataset.jobId='';
    await syncDistillJob();
  }catch(error){$('distillError').textContent=error.message;$('distillError').hidden=false;button.disabled=false;button.textContent='开始蒸馏';}
});
$('distillConfirm').addEventListener('click',async()=>{
  const button=$('distillConfirm');button.disabled=true;
  try{
    if(!backendUnlimitedRecords)throw new Error('后台仍是旧版，请重启 QQ 桥接程序并刷新页面后再确认。');
    const lines=validateReviewedLog($('distillPreview').value);
    await api('/api/distill/confirm',{method:'POST',body:JSON.stringify({id:activeDistillId,text:lines.join('\n'),background:$('distillBackground').value.trim()}),timeout:15000});
    $('distillError').hidden=true;await syncDistillJob();
  }catch(error){$('distillError').textContent=error.message;$('distillError').hidden=false;notify(`确认失败：${error.message}`,'error');}
  finally{button.disabled=false;}
});
$('distillCancel').addEventListener('click',async()=>{
  try{await api('/api/distill/cancel',{method:'POST',body:JSON.stringify({id:activeDistillId})});await syncDistillJob();}
  catch(error){$('distillError').textContent=error.message;$('distillError').hidden=false;}
});
$('distillMerge').addEventListener('click',()=>{
  const notes=$('distillNotes').value.trim();
  if(!notes){notify('蒸馏结果框是空的：请先点「开始蒸馏」生成内容，或把内容粘贴进蒸馏结果框再并入。','error');return;}
  const rows=notes.split(/\r?\n/).map(line=>line.trim());
  const memoryStart=rows.indexOf('[回忆]');
  const memories=memoryStart<0?[]:rows.slice(memoryStart+1).filter(line=>line&&!/^\[.*\]$/.test(line));
  if(memories.length&&!$('distillMemoryReviewed').checked){notify('请先核对 [回忆] 内容，改掉不准确的经历，再勾选确认。','warning');$('distillNotes').focus();return;}
  const base=stripDistillBlock($('persona').value)??$('persona').value;
  const background=$('distillBackground').value.trim();
  const bgBlock=background?`\n[背景]\n${background.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).join('\n')}`:'';
  $('persona').value=`${base}\n${DISTILL_MARKER}\n${notes.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).join('\n')}${bgBlock}\n${DISTILL_END}`;
  $('persona').dispatchEvent(new Event('input',{bubbles:true}));
  if($('persona').value.length>6000)notify('蒸馏结果已并入，但人设超过 6000 字上限，请精简蒸馏结果或原人设后再保存。','warning');
  else notify('蒸馏结果已并入人设，请点「保存并应用」。','info');
});
$('save').addEventListener('click',save);
$('form').addEventListener('submit',event=>{event.preventDefault();save();});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();save();}});
$('discard').addEventListener('click',async()=>{
  if(dirty){const go=await showModal('撤销修改','将放弃当前页面上所有未保存的修改，恢复到最近一次保存的设置。要继续吗？',{kind:'warning',confirmLabel:'放弃修改',cancelLabel:'取消'});if(!go)return;}
  try{acceptState(await api('/api/state'),{replaceDraft:true});clearErrors();saveFeedback=false;notify('已恢复到最新保存的设置。','info');}catch(error){notify(error.message,'error');}
});
$('retry').addEventListener('click',refresh);
function clock(at){return new Date(at).toLocaleString('zh-CN',{hour12:false});}
function kindLabel(k){return {chat:'私聊',group:'群聊',voice:'语音识别',outreach:'主动考虑',work:'工作',distill:'蒸馏',test:'连接测试',quality:'模型验证'}[k]||k;}
function textRows(id,rows){$(id).replaceChildren(...(rows.length?rows:['暂无记录']).map(text=>{const row=document.createElement('div');row.textContent=text;return row;}));}
function renderMemory(data){
  const m=data.mood;$('moodState').textContent=`当前语气：${m.valence<-.15?'沉静':m.valence>.15?'愉快':'平常'}；聊天活跃度：${Math.round(m.energy*100)}%。状态会随对话变化，并逐渐回到平常。`;
  const list=(id,items,kind)=>{
    $(id).replaceChildren(...items.map(item=>{
      const card=document.createElement('div');card.className='memory-card';
      const input=document.createElement('textarea');input.value=item.text;input.maxLength=300;input.rows=2;input.setAttribute('aria-label',kind==='memory'?'记忆内容':'话题内容');
      const meta=document.createElement('small');meta.textContent=kind==='memory'?`${item.manual?'手动设置':'原文提取'} · 来源：${item.source} · ${clock(item.updatedAt||item.createdAt)}`:`${item.status==='closed'?'已结束':'待续'} · 已问 ${item.askedCount||0} 次${item.askedAt?' · 最近问于 '+clock(item.askedAt):''}`;
      const actions=document.createElement('div');actions.className='record-actions';
      const button=(label,body)=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=label;b.addEventListener('click',()=>editMemory({...body(),kind,id:item.id}));return b;};
      actions.append(button('保存修改',()=>({text:input.value})));
      if(kind==='topic')actions.append(button(item.status==='closed'?'重新开启':'结束话题',()=>({text:input.value,status:item.status==='closed'?'open':'closed'})));
      actions.append(button('删除',()=>({remove:true})));card.append(input,meta,actions);return card;
    }));
    if(!items.length)textRows(id,[kind==='memory'?'暂无长期记忆，可手动补充。':'暂无待续话题。']);
  };
  list('memoryList',data.memories,'memory');list('topicList',data.topics,'topic');textRows('memorySummary',data.summary.map(v=>`${clock(v.at)} · ${v.name||'你'}：${v.text}`));
}
async function loadMemory(){
  if(!current)return;
  try{const result=await api('/api/social?scope='+encodeURIComponent($('memoryScope').value));renderMemory(result.data);$('memoryNotice').textContent='已读取最新记忆。';}
  catch(error){$('memoryNotice').textContent=error.message;}
}
async function editMemory(body){
  const buttons=$('socialMemory').querySelectorAll('button');for(const button of buttons)button.disabled=true;
  try{const result=await api('/api/social?scope='+encodeURIComponent($('memoryScope').value),{method:'POST',body:JSON.stringify(body)});renderMemory(result.data);$('memoryNotice').textContent='已保存，下次回复生效。';if(!body.id){$(body.kind==='topic'?'topicText':'memoryText').value='';}}
  catch(error){$('memoryNotice').textContent='没有保存：'+error.message;}
  finally{for(const button of buttons)button.disabled=false;}
}
$('socialMemory').addEventListener('toggle',()=>{if($('socialMemory').open)loadMemory();});
$('memoryScope').addEventListener('change',loadMemory);$('memoryRefresh').addEventListener('click',loadMemory);
$('memoryAdd').addEventListener('click',()=>editMemory({kind:'memory',text:$('memoryText').value}));
$('topicAdd').addEventListener('click',()=>editMemory({kind:'topic',text:$('topicText').value}));
await refresh();
loadPresets();
function fitSaveDock(){const dock=document.querySelector('.save-dock');if(!dock)return;const pad=dock.offsetHeight+48;document.documentElement.style.setProperty('--dock-pad',pad+'px');}
window.addEventListener('resize',fitSaveDock);
setInterval(fitSaveDock,2500);
fitSaveDock();
try{const savedNotes=localStorage.getItem('distillNotesDraft');if(savedNotes)$('distillNotes').value=savedNotes;}catch{}
$('distillNotes').addEventListener('input',()=>{$('distillMemoryReviewed').checked=false;try{localStorage.setItem('distillNotesDraft',$('distillNotes').value);}catch{}});
try{const savedBackground=localStorage.getItem('distillBackgroundDraft');if(savedBackground)$('distillBackground').value=savedBackground;}catch{}
$('distillBackground').addEventListener('input',()=>{try{localStorage.setItem('distillBackgroundDraft',$('distillBackground').value);}catch{}});
await syncDistillJob().catch(()=>{});
setInterval(refresh,4000);
