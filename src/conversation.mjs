// Preserve every printable character; the bubble count and 20-character size are soft limits.
export function splitBubbles(text,maxBubbles=4,size=20){
  const lines=String(text||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().split(/\n+/).map(s=>s.trim()).filter(Boolean).filter(line=>line!=='[SILENT]');
  const bubbles=[];
  for(const line of lines){
    const units=Array.from(new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(line),s=>s.segment);
    while(units.length){
      let end=Math.min(size,units.length);
      if(units.length>size){for(let n=end;n>=Math.ceil(size/2);n--)if(/[。！？!?；;，,\s]/.test(units[n-1])){end=n;break;}}
      bubbles.push(units.splice(0,end).join(''));
    }
  }
  if(bubbles.length>maxBubbles)bubbles.splice(maxBubbles-1,bubbles.length,bubbles.slice(maxBubbles-1).join(''));
  return bubbles;
}

export function relayIntent(text){
  const s=String(text).trim();
  if(/不要|别发|不能发|禁止|解释|什么意思|怎么用|示例|举例|引用|提示词|人设|代码|规则/.test(s))return false;
  // Only a direct instruction in this turn authorizes a relay, never a quoted marker.
  return /^(?:请|帮我|麻烦你|你)?\s*(?:(?:把|将).{1,160}?(?:发|转发|说)(?:到|给|在).{0,24}群|(?:发|转发)(?:到|给).{0,24}群|(?:在|去).{0,24}群(?:里|内|中)?(?:说|发|告诉))/.test(s);
}

const stripSilent=text=>String(text||'').split(/\r?\n/).filter(line=>line.trim()!=='[SILENT]').join('\n').trim();
export function socialReply(raw,{authorized=false,groups=[]}={}){
  const text=stripSilent(raw);
  if(!text)return {text:'',action:null};
  let data;
  try{data=JSON.parse(text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/,'$1'));}catch{return {text,action:null};}
  if(!data||Array.isArray(data)||typeof data.reply!=='string')return {text,action:null};
  const replyText=stripSilent(data.reply);
  if(!replyText)return {text:'',action:null,blocked:!!data.action};
  const a=data.action;
  const group=a?.group?String(a.group):groups.length===1?groups[0]:null;
  const valid=authorized&&a?.type==='send_group'&&groups.includes(group)&&typeof a.text==='string'&&a.text.trim()&&a.text.length<=1000;
  return {text:replyText,action:valid?{group,text:a.text.trim()}:null,blocked:!!a&&!valid};
}

// One runner per conversation. Arrivals during generation remain pending for the next turn.
export class ConversationQueue {
  constructor({delay=700,maxWait=2000,limit=30}={}){this.delay=delay;this.maxWait=maxWait;this.limit=limit;this.rooms=new Map();}
  push(key,message,runner){
    let q=this.rooms.get(key);
    if(!q){q={pending:[],running:false,runner,timer:null,first:Date.now()};this.rooms.set(key,q);}
    if(q.pending.length>=this.limit)return Promise.reject(new Error('消息队列已满，请稍后再发'));
    return new Promise((resolve,reject)=>{
      if(!q.pending.length)q.first=Date.now();q.pending.push({message,resolve,reject});q.runner=runner;
      if(!q.running)this.schedule(key,q);
    });
  }
  schedule(key,q){clearTimeout(q.timer);q.timer=setTimeout(()=>this.drain(key,q),Math.max(0,Math.min(this.delay,this.maxWait-(Date.now()-q.first))));}
  async drain(key,q){
    if(q.running||!q.pending.length)return;
    const batch=q.pending.splice(0);q.running=true;
    try{await q.runner(batch.map(v=>v.message));for(const item of batch)item.resolve();}
    catch(error){for(const item of batch)item.reject(error);}
    finally{q.running=false;if(q.pending.length)this.schedule(key,q);else if(this.rooms.get(key)===q)this.rooms.delete(key);}
  }
  cancel(key){const q=this.rooms.get(key);if(!q)return;clearTimeout(q.timer);for(const item of q.pending.splice(0))item.resolve();if(!q.running)this.rooms.delete(key);}
  clear(){for(const key of this.rooms.keys())this.cancel(key);}
  get pending(){return [...this.rooms.values()].reduce((n,q)=>n+q.pending.length,0);}
}
