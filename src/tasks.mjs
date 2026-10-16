import {randomUUID} from 'node:crypto';
import {readState} from './storage.mjs';
import {atomicWrite} from './config.mjs';

export const activeTask = task => ['running','waiting','stopping'].includes(task?.status);
export function publicTaskText(value,config,limit=12000){
  let text=String(value||'');
  for(const key of [config?.chat?.apiKey,config?.voice?.apiKey,config?.onebot?.accessToken,...(config?.modelProviders||[]).map(p=>p.apiKey)].filter(Boolean))text=text.split(key).join('[已隐藏密钥]');
  return text.replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\/-]{12,})/gi,'[已隐藏密钥]').slice(0,limit);
}
export class TaskStore {
  constructor(file,{now=Date.now}={}){
    this.file=file;this.now=now;this.data=readState(file,{tasks:[]});
    if(!Array.isArray(this.data.tasks))throw new Error('任务记录格式不正确，请备份并修复任务状态文件。');
    let changed=false;
    for(const task of this.data.tasks)if(activeTask(task)){task.status='interrupted';task.detail='桥接程序已重启，任务未自动恢复。';task.endedAt=now();changed=true;}
    if(changed)this.save();
  }
  save(){atomicWrite(this.file,this.data);}
  create({owner,text,project,directory}){
    const task={id:randomUUID(),owner,title:text.slice(0,100),request:text,project,directory,status:'running',detail:'正在启动工作引擎',startedAt:this.now(),updatedAt:this.now(),events:[],files:[],result:''};
    this.data.tasks.unshift(task);this.data.tasks=this.data.tasks.slice(0,100);this.event(task,'已接收任务');return task;
  }
  event(task,text,patch={}){Object.assign(task,patch,{updatedAt:this.now()});task.events.push({at:this.now(),text});task.events=task.events.slice(-80);this.save();}
  list(owner){return structuredClone(this.data.tasks.filter(t=>t.owner===owner)).map(({owner,...task})=>task);}
  get(id,owner){return this.data.tasks.find(t=>t.id===id&&t.owner===owner);}
}
