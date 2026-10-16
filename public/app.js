import {configToDraft,buildConfig,draftEqual,reviewLines,validateReviewedLog,isKimiK3,retainedVoiceDraft} from './form-state.js';
import {createProviderEditor} from './provider-editor.js';
import {createWorkbench} from './workbench.js';
const $=id=>document.getElementById(id);
// Appearance is a browser preference, independent of the robot configuration draft.
const THEME_KEY='echomate-theme';
function applyTheme(theme){
  const dark=theme==='dark';document.documentElement.dataset.theme=dark?'dark':'light';
  $('themeLabel').textContent=dark?'浅色模式':'深色模式';
  $('themeToggle').setAttribute('aria-label',dark?'切换到浅色模式':'切换到深色模式');
  $('themeToggle').title=dark?'切换到浅色模式':'切换到深色模式';
}
try{applyTheme(localStorage.getItem(THEME_KEY));}catch{applyTheme('light');}
$('themeToggle').addEventListener('click',()=>{
  const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';applyTheme(theme);
  try{localStorage.setItem(THEME_KEY,theme);}catch{/* Switching still works when storage is unavailable. */}
});
window.addEventListener('storage',event=>{if(event.key===THEME_KEY)applyTheme(event.newValue);});
try{$('gettingStarted').open=localStorage.getItem('echomate-guide-collapsed')!=='true';}catch{}
$('gettingStarted').addEventListener('toggle',()=>{try{localStorage.setItem('echomate-guide-collapsed',String(!$('gettingStarted').open));}catch{}});
const viewMeta={"home":{"label":"控制台概览","eyebrow":"OVERVIEW"},"styleSettings":{"label":"聊天风格","eyebrow":"PERSONALITY"},"socialMemory":{"label":"记忆与话题","eyebrow":"MEMORY"},"distill":{"label":"记录蒸馏","eyebrow":"DISTILLATION"},"chatSettings":{"label":"聊天模型","eyebrow":"MODEL"},"connection":{"label":"账号连接","eyebrow":"CONNECTION"},"advanced":{"label":"工作空间","eyebrow":"WORKSPACE"},"metricsPanel":{"label":"运行统计","eyebrow":"ANALYTICS"}};
const viewCopy={home:['控制台概览','机器人状态、快捷指令与最近动态。'],styleSettings:['聊天风格','设定表达方式，调整节奏，让每次对话更合拍。'],socialMemory:['记忆与话题','留住重要的事，也能修正它记错的内容。'],distill:['学习聊天风格','从已有对话中学习表达习惯，整理成自己的个性设定。'],chatSettings:['聊天模型','配置聊天模型、图片与联网搜索，查看连接是否可用。'],connection:['账号连接','管理机器人账号、群范围与 OneBot 连接。'],advanced:['工作空间','选择任务模型与项目，在 QQ 中继续工作。'],metricsPanel:['运行统计','查看模型耗时、调用次数与消息处理情况。']};
let activeView='styleSettings';
viewMeta.taskCenter={label:'任务中心',eyebrow:'TASKS'};viewCopy.taskCenter=['任务中心','跟进 QQ 工作任务，随时补充要求或停止执行。'];
function selectView(id,{scroll=true}={}){
  if(!viewMeta[id])return;
  activeView=id;
  const isHome=id==='home';
  const home=$('home');if(home)home.classList.toggle('is-active',isHome);
  document.querySelectorAll('#form > .panel').forEach(panel=>panel.classList.toggle('is-active',!isHome&&panel.id===id));
  const active=document.getElementById(id);
  if(active&&active.tagName==='DETAILS')active.open=true;
  document.querySelectorAll('[data-jump]').forEach(button=>{const selected=button.dataset.jump===id;button.classList.toggle('active',selected);if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  $('viewEyebrow').textContent=viewMeta[id].eyebrow;
  [$('viewTitle').textContent,$('viewDescription').textContent]=viewCopy[id];
  const target=$(id);if(target&&target.tagName==='DETAILS')target.open=true;
  if(id==='socialMemory'&&current&&!memoryLoading&&!memoryEditing)loadMemory();
  if(id==='taskCenter')workbench.refresh();
  if(scroll)window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
}
document.body.classList.add('enhanced');
selectView('home',{scroll:false});
document.querySelectorAll('[data-jump]').forEach(button=>button.addEventListener('click',()=>selectView(button.dataset.jump)));
document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();selectView('home');});
document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();$('form').setAttribute('tabindex','-1');$('form').focus();$('form').scrollIntoView({block:'start'});});
// Summaries stay natively clickable; selecting a view auto-opens its panel.
const fields=['snowlumaDbPath','owner','groups','ws','onebotToken','model','projects','basePersona','persona','proactive','probability','cooldown','hourly','enabled','chatProvider','apiBase','apiModel','apiKey','clearApiKey','memoryTurns','contextChars','mergeDelayMs','mergeMaxWaitMs'];
const toggles=new Set(['proactive','enabled','clearApiKey']);
const token=location.hash.slice(1);
let current,revision,hasToken=false,savedDraft,dirty=false,saving=false,backendReady=false,lastStatus,lastSavedAt,refreshing=false,noticeKind='',saveFeedback=false;
fields.push('searchEnabled','imageFollowup');toggles.add('searchEnabled');toggles.add('imageFollowup');
let hasApiKey=false,hasVoiceKey=false,testing=false,backendUnlimitedRecords=false,backendCompanion=false,backendNativeOmni=false,backendSearch=false,backendKimi=false,backendCodexSearch=false,baseDefault=null;
let providerFlags={},backendProviders=false;
let backendWorkspace=false,workspaceBusy=false,workspaceProject=null;
const readDraft=()=>({...retainedVoiceDraft(current),...Object.fromEntries(fields.map(id=>[id,toggles.has(id)?$(id).checked:$(id).value])),...providerEditor.read()});
const providerEditor=createProviderEditor({$,onChange(){dirty=savedDraft?!draftEqual(readDraft(),savedDraft):true;saveFeedback=false;updateProvider();updateActions();},confirm:message=>showModal('删除供应商',message,{kind:'warning',confirmLabel:'删除',cancelLabel:'取消'})});
function fillDraft(draft){for(const id of fields){if(toggles.has(id))$(id).checked=draft[id];else $(id).value=draft[id];}providerEditor.load(current,providerFlags,hasApiKey);updateCounter();updateProvider();savedDraft=readDraft();}
function updateProvider(){
  $('apiFields').hidden=$('chatProvider').value!=='openai';
  const kimi=isKimiK3({provider:$('chatProvider').value,model:$('apiModel').value.trim(),protocol:$('apiProtocol').value});
  const omni=!kimi&&current?.voice?.enabled&&current.voice.mode==='omni';
  const codex=$('chatProvider').value==='codex'&&!omni;
  $('apiBaseHint').textContent=$('apiProtocol').value==='anthropic'?'使用 Anthropic Messages 格式；地址可填写服务根路径、/v1 或完整 /v1/messages。':'填写服务商的 Chat Completions 地址，或选择自动识别兼容已有配置。';
  $('engineNotice').hidden=!(kimi||omni);
  $('engineNotice').textContent=kimi?'当前选择：Kimi K3 负责聊天与看图，使用原生联网工具。修改后保存生效。':omni?'当前仍使用已保存的 Omni 聊天接口；该接口的配置入口暂时移除。':'';
  $('searchStatus').textContent=!backendSearch||kimi&&!backendKimi||codex&&!backendCodexSearch?'后台尚未加载相应搜索更新，请重启桥接。':!codex&&!kimi&&!omni?'此模型暂不支持按需联网搜索。':$('searchEnabled').checked?'已允许模型按需联网；开启不代表每条消息都已搜索。':'联网搜索已关闭。';
  $('searchHelp').textContent=codex?'Codex 根据当前问题决定是否联网，无需额外密钥。':kimi?'Kimi K3 根据当前问题决定是否联网，使用所选供应商的密钥。':omni?'使用已有 Omni 接口的联网能力。':'目前支持 Codex 和 Kimi K3；其他模型请关闭此项。';
  $('searchLimits').textContent='联网可能增加耗时与服务商费用。主动插话不搜索；不根据人脸确认身份，不编造结果或把模型自述当作已经搜索。';
}
function updateCounter(){
  $('personaCount').textContent=`${$('persona').value.length} / 6000`;
  $('personaSummary').textContent=$('persona').value.trim().replace(/\s+/g,' ').slice(0,160)||'还没有个性设定，机器人将按基础行为规则交流。';
  const pending=current&&$('persona').value!==(current.persona||'');
  $('personaCurrentState').textContent=pending?'未应用的草稿':'当前人设';
  document.querySelector('.current-persona h3').textContent=pending?'编辑中的个性设定':'正在使用的个性设定';
}
let personaBeforeEdit='',personaReturnFocus=null;
function openPersonaEditor({text,name='',opener=document.activeElement}={}){
  if($('personaEditor').hidden){personaBeforeEdit=$('persona').value;personaReturnFocus=opener;}
  if(text!==undefined){$('persona').value=text;$('persona').dispatchEvent(new Event('input',{bubbles:true}));}
  $('personaEditorTitle').textContent=name?`编辑「${name}」`:'编辑个性设定';
  $('personaPresetName').value=name;
  $('personaEditorStatus').textContent='';
  $('personaLibrary').hidden=true;$('personaEditor').hidden=false;
  selectView('styleSettings',{scroll:false});$('persona').focus();$('personaEditor').scrollIntoView({block:'start'});
}
function closePersonaEditor({cancel=false,focus=true}={}){
  if($('personaEditor').hidden)return;
  if(cancel){$('persona').value=personaBeforeEdit;$('persona').dispatchEvent(new Event('input',{bubbles:true}));}
  $('personaEditor').hidden=true;$('personaLibrary').hidden=false;updateCounter();
  if(focus)(personaReturnFocus?.isConnected&&personaReturnFocus.getClientRects().length?personaReturnFocus:$('personaEditCurrent')).focus();
}
$('personaEditCurrent').addEventListener('click',()=>openPersonaEditor());
$('personaNew').addEventListener('click',()=>openPersonaEditor({text:''}));
$('personaDone').addEventListener('click',()=>{closePersonaEditor();if(dirty)notify('人设编辑已保留。点击「保存并应用」更新机器人。');});
$('personaCancel').addEventListener('click',()=>closePersonaEditor({cancel:true}));
$('presetReload').addEventListener('click',loadPresets);
function notify(message,kind='info'){$('notice').textContent=message;$('notice').className=`notice ${kind}`;$('notice').hidden=!message;$('notice').setAttribute('role',kind==='error'?'alert':'status');noticeKind=kind;}
let modalResolver=null,modalReturnFocus=null;
function showModal(title,message,{confirmLabel='知道了',cancelLabel=null,kind='info'}={}){return new Promise(resolve=>{if(modalResolver)modalResolver(false);modalReturnFocus=document.activeElement;$('modalTitle').textContent=title;$('modalMessage').textContent=message;$('modalCard').className=`modal-card ${kind}`;$('modalOk').textContent=confirmLabel;$('modalCancel').hidden=!cancelLabel;if(cancelLabel)$('modalCancel').textContent=cancelLabel;$('modalOverlay').hidden=false;$('modalOk').focus();modalResolver=resolve;});}
function closeModal(value){$('modalOverlay').hidden=true;const resolver=modalResolver;modalResolver=null;if(modalReturnFocus?.isConnected&&modalReturnFocus.getClientRects().length)modalReturnFocus.focus();modalReturnFocus=null;resolver?.(value);}
$('modalOk').addEventListener('click',()=>closeModal(true));
$('modalCancel').addEventListener('click',()=>closeModal(false));
$('modalOverlay').addEventListener('click',event=>{if(event.target===$('modalOverlay'))closeModal(false);});
$('modalOverlay').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeModal(false);}else if(event.key==='Tab'){event.preventDefault();const buttons=[$('modalCancel'),$('modalOk')].filter(button=>!button.hidden);const index=buttons.indexOf(document.activeElement);buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length].focus();}});
window.addEventListener('beforeunload',event=>{if(dirty&&!saving){event.preventDefault();event.returnValue='';}});
function clearErrors(){for(const id of [...fields,'providerName','providerEnabled','apiProtocol','providerModels']){$(id).removeAttribute('aria-invalid');const error=$(id+'Error');if(error){error.hidden=true;error.textContent='';}}}
function fieldError(field,message){const element=$(field);if(!element)return;if(field==='persona'&&$('personaEditor').hidden)openPersonaEditor();const error=$(field+'Error');if(error){error.textContent=message;error.hidden=false;}element.setAttribute('aria-invalid','true');selectView(element.closest('#form > .panel')?.id,{scroll:false});const section=element.closest('details');if(section)section.open=true;if(!$('modalOverlay').hidden)modalReturnFocus=element;else element.focus();element.scrollIntoView({block:'center',behavior:'smooth'});}
function updateActions(){
  $('save').disabled=saving||workspaceBusy||!backendReady;
  $('save').setAttribute('aria-busy',String(saving));
  $('discard').disabled=saving||!dirty;
  $('save').textContent=saving?'正在保存…':'保存并应用';
  $('draftState').textContent=saving?'正在保存设置…':!backendReady?'后台暂时未连接':dirty?'有修改尚未保存':'设置已保存';
  $('draftState').className=dirty&&!saving?'dirty':'';
  const connection=!lastStatus?'':lastStatus.qqConnected?' · QQ 已连接':!lastStatus.enabled?' · 桥接已暂停':' · QQ 尚未连接';
  $('saveHint').textContent=saving?'请稍候，正在核对保存结果。':!backendReady?'重试连接后台后即可保存，输入会保留。':dirty?'点击「保存并应用」更新机器人，切换分区会保留输入。':lastSavedAt?`最后保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN',{hour12:false})}${connection}`:'可修改设置，然后点击「保存并应用」。';
  updateWorkspaceActions();
}
function updateWorkspaceActions(){
  const blocked=workspaceBusy||saving||!backendReady;
  $('chooseWorkDirectory').disabled=blocked;
  $('useWorkProject').disabled=blocked||dirty;
  $('applyWorkDirectory').disabled=blocked||dirty||!$('workDirectory').value.trim();
}
function workspaceMessage(message){$('workspaceResult').textContent=message;$('workspaceResult').hidden=!message;}
function renderWorkspace(status){
  const selector=$('workProject'),previous=selector.value;
  const projects=[['','默认工作目录'],...Object.entries(current.projects).map(([name,dir])=>[name,`${name} · ${dir}`])];
  if(JSON.stringify([...selector.options].map(o=>[o.value,o.text]))!==JSON.stringify(projects))selector.replaceChildren(...projects.map(([value,label])=>new Option(label,value)));
  selector.value=workspaceProject!==status.projectId?status.projectId||'':projects.some(([value])=>value===previous)?previous:status.projectId||'';
  workspaceProject=status.projectId||'';
  $('workDirectoryState').textContent=status.workDirectory||'';
  updateWorkspaceActions();
}
async function applyWorkspace(input){
  if(workspaceBusy||saving)return;
  if(dirty){workspaceMessage('请先保存或撤销页面上的设置，再切换工作目录。');return;}
  if(!backendReady||!backendWorkspace){workspaceMessage('后台尚未加载工作目录选择功能，请重启桥接后重试。');return;}
  workspaceBusy=true;updateActions();workspaceMessage('正在切换工作目录…');
  try{
    const result=await api('/api/workspace',{method:'POST',headers:{'If-Match':revision},body:JSON.stringify(input)});
    revision=result.revision;
    workspaceMessage(`已切换工作目录：${result.directory}`);
    try{acceptState(await api('/api/state'),{replaceDraft:true});}catch{workspaceMessage(`已切换工作目录：${result.directory}。暂时无法读取状态，请重试连接。`);}
  }catch(error){workspaceMessage(error.message);}
  finally{workspaceBusy=false;updateActions();}
}
$('workDirectory').addEventListener('input',updateWorkspaceActions);
$('useWorkProject').addEventListener('click',()=>applyWorkspace({project:$('workProject').value}));
$('applyWorkDirectory').addEventListener('click',()=>applyWorkspace({directory:$('workDirectory').value}));
$('chooseWorkDirectory').addEventListener('click',async()=>{
  if(workspaceBusy)return;
  if(!backendWorkspace){workspaceMessage('后台尚未加载文件夹选择器，请重启桥接或手动填写路径。');return;}
  workspaceBusy=true;updateActions();workspaceMessage('请在本机文件夹选择器中选择目录，或取消选择。');
  try{
    const result=await api('/api/workspace/pick',{method:'POST',body:'{}',timeout:130000});
    if(result.directory){$('workDirectory').value=result.directory;workspaceMessage('已选择文件夹，点击「使用此目录」生效。');}
    else workspaceMessage('已取消选择，当前工作目录保持不变。');
  }catch(error){workspaceMessage(error.message);}
  finally{workspaceBusy=false;updateActions();}
});
async function api(url,{timeout=10000,...options}={}){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch(url,{...options,signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...options.headers}});
    let result;try{result=await response.json();}catch(error){if(error.name==='AbortError')throw error;throw new Error(`后台返回了无法读取的内容（HTTP ${response.status}）。`);}
    if(!response.ok){const error=new Error(result.error||`请求失败（HTTP ${response.status}）。`);error.field=result.field;error.providerId=result.providerId;error.status=response.status;throw error;}return result;
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
  }
  $('projectState').textContent=s.project;$('workState').textContent=s.workReady?'工作引擎已就绪。':'工作引擎会在收到任务时启动。';
  renderWorkspace(s);
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
  providerEditor.refreshKeyState();
}
function acceptState(data,{replaceDraft=false}={}){
  const firstLoad=!savedDraft;
  const changed=revision&&revision!==data.revision;
  current=data.config;hasToken=data.hasOnebotToken;baseDefault=data.baseDefault??baseDefault;hasApiKey=!!data.hasApiKey;hasVoiceKey=!!data.hasVoiceKey;lastSavedAt=data.savedAt;backendReady=true;backendUnlimitedRecords=data.capabilities?.unlimitedDistillRecords===true;backendCompanion=data.capabilities?.companionOptimizations===true;
  providerFlags=data.hasProviderKeys||{};backendProviders=data.capabilities?.providerManagement===true;
  backendWorkspace=data.capabilities?.workspaceSelection===true;
  backendNativeOmni=data.capabilities?.nativeOmni===true;
  backendKimi=data.capabilities?.kimiK3Support===true;
  backendCodexSearch=data.capabilities?.codexSearch===true;
  backendSearch=data.capabilities?.nativeSearch===true;updateProvider();
  $('companionUpgrade').hidden=backendCompanion&&backendNativeOmni;
  const scope=$('memoryScope'),scopes=[`private:${current.ownerQQ}`,...current.groups.map(g=>`group:${g}`)];
  if(JSON.stringify([...scope.options].map(v=>v.value))!==JSON.stringify(scopes)){const old=scope.value;scope.replaceChildren(...scopes.map(v=>new Option(v.startsWith('private:')?'你的私聊':`群 ${v.slice(6)}`,v)));if(scopes.includes(old))scope.value=old;if(activeView==='socialMemory')loadMemory();else updateMemoryActions();}
  if(!savedDraft||replaceDraft||(!dirty&&!saving&&changed)){
    revision=data.revision;savedDraft=configToDraft(current);fillDraft(savedDraft);dirty=false;
  }else if(changed&&!saving&&noticeKind!=='error')notify('后台配置已在其他页面更新。你的输入仍然保留；请点击「撤销修改」载入最新配置后再编辑。','warning');
  $('setupGuide').hidden=!!current.ownerQQ;
  if(firstLoad&&!current.ownerQQ)selectView('connection',{scroll:false});
  renderToken();renderStatus(data);$('retry').hidden=true;updateActions();
  workbench.state(data);
}
async function refresh(){
  if(refreshing||saving)return;refreshing=true;
  try{const data=await api('/api/state');const wasOffline=!backendReady;acceptState(data);if(wasOffline&&noticeKind==='error')notify('已重新连接后台，输入的设置已保留。','success');}
  catch(error){backendReady=false;$('badge').textContent='后台未连接';$('badge').className='badge offline';$('retry').hidden=false;saveFeedback=false;notify(error.message,'error');updateActions();}
  finally{if(!backendReady)workbench.offline();refreshing=false;}
}
async function save(){
  if(saving||workspaceBusy)return;clearErrors();if(!current||!backendReady){notify('请先连接后台，再保存设置。','error');return;}
  const draft=readDraft();let config;
  if(!backendProviders){notify('后台尚未加载供应商管理更新，请重启桥接后保存，输入会保留。','warning');return;}
  if(draft.chatProvider==='codex'&&!(draft.voiceMode==='omni'&&draft.voiceEnabled)&&draft.searchEnabled&&!backendCodexSearch){notify('后台尚未加载 Codex 搜索更新，请重启桥接后保存，输入会保留。','warning');return;}
  if(isKimiK3({provider:draft.chatProvider,model:draft.apiModel.trim()})&&!backendKimi){notify('后台尚未加载 Kimi 更新，请重启桥接后保存，输入会保留。','warning');return;}
  if((draft.searchEnabled||draft.imageFollowup)&&!backendSearch){notify('后台尚未加载搜索与图片追问更新，请重启机器人桥接后再保存。输入仍然保留。','warning');return;}
  if(draft.voiceMode==='omni'&&!backendNativeOmni){notify('后台尚未加载 Omni 更新，请重启机器人桥接后再保存。输入仍然保留。','warning');return;}
  if(!backendCompanion){notify('后台尚未载入记忆和语音更新，请重启机器人桥接后再保存。你的输入仍然保留。','warning');return;}
  try{providerEditor.validate();config=buildConfig(draft,current,hasToken,hasApiKey,hasVoiceKey);}catch(error){saveFeedback=false;notify(`还没有保存：${error.message}`,'error');if(error.providerId)providerEditor.focus(error.providerId);fieldError(error.field,error.message);return;}
  saving=true;saveFeedback=false;updateActions();notify('正在保存并核对配置…');
  try{
    const result=await api('/api/config',{method:'POST',headers:{'If-Match':revision},body:JSON.stringify(config)});
    // The POST confirms the write. Readback trouble must not claim the committed save failed.
    config.onebot.accessToken='';config.chat.apiKey='';config.voice.apiKey='';current=config;hasToken=result.hasOnebotToken;hasApiKey=!!result.hasApiKey;hasVoiceKey=!!result.hasVoiceKey;revision=result.revision;lastSavedAt=result.savedAt;
    for(const p of config.modelProviders||[])p.apiKey='';providerFlags=result.hasProviderKeys||{};
    savedDraft=configToDraft(config);fillDraft(savedDraft);dirty=false;closePersonaEditor({focus:activeView==='styleSettings'});renderToken();
    try{acceptState(await api('/api/state'),{replaceDraft:true});}catch{backendReady=false;$('retry').hidden=false;}
    saveFeedback=true;renderSaveFeedback();
    {const s=lastStatus;const time=lastSavedAt?new Date(lastSavedAt).toLocaleTimeString('zh-CN',{hour12:false}):'';
    const conn=s?.qqConnected?'QQ 已连接。':s&&!s.enabled?'桥接已暂停。':s?.qqError?`QQ 尚未连接：${s.qqError}`:'QQ 尚未连接，后台会自动重试。';
    notify(`设置已保存${time?'（'+time+'）':''}，已即时生效。\n${conn}`,'success');}
    if(!backendReady)notify('配置已保存；暂时无法读取连接状态，请点击重试。','success');
    else if(result.changed===false)notify('已核对：设置没有变化，连接保持不变。\n'+(lastStatus?.qqConnected?'QQ 已连接。':lastStatus?.enabled?'QQ 尚未连接，后台会自动重试。':'桥接已暂停。'),'success');
  }catch(error){saveFeedback=false;notify(`保存失败：${error.message}`,'error');if(error.providerId)providerEditor.focus(error.providerId);fieldError(error.field,error.message);}
  finally{saving=false;updateActions();}
}
for(const id of fields){$(id).addEventListener('input',()=>{dirty=savedDraft?!draftEqual(readDraft(),savedDraft):true;updateCounter();updateProvider();const error=$(id+'Error');if(error)error.hidden=true;$(id).removeAttribute('aria-invalid');if(['chatProvider','apiBase','apiModel','apiKey','clearApiKey'].includes(id))$('testResult').textContent='';saveFeedback=false;if(noticeKind==='success')notify('');updateActions();});}
$('testChat').addEventListener('click',async()=>{
  if(testing||!current)return;clearErrors();let config;
  try{providerEditor.validate();config=buildConfig(readDraft(),current,hasToken,hasApiKey,hasVoiceKey);}catch(error){if(error.providerId)providerEditor.focus(error.providerId);fieldError(error.field,error.message);$('testResult').textContent=error.message;return;}
  testing=true;$('testChat').disabled=true;$('testResult').textContent='正在测试模型连接…';
  try{const result=await api('/api/chat/test',{method:'POST',body:JSON.stringify({chat:config.chat,modelProviders:config.modelProviders}),timeout:isKimiK3(config.chat)?80000:20000});$('testResult').textContent=result.message;}
  catch(error){$('testResult').textContent='连接测试失败：'+error.message;fieldError(error.field,error.message);}
  finally{testing=false;$('testChat').disabled=false;}
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
    const names=Object.keys(data.presets);$('presetCount').textContent=String(names.length);$('presetEmpty').textContent='还没有预设。点击「新建人设」写下设定，再保存到预设库。';
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
      for(const [act,label,cls] of [['load','载入编辑','secondary'],['delete','删除预设','text-button danger']]){
        const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.act=act;if(cls)button.className=cls;
        actions.append(button);
      }
      card.append(head,preview,actions);
      return card;
    }));
  }catch{list.replaceChildren();$('presetCount').textContent='—';$('presetEmpty').hidden=false;$('presetEmpty').textContent='预设暂时未能载入，请点击「刷新列表」重试。';}
}
$('presetList').addEventListener('click',async event=>{
  const button=event.target.closest('button[data-act]');
  if(!button)return;
  const name=button.closest('.preset-card')?.dataset.name;
  if(!name)return;
  const act=button.dataset.act;
  if(act==='load'){
    button.disabled=true;
    try{
      const data=await api('/api/personas');
      if(!data.presets[name])throw new Error('这个预设已被删除，请刷新列表。');
      openPersonaEditor({text:data.presets[name].text||'',name,opener:button});
    }catch(error){notify(error.message,'error');}finally{button.disabled=false;}
  }else if(act==='delete'){
    const go=await showModal('删除预设',`确定删除预设「${name}」？只删存档，不影响正在用的人设。`,{kind:'warning',confirmLabel:'删除',cancelLabel:'取消'});
    if(!go)return;
    try{await api('/api/personas',{method:'DELETE',body:JSON.stringify({name})});await loadPresets();notify(`已删除预设「${name}」。`,'info');}
    catch(error){notify(error.message,'error');}
  }
});
$('personaPresetSave').addEventListener('click',async()=>{
  const name=$('personaPresetName').value.trim(),button=$('personaPresetSave');
  if(!name){$('personaEditorStatus').textContent='请先填写预设名称。';$('personaPresetName').focus();return;}
  const text=$('persona').value;
  button.disabled=true;
  $('personaEditorStatus').textContent='正在保存预设…';
  try{
    const data=await api('/api/personas');
    if(Object.hasOwn(data.presets,name)&&!await showModal('替换同名预设',`预设「${name}」已经存在，要用当前编辑内容替换吗？`,{confirmLabel:'替换预设',cancelLabel:'取消'})){$('personaEditorStatus').textContent='已取消替换，原预设保持不变。';return;}
    await api('/api/personas',{method:'POST',body:JSON.stringify({name,text})});
    await loadPresets();
    $('personaEditorStatus').textContent=`已保存预设「${name}」。如需用于机器人，请点击「保存并应用」。`;
  }catch(error){$('personaEditorStatus').textContent=`预设未保存：${error.message}`;}finally{button.disabled=false;if(activeView==='styleSettings'&&!$('personaEditor').hidden)button.focus();}
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
async function loadDistillSessions(){
  const select=$('distillSession');
  try{
    const data=await api('/api/distill/sessions');
    select.replaceChildren(new Option('全部会话（全部记录）',''),...data.sessions.map(session=>new Option(`${session.is_group?'群':'私聊'} ${session.session_id}（${session.n} 条）`,String(session.session_id))));
  }catch{select.replaceChildren(new Option('全部会话（全部记录）',''));}
}
$('distill').addEventListener('toggle',()=>{if($('distill').open&&$('distillSession').options.length<=1)loadDistillSessions();});
$('distillSources').addEventListener('change',event=>{
  if(event.target.name!=='distillImport'||!event.target.checked)return;
  $('distillSource').value=event.target.value;$('distillSource').dispatchEvent(new Event('change'));
});
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
  $('distillRun').textContent=active?'正在处理记录…':'导入并检查记录';
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
  }catch(error){$('distillError').textContent=error.message;$('distillError').hidden=false;button.disabled=false;button.textContent='导入并检查记录';}
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
  if(!notes){notify('蒸馏结果框是空的：请先导入记录并完成分析，或把内容粘贴进蒸馏结果框再并入。','error');return;}
  const rows=notes.split(/\r?\n/).map(line=>line.trim());
  const memoryStart=rows.indexOf('[回忆]');
  const memories=memoryStart<0?[]:rows.slice(memoryStart+1).filter(line=>line&&!/^\[.*\]$/.test(line));
  if(memories.length&&!$('distillMemoryReviewed').checked){notify('请先核对 [回忆] 内容，改掉不准确的经历，再勾选确认。','warning');$('distillNotes').focus();return;}
  const base=stripDistillBlock($('persona').value)??$('persona').value;
  const background=$('distillBackground').value.trim();
  const bgBlock=background?`\n[背景]\n${background.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).join('\n')}`:'';
  openPersonaEditor();
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
  try{acceptState(await api('/api/state'),{replaceDraft:true});clearErrors();closePersonaEditor({focus:activeView==='styleSettings'});saveFeedback=false;notify('已恢复到最新保存的设置。','info');}catch(error){notify(error.message,'error');}
});
$('retry').addEventListener('click',refresh);
function clock(at){return new Date(at).toLocaleString('zh-CN',{hour12:false});}
function kindLabel(k){return {chat:'私聊',group:'群聊',voice:'语音识别',outreach:'主动考虑',work:'工作',distill:'蒸馏',test:'连接测试',quality:'模型验证'}[k]||k;}
function textRows(id,rows){$(id).replaceChildren(...(rows.length?rows:['暂无记录']).map(text=>{const row=document.createElement('div');row.textContent=text;return row;}));}
function renderMemory(data){
  const m=data.mood;$('moodState').textContent=`当前语气：${m.valence<-.15?'沉静':m.valence>.15?'愉快':'平常'}；聊天活跃度：${Math.round(m.energy*100)}%。状态会随对话变化，并逐渐回到平常。`;
  const list=(id,items,kind)=>{
    $(id).replaceChildren(...items.slice().reverse().map(item=>{
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
  list('memoryList',data.memories,'memory');list('topicList',data.topics,'topic');$('topicCount').textContent=String(data.topics.length);textRows('memorySummary',data.summary.map(v=>`${clock(v.at)} · ${v.name||'你'}：${v.text}`));
  textRows('memoryRecent',(data.recent||[]).length?data.recent.map(v=>`${clock(v.at)} · ${v.role==='assistant'?'机器人':v.name||'你'}：${v.text}`):['这个聊天暂无已保留的对话。先进行闲聊，再刷新查看。']);
}
let memoryRequest=0,memoryLoading=false,memoryEditing=false,loadedMemoryScope='';
function updateMemoryActions(){
  const blocked=memoryLoading||memoryEditing||loadedMemoryScope!==$('memoryScope').value;
  for(const button of $('socialMemory').querySelectorAll('button'))button.disabled=button.id==='memoryRefresh'?memoryEditing:blocked;
  $('memoryScope').disabled=memoryEditing;
}
async function loadMemory(){
  if(!current||memoryEditing)return;
  const request=++memoryRequest,scope=$('memoryScope').value;memoryLoading=true;loadedMemoryScope='';
  $('memoryNotice').textContent='正在读取所选聊天的记忆和最近对话…';$('moodState').textContent='';
  $('topicNotice').textContent='正在读取话题…';$('memoryEditNotice').textContent='';$('topicCount').textContent='—';
  for(const id of ['memoryList','topicList','memorySummary','memoryRecent'])textRows(id,['正在读取…']);updateMemoryActions();
  try{
    const result=await api('/api/social?scope='+encodeURIComponent(scope));
    if(request!==memoryRequest||scope!==$('memoryScope').value)return;
    renderMemory(result.data);loadedMemoryScope=scope;
    $('topicNotice').textContent='';
    $('memoryNotice').textContent=`已读取${scope.startsWith('private:')?'你的私聊':`群 ${scope.slice(6)}`}的记忆和最近对话。`;
  }catch(error){
    if(request!==memoryRequest||scope!==$('memoryScope').value)return;
    $('memoryNotice').textContent='读取失败：'+error.message;
    $('topicNotice').textContent='话题未能加载，请点击上方「刷新记忆」重试。';
    for(const id of ['memoryList','topicList','memorySummary','memoryRecent'])textRows(id,['暂未读取到内容，请点击「刷新记忆」重试。']);
  }finally{if(request===memoryRequest){memoryLoading=false;updateMemoryActions();}}
}
async function editMemory(body){
  const feedback=$(body.kind==='topic'?'topicNotice':'memoryEditNotice');
  if(memoryLoading||memoryEditing||loadedMemoryScope!==$('memoryScope').value){feedback.textContent='请先等待读取完成；读取失败时请点击「刷新记忆」。';return;}
  if(!body.remove&&(!String(body.text||'').trim()||String(body.text).length>300)){feedback.textContent='请填写 1–300 个字符后再添加或保存。';if(!body.id)$(body.kind==='topic'?'topicText':'memoryText').focus();return;}
  const scope=$('memoryScope').value;
  memoryEditing=true;updateMemoryActions();feedback.textContent=body.remove?'正在删除…':'正在保存…';
  try{
    const result=await api('/api/social?scope='+encodeURIComponent(scope),{method:'POST',body:JSON.stringify(body)});
    if(scope!==$('memoryScope').value)return;
    renderMemory(result.data);feedback.textContent=body.remove?'已删除。':body.id?'修改已保存。':'已添加到下方列表，已自动保存。';
    if(!body.id){const input=$(body.kind==='topic'?'topicText':'memoryText');if(input.value===body.text)input.value='';if(activeView==='socialMemory')$(body.kind==='topic'?'topicList':'memoryList').firstElementChild?.scrollIntoView({block:'nearest',behavior:'auto'});}
  }
  catch(error){feedback.textContent='没有保存：'+error.message;}
  finally{memoryEditing=false;if(scope!==$('memoryScope').value)loadMemory();else updateMemoryActions();}
}
$('memoryScope').addEventListener('change',loadMemory);$('memoryRefresh').addEventListener('click',loadMemory);
$('memoryAdd').addEventListener('click',()=>editMemory({kind:'memory',text:$('memoryText').value}));
$('topicAdd').addEventListener('click',()=>editMemory({kind:'topic',text:$('topicText').value}));
const workbench=createWorkbench({$,api,getView:()=>activeView,getDraft:()=>{providerEditor.validate();return buildConfig(readDraft(),current,hasToken,hasApiKey,hasVoiceKey);}});
await refresh();
loadPresets();
function fitSaveDock(){const dock=document.querySelector('.save-dock');if(!dock)return;const pad=dock.offsetHeight+48;document.documentElement.style.setProperty('--dock-pad',pad+'px');}
window.addEventListener('resize',fitSaveDock);
if(typeof ResizeObserver==='function')new ResizeObserver(fitSaveDock).observe(document.querySelector('.save-dock'));
fitSaveDock();
document.querySelectorAll('[data-file-input]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.fileInput).click()));
try{const savedNotes=localStorage.getItem('distillNotesDraft');if(savedNotes)$('distillNotes').value=savedNotes;}catch{}
$('distillNotes').addEventListener('input',()=>{$('distillMemoryReviewed').checked=false;try{localStorage.setItem('distillNotesDraft',$('distillNotes').value);}catch{}});
try{const savedBackground=localStorage.getItem('distillBackgroundDraft');if(savedBackground)$('distillBackground').value=savedBackground;}catch{}
$('distillBackground').addEventListener('input',()=>{try{localStorage.setItem('distillBackgroundDraft',$('distillBackground').value);}catch{}});
await syncDistillJob().catch(()=>{});
setInterval(refresh,4000);
