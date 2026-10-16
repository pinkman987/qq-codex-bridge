export function createWorkbench({$,api,getDraft,getView}){
  let configReady=false,capable=false,history=[],signature='',requestId=null,tasks=[],selected=null,loading=false,acting=false,taskCache='';
  const labels={running:'进行中',waiting:'等你确认',stopping:'正在停止',completed:'已完成',failed:'未完成',cancelled:'已停止',interrupted:'已中断'};
  const isActive=t=>['running','waiting','stopping'].includes(t?.status);
  const date=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
  const node=(tag,text,className)=>{const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el;};
  function playActions(){
    $('playSend').disabled=!!requestId||!configReady||!capable;
    $('playMode').disabled=$('playMemory').disabled=$('playClear').disabled=!!requestId;
    $('playStop').hidden=!requestId;$('playSend').textContent=requestId?'正在生成…':'发送测试消息';
  }
  function clear(){history=[];signature='';$('playMessages').replaceChildren(node('p','从上面发送一句「你好」，回复会显示在这里。','empty-state'));$('playStatus').textContent='已清空测试对话。';}
  function bubble(role,text){
    $('playMessages').querySelector('.empty-state')?.remove();
    const row=node('article','',`play-message ${role}`);row.append(node('strong',role==='user'?'你':'机器人'),node('p',text));$('playMessages').append(row);row.scrollIntoView({block:'nearest'});return row;
  }
  async function send(){
    if(requestId||!configReady||!capable)return;
    const text=$('playInput').value.trim();if(!text){$('playStatus').textContent='先写一句想测试的话。';$('playInput').focus();return;}
    let config;
    try{if($('playMode').value==='draft')config=getDraft();}catch(error){$('playStatus').textContent=error.message;return;}
    const nextSignature=JSON.stringify({mode:$('playMode').value,config:config||savedRevision,memory:$('playMemory').checked});
    if(signature&&signature!==nextSignature)clear();signature=nextSignature;
    const id=requestId=crypto.randomUUID(),mode=$('playMode').value;playActions();
    const row=bubble('user',text);$('playStatus').textContent=`正在使用${mode==='draft'?'页面草稿':'已应用设置'}回复…`;
    try{
      const result=await api('/api/playground',{method:'POST',timeout:200000,body:JSON.stringify({id,mode,text,history:history.slice(-20),includeMemory:$('playMemory').checked,...(config?{config}:{})})});
      history.push({role:'user',content:text},{role:'assistant',content:result.text});history=history.slice(-20);
      bubble('assistant',result.text);if($('playInput').value.trim()===text)$('playInput').value='';
      $('playStatus').textContent=`${mode==='draft'?'草稿试聊':'已应用设置试聊'} · ${(result.durationMs/1000).toFixed(1)} 秒`;
    }catch(error){row.remove();$('playStatus').textContent=error.message;}
    finally{requestId=null;playActions();}
  }
  $('playSend').addEventListener('click',send);
  $('playClear').addEventListener('click',clear);
  $('playMode').addEventListener('change',clear);$('playMemory').addEventListener('change',clear);
  $('playInput').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();send();}});
  $('playStop').addEventListener('click',async()=>{
    if(!requestId)return;const id=requestId;$('playStop').disabled=true;
    try{await api('/api/playground/cancel',{method:'POST',body:JSON.stringify({id})});if(requestId===id)$('playStatus').textContent='已请求停止生成…';}
    catch(error){$('playStatus').textContent=error.message;}finally{$('playStop').disabled=false;}
  });
  function detail(){
    const task=tasks.find(t=>t.id===selected);$('taskDetail').hidden=!task;if(!task)return;
    $('taskTitle').textContent=task.title;$('taskBadge').textContent=labels[task.status]||task.status;$('taskBadge').dataset.status=task.status;
    $('taskMeta').textContent=`${task.project} · ${date(task.startedAt)}\n${task.directory}`;$('taskPhase').textContent=task.detail;
    $('taskRequest').textContent=task.request;
    $('taskEvents').replaceChildren(...task.events.map(e=>{const row=node('li','');row.append(node('time',date(e.at)),node('span',e.text));return row;}));
    $('taskFiles').replaceChildren(...(task.files.length?task.files:['尚无引擎报告的文件改动。']).map(file=>node('li',file)));
    $('taskResultBlock').hidden=!task.result;$('taskResult').textContent=task.result;
    $('taskControls').hidden=!isActive(task);$('taskStop').disabled=acting||task.status==='stopping';$('taskSendSupplement').disabled=acting||task.status!=='running';
  }
  function render(){
    $('tasksStatus').textContent=tasks.length?`${tasks.filter(isActive).length} 个进行中 · ${tasks.length} 条任务记录 · 自动更新`:'还没有工作任务。按上方说明在 QQ 发起第一个任务。';
    if(!tasks.some(t=>t.id===selected)){selected=tasks[0]?.id||null;$('taskSupplement').value='';$('taskActionStatus').textContent='';}
    const key=JSON.stringify(tasks.map(t=>[t.id,t.status,t.title,t.detail]));
    if(taskCache!==key){
      const focused=document.activeElement?.dataset.taskId;taskCache=key;
      $('taskList').replaceChildren(...tasks.map(task=>{
        const button=node('button','','task-card');button.type='button';button.dataset.taskId=task.id;button.append(node('span',labels[task.status]||task.status,'tag'),node('strong',task.title),node('small',`${task.project} · ${date(task.startedAt)}`));
        button.addEventListener('click',()=>{if(selected!==task.id){selected=task.id;$('taskSupplement').value='';$('taskActionStatus').textContent='';}render();});return button;
      }));
      if(focused)[...$('taskList').children].find(el=>el.dataset.taskId===focused)?.focus({preventScroll:true});
    }
    [...$('taskList').children].forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.taskId===selected)));detail();
  }
  async function refresh(){
    if(loading||!configReady||!capable)return;loading=true;$('tasksRefresh').disabled=true;
    try{const result=await api('/api/tasks');tasks=result.tasks;render();}
    catch(error){$('tasksStatus').textContent=`${error.message} 任务列表暂未更新。`;}
    finally{loading=false;$('tasksRefresh').disabled=false;}
  }
  async function action(kind){
    if(acting||!selected)return;
    const id=selected,text=$('taskSupplement').value.trim();
    if(kind==='supplement'&&!text){$('taskActionStatus').textContent='请先填写补充要求。';$('taskSupplement').focus();return;}
    acting=true;detail();$('taskActionStatus').textContent='正在提交…';
    try{const result=await api(`/api/tasks/${kind}`,{method:'POST',timeout:35000,body:JSON.stringify({id,text})});tasks=result.tasks;
      if(selected===id){$('taskActionStatus').textContent=kind==='stop'?'已请求停止，请等待任务状态更新。':'补充要求已提交。';if(kind==='supplement'&&$('taskSupplement').value.trim()===text)$('taskSupplement').value='';}render();
    }catch(error){if(selected===id)$('taskActionStatus').textContent=error.message;}
    finally{acting=false;detail();}
  }
  $('tasksRefresh').addEventListener('click',refresh);$('taskStop').addEventListener('click',()=>action('stop'));$('taskSendSupplement').addEventListener('click',()=>action('supplement'));
  let savedRevision='';
  return {refresh,state(data){configReady=true;savedRevision=data.revision;capable=data.capabilities?.workbench===true;playActions();if(!capable){$('playStatus').textContent=$('tasksStatus').textContent='后台尚未加载新功能，请重启桥接程序。';}else if(getView()==='taskCenter')refresh();},offline(){configReady=false;playActions();}};
}
