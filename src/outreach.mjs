import { readState } from './storage.mjs';
import fs from 'node:fs';
import { atomicWrite } from './config.mjs';

export function calendar(now,timezone='Asia/Shanghai'){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
  const part=type=>parts.find(p=>p.type===type).value;
  return {day:`${part('year')}-${part('month')}-${part('day')}`,hour:Number(part('hour'))};
}
export function outreachGate(config,state,{now,connected,busy,privateMode,ignoreSchedule=false}){
  const o=config.outreach;
  if(!config.enabled||!o.enabled)return '主动私聊已关闭';
  if(!connected)return '等待 QQ 连接';
  if(privateMode!=='chat')return '工作模式中，主动私聊暂停';
  if(busy)return '正在处理消息，稍后再考虑';
  const {day,hour}=calendar(now,o.timezone);
  if(hour<o.startHour||hour>=o.endHour)return '安静时段中';
  if(state.awaitingReply)return '等待你回复，不再追发';
  if(!state.history.some(m=>m.role==='user'))return '先和它聊几句，才有话题可接';
  const daily=state.day===day?state:{sentToday:0,checksToday:0};
  if(daily.sentToday>=o.maxPerDay)return '今天的主动消息次数已用完';
  if(!ignoreSchedule&&daily.checksToday>=o.maxPerDay*3)return '今天的主动判断次数已用完';
  if(now-Math.max(state.lastIncomingAt,state.lastOutgoingAt)<o.idleMinutes*60000)return '等待安静时长达到设置';
  if(!ignoreSchedule&&state.lastCheckAt&&now-state.lastCheckAt<o.checkMinutes*60000)return '等待下一次考虑';
  return '';
}
export class OutreachState {
  constructor(file,ownerQQ){
    this.file=file;const saved=readState(file,null);
    this.value=saved?.ownerQQ===ownerQQ?saved:{ownerQQ,history:[],lastIncomingAt:0,lastOutgoingAt:0,lastCheckAt:0,awaitingReply:false,day:'',sentToday:0,checksToday:0,privateMode:null};
  }
  save(){atomicWrite(this.file,this.value);}
  incoming(text,now,chat){
    const s=this.value;s.lastIncomingAt=now;s.awaitingReply=false;
    if(chat){s.history.push({role:'user',content:text.slice(0,1000)});s.history=s.history.slice(-20);}
    this.save();
  }
  replied(text,now,{proactive=false,timezone='Asia/Shanghai'}={}){
    const s=this.value;s.lastOutgoingAt=now;s.history.push({role:'assistant',content:text.slice(0,1000)});s.history=s.history.slice(-20);
    if(proactive){this.rollDay(now,timezone);s.sentToday++;s.awaitingReply=true;}
    this.save();
  }
  rollDay(now,timezone){const day=calendar(now,timezone).day;if(this.value.day!==day){this.value.day=day;this.value.sentToday=0;this.value.checksToday=0;}}
  reserve(now,timezone){this.rollDay(now,timezone);this.value.lastCheckAt=now;this.value.checksToday++;this.save();}
  reset(){const s=this.value;s.history=[];s.awaitingReply=false;s.lastCheckAt=0;this.save();}
  mode(mode){this.value.privateMode=mode;this.save();}
}
