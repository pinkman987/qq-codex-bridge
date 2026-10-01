import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
export function textSegments(text) { return [{ type: 'text', data: { text: String(text) } }]; }
export function connectionError(error) {
  if(error.code==='ECONNREFUSED')return 'OneBot 服务未启动或端口未监听，请检查 SnowLuma 的账号和 WebSocket 服务。';
  if(/Unexpected server response: (401|403)/.test(error.message||''))return '连接令牌被拒绝，请使用 SnowLuma 正向 WebSocket 的 accessToken。';
  if(error.code==='ETIMEDOUT'||/timed? ?out/i.test(error.message||''))return 'OneBot 连接超时，请检查地址、端口和服务状态。';
  return 'OneBot 连接失败，请检查地址、服务状态和令牌。';
}
export function parseMessage(event) {
  if(!event||typeof event!=='object'||Array.isArray(event))return null;
  if (event.post_type !== 'message' || !['group','private'].includes(event.message_type) || event.sub_type === 'group_self') return null;
  // Do not reinterpret images, CQ codes, XML, forwarded messages or attachments as commands.
  const segments = Array.isArray(event.message) ? event.message.filter(s=>s&&typeof s==='object'&&!Array.isArray(s)) : [{ type: 'text', data: { text: String(event.raw_message ?? event.message ?? '').replace(/\[CQ:[^\]]*\]/g,'') } }];
  const text = segments.filter(s=>s.type==='text').map(s=>s.data?.text??'').join('').trim();
  const faces = segments.filter(s=>s.type==='face').map(s=>String(s.data?.id??'')).filter(Boolean);
  const images = segments.filter(s=>s.type==='image').map(s=>s.data?.url||s.data?.file||'').filter(Boolean);
  const voice = segments.some(s=>s.type==='record'||s.type==='voice');
  const mentioned = segments.some(s=>s.type==='at' && String(s.data?.qq)===String(event.self_id)) ||
    (typeof event.message==='string' && new RegExp(`\\[CQ:at,qq=${String(event.self_id).replace(/[^0-9]/g,'')}\\]`).test(event.message));
  const multimodal = faces.length>0||images.length>0||voice;
  if ((!text && !multimodal) || String(event.user_id)===String(event.self_id)) return null;
  return { type:event.message_type, user:String(event.user_id), group:String(event.group_id??''), id:String(event.message_id??''),
    name:String(event.sender?.card || event.sender?.nickname || event.user_id).slice(0,60).replace(/[\r\n]/g,' '), text:text.slice(0,12000), mentioned, faces, images, voice };
}
export class OneBot extends EventEmitter {
  constructor(log) { super(); this.log=log; this.pending=new Map(); this.seq=0; this.generation=0; this.connected=false; }
  connect(config) {
    this.close(); const generation=++this.generation; this.config=config;
    const attempt=()=>{
      if(generation!==this.generation) return;
      const headers = config.accessToken ? { Authorization:`Bearer ${config.accessToken}` } : {};
      const ws = this.socket = new WebSocket(config.wsUrl,{headers,handshakeTimeout:10000,maxPayload:1024*1024});
      const current=()=>generation===this.generation&&this.socket===ws;
      ws.on('open',()=>{
        if(!current())return;
        this.connected=false;this.selfId='';this.lastError='';this.log('OneBot 已连接，正在确认 QQ 登录状态');
        this.call('get_login_info',{},{allowUnverified:true}).then(info=>{
          if(!current()||ws.readyState!==WebSocket.OPEN)return;
          const id=String(info?.user_id??'');if(!/^\d{5,15}$/.test(id))throw new Error('QQ 登录信息无效');
          this.selfId=id;this.connected=true;this.log('QQ 连接已建立');this.emit('ready',info);
        }).catch(()=>{if(current()&&ws.readyState===WebSocket.OPEN){this.lastError='QQ 登录状态确认失败，请检查 SnowLuma 的账号登录和 OneBot 服务。';ws.terminate();}});
      });
      ws.on('message',raw=>{
        if(!current())return;
        let msg; try {msg=JSON.parse(raw.toString());} catch {return;}
        if(!msg||typeof msg!=='object'||Array.isArray(msg))return;
        if(msg.echo && this.pending.has(msg.echo)) { const p=this.pending.get(msg.echo); clearTimeout(p.timer); this.pending.delete(msg.echo); msg.status==='ok' || msg.retcode===0 ? p.resolve(msg.data) : p.reject(new Error('OneBot 动作失败')); }
        else this.emit('event',msg);
      });
      ws.on('error',error=>{ if(current())this.lastError=connectionError(error); });
      ws.on('close',()=>{ if(!current())return; this.connected=false;this.selfId=''; this.rejectPending(); this.log(this.lastError || 'QQ 连接中断，稍后自动重连'); this.retry=setTimeout(attempt,5000); });
    }; attempt();
  }
  call(action,params,{allowUnverified=false}={}) {
    if((!this.connected&&!allowUnverified) || this.socket?.readyState!==WebSocket.OPEN) return Promise.reject(new Error('QQ 尚未连接'));
    const echo=`bridge-${++this.seq}`;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(echo);reject(new Error('OneBot 响应超时'));},15000);
      this.pending.set(echo,{resolve,reject,timer});
      const failed=error=>{if(error&&this.pending.has(echo)){clearTimeout(timer);this.pending.delete(echo);reject(new Error('OneBot 消息发送失败，请检查 QQ 连接'));}};
      try{this.socket.send(JSON.stringify({action,params,echo}),failed);}catch(error){failed(error);}
    });
  }
  async send(target,text) {
    const action=target.type==='group'?'send_group_msg':'send_private_msg';
    const id=target.type==='group'?{group_id:Number(target.group)}:{user_id:Number(target.user)};
    for (const chunk of String(text).match(/[\s\S]{1,1800}/gu) || []) await this.call(action,{...id,message:textSegments(chunk)});
  }
  rejectPending() { for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('QQ 连接中断'));} this.pending.clear(); }
  close() { ++this.generation; clearTimeout(this.retry); this.connected=false;this.selfId='';this.lastError=''; this.rejectPending(); if(this.socket){this.socket.removeAllListeners();this.socket.on('error',()=>{});this.socket.terminate();this.socket=null;} }
}
