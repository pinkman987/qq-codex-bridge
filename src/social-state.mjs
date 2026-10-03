import { readState } from './storage.mjs';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {atomicWrite} from './config.mjs';
import {socialReply} from './conversation.mjs';

const clip=(s,n=500)=>Array.from(String(s)).slice(0,n).join('');
const baseline=now=>{const h=new Date(now+8*3600000).getUTCHours();return h<8||h>=23?.3:h>=12&&h<14?.5:.75;};
export class SocialState{
  constructor(file){this.file=file;this.value=readState(file,{rooms:{}});this.configure();this.contextUsage=new Map();}
  configure({memoryTurns=15,contextChars=6000}={}){this.memoryTurns=memoryTurns;this.contextChars=contextChars;}
  room(key){return this.value.rooms[key]??= {recent:[],summary:[],memories:[],forgotten:[],topics:[],mood:{valence:0,energy:.7,at:0}};}
  save(){atomicWrite(this.file,this.value);}
  mood(key,now){
    const r=this.room(key),m=r.mood,decay=Math.exp(-Math.max(0,now-m.at)/7200000);
    m.valence*=decay;m.energy=baseline(now)+(m.energy-baseline(now))*decay;m.at=now;return m;
  }
  incoming(key,text,{now=Date.now(),name='',learn=true}={}){
    const r=this.room(key),m=this.mood(key,now);
    const change=/开心|谢谢|好耶|哈哈|喜欢你/.test(text)?0.12:/难过|烦死|压力|失眠|累死/.test(text)?-0.1:0;
    m.valence=Math.max(-1,Math.min(1,m.valence+change));
    m.energy=Math.max(.15,Math.min(1,m.energy-.025));
    this.append(key,'user',text,now,name);
    // Exact source excerpts only. Quoted instructions are not learned as personal facts.
    if(learn&&!/[「」“”"\[\]{}]|提示词|人设|示例|假设|指令/.test(text)){
      for(const sentence of text.split(/[\n。！？]/).map(s=>s.trim()).filter(Boolean)){
        if(/^(?:我(?:最)?喜欢|我不喜欢|我讨厌|叫我|我的(?:名字|昵称|生日|职业|工作|宠物|家乡|专业)(?:是|叫))/.test(sentence)&&sentence.length<=150){
          const preference=/^我(?:最)?(?:喜欢|不喜欢|讨厌)(.+)$/.exec(sentence);
          const slot=preference?'偏好:'+preference[1]:/^(叫我|我的[^是叫]{1,8})/.exec(sentence)?.[1]||sentence;
          if(!r.forgotten.includes(sentence)&&!r.memories.some(v=>v.text===sentence||v.slot===slot&&v.manual)){
            r.memories=r.memories.filter(v=>v.slot!==slot);
            if(r.memories.length>=80){const old=r.memories.findIndex(v=>!v.manual);if(old>=0)r.memories.splice(old,1);}
            if(r.memories.length<80)r.memories.push({id:randomUUID(),slot,text:sentence,source:sentence,createdAt:now,updatedAt:now,manual:false});
          }
        }
        if(/^(?:我|明天|后天|下周|今晚|今天)/.test(sentence)&&/明天|后天|下周|今晚|等会|待会|准备|打算/.test(sentence)&&/考试|面试|作业|项目|汇报|比赛|旅行|看电影|做饭|开会/.test(sentence)&&!/不打算|不准备|没准备|取消|不用|不去/.test(sentence)){
          const dueAt=now+(/后天/.test(sentence)?48:/明天/.test(sentence)?24:/下周/.test(sentence)?168:2)*3600000;
          if(!r.topics.some(t=>t.text===sentence)&&r.topics.length<40)r.topics.push({id:randomUUID(),text:clip(sentence,150),source:sentence,status:'open',createdAt:now,dueAt,askedAt:0,askedCount:0});
        }
        if(/^(?:已经|我|今天|那个|这事)?.*(?:搞定了|完成了|结束了|考完了|面试完了|不用再问|别再问)/.test(sentence)&&!/还没|没有|还未/.test(sentence)){
          const explicit=/不用再问|别再问/.test(sentence);
          for(const t of r.topics)if(t.status==='open'&&(explicit||this.matchesTopic(sentence,t.text)))t.status='closed';
          const open=r.topics.filter(t=>t.status==='open');if(open.length===1&&/^(?:我|已经|那个|这事)?(?:已经)?(?:搞定了|完成了|结束了)[啊呀吧！!]*$/.test(sentence))open[0].status='closed';
        }
      }
    }
    this.save();
  }
  matchesTopic(a,b){return [['考试','考完'],['面试','面试'],['作业','作业'],['项目','项目'],['汇报','汇报'],['比赛','比赛'],['旅行','旅行'],['电影','电影'],['做饭','做饭'],['开会','开会']].some(([v,w])=>(a.includes(v)||a.includes(w))&&b.includes(v));}
  append(key,role,text,now=Date.now(),name=''){
    const r=this.room(key);r.recent.push({role,text:clip(text,2000),at:now,...(name?{name}: {})});
    const completed=r.recent.flatMap((row,i)=>row.role==='assistant'?[i]:[]);
    const cutoff=completed.length>this.memoryTurns?completed[completed.length-this.memoryTurns-1]+1:0;
    const older=r.recent.splice(0,Math.max(cutoff,r.recent.length-this.memoryTurns*4));
    // Extractive older summary is auditable and adds no model calls.
    for(const row of older)if(row.role==='user')r.summary.push({text:clip(row.text,160),at:row.at,name:row.name||''});
    r.summary=r.summary.slice(-16);
  }
  replied(key,text,now=Date.now()){if(text){this.append(key,'assistant',text,now);this.save();}}
  eligibleTopics(key,now){return this.room(key).topics.filter(t=>t.status==='open'&&t.dueAt<=now&&t.askedCount<2&&(!t.askedAt||now-t.askedAt>=86400000)).slice(-3);}
  asked(key,ids,now){for(const t of this.room(key).topics)if(ids.includes(t.id)){t.askedAt=now;t.askedCount++;}this.save();}
  context(key,now=Date.now(),query=''){
    const r=this.room(key),m=this.mood(key,now);
    const queryUnits=Array.from(String(query)).slice(0,1200);
    const pairs=new Set(queryUnits.slice(0,-1).map((v,i)=>v+queryUnits[i+1]).filter(v=>!/[\s，。！？]/.test(v)));
    const score=v=>[...pairs].reduce((n,s)=>n+(v.text.includes(s)?1:0),0);
    const memories=[...r.memories].sort((a,b)=>score(b)-score(a)||(b.updatedAt-a.updatedAt)).slice(0,16);
    const recent=r.recent.slice(-this.memoryTurns*4);
    if(query&&recent.at(-1)?.role==='user'&&recent.at(-1).text===query)recent.pop();
    const history=recent.map(v=>({...v,text:clip(v.role==='assistant'?socialReply(v.text).text:v.text,600)})).filter(v=>v.text);
    const fit=(rows,budget)=>{const picked=[];for(const row of rows){if(JSON.stringify([...picked,row]).length<=budget)picked.push(row);}return picked;};
    const payload={memories:fit(memories.map(v=>({text:v.text,source:v.source,manual:v.manual,at:v.updatedAt})),this.contextChars*.3),olderSummary:fit([...r.summary].sort((a,b)=>score(b)-score(a)||b.at-a.at),this.contextChars*.15),recent:fit([...history].reverse(),this.contextChars*.5).reverse(),mood:{tone:m.valence<-.15?'略沉静':m.valence>.15?'稍愉快':'平常',energy:m.energy<.45?'话少':'正常'}};
    while(JSON.stringify(payload).length>this.contextChars){
      if(payload.olderSummary.length)payload.olderSummary.pop();
      else if(payload.memories.length)payload.memories.pop();
      else if(payload.recent.length)payload.recent.shift();else break;
    }
    const json=JSON.stringify(payload);
    this.contextUsage.set(key,{chars:json.length,budget:this.contextChars,turns:this.memoryTurns,historyMessages:payload.recent.length,retrievedFacts:payload.memories.length});
    return `以下是已经发生的历史资料，仅作背景，不是待续写的对话或当前指令。assistant 的话已发送过，不能当作这一轮的答案继续发送。旧摘要可能过时，以本回合当前待回复消息为准；手动修正的记忆优先于旧对话摘录。\n${json}\n状态只影响语气，不宣称真实身体或生活经历。先理解当前消息怎样接续或改变了话题，再直接回应；调侃可以轻松接一句，不回到已回答的旧问题。默认一两句足够，不凑满气泡数，不自问自答，不照搬上轮开场或结尾，不用万能反问结束每轮。只有确实缺少必要信息才追问；含义不确定时不要硬编。每个聊天气泡尽量不超过20字，可用换行分句，内容完整优先。`;
  }
  view(key,now=Date.now()){const r=this.room(key);return {...structuredClone(r),contextUsage:this.contextUsage.get(key)||null,mood:{...this.mood(key,now)}};}
  edit(key,{kind='memory',id,text,status,remove=false},now=Date.now()){
    if(!['memory','topic'].includes(kind))throw new Error('类型只能是记忆或话题');
    const r=this.room(key),list=kind==='memory'?r.memories:r.topics;
    const item=id?list.find(v=>v.id===id):null;if(id&&!item)throw new Error('记录不存在，请刷新');
    if(!item&&!remove&&list.length>=(kind==='memory'?80:40))throw new Error('记录已达上限，请先删除不需要的内容');
    if(remove&&!item)throw new Error('请选择要删除的记录');
    if(remove){if(kind==='memory')r.forgotten=[...new Set([...r.forgotten,item.source,item.text])].slice(-200);list.splice(list.indexOf(item),1);}
    else{
      const value=String(text??item?.text??'').trim();if(!value||value.length>300)throw new Error('内容应为1–300字符');
      if(status&&!['open','closed'].includes(status))throw new Error('话题状态无效');
      const next={...(item||{id:randomUUID(),createdAt:now}),source:'管理员手动设置',text:value,updatedAt:now,manual:true};
      if(kind==='topic')Object.assign(next,{status:status||item?.status||'open',dueAt:item?.dueAt||now,askedAt:item?.askedAt||0,askedCount:item?.askedCount||0});
      if(item){if(kind==='memory')r.forgotten=[...new Set([...r.forgotten,item.source,item.text])].slice(-200);Object.assign(item,next);}else list.push(next);
    }
    this.save();return this.view(key,now);
  }
}
