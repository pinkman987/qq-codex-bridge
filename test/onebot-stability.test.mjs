import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {OneBot,parseMessage} from '../src/onebot.mjs';

test('OneBot ignores malformed frames and confirms login before reporting QQ connected',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const bot=new OneBot(()=>{});t.after(()=>{bot.close();server.close();});
  let confirm;const handshake=new Promise(resolve=>{confirm=resolve;});
  server.on('connection',socket=>socket.on('message',raw=>{
    const packet=JSON.parse(raw);
    if(packet.action==='get_login_info'){
      for(const value of ['null','[null]','"text"','not-json'])socket.send(value);
      confirm(()=>socket.send(JSON.stringify({echo:packet.echo,status:'ok',retcode:0,data:{user_id:999999}})));
    }
  }));
  const ready=once(bot,'ready');bot.connect({wsUrl:`ws://127.0.0.1:${server.address().port}`,accessToken:''});
  const acknowledge=await handshake;
  assert.equal(bot.connected,false);await assert.rejects(bot.call('send_private_msg',{}),/尚未连接/);
  acknowledge();await ready;assert.equal(bot.connected,true);assert.equal(bot.selfId,'999999');
  assert.equal(parseMessage(null),null);assert.equal(parseMessage([null]),null);
  assert.equal(parseMessage({post_type:'message',message_type:'private',self_id:999999,user_id:123456,message:[null,{type:'text',data:{text:'hello'}}]}).text,'hello');
});

test('failed login probe does not leave a false connected state and clears the old account',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const bot=new OneBot(()=>{});t.after(()=>{bot.close();server.close();});
  server.on('connection',socket=>socket.on('message',raw=>{const packet=JSON.parse(raw);socket.send(JSON.stringify({echo:packet.echo,status:'failed',retcode:100,data:null}));}));
  bot.connect({wsUrl:`ws://127.0.0.1:${server.address().port}`,accessToken:''});
  await once(bot.socket,'close');assert.equal(bot.connected,false);assert.equal(bot.selfId,'');assert.match(bot.lastError,/登录状态确认失败/);
});

test('OneBot immediately cleans pending requests on synchronous and callback send failures',async()=>{
  for(const synchronous of [true,false]){
    const bot=new OneBot(()=>{});bot.connected=true;
    bot.socket={readyState:WebSocket.OPEN,send(_packet,callback){if(synchronous)throw new Error('transport failure');callback(new Error('transport failure'));}};
    await assert.rejects(bot.call('send_private_msg',{}),/发送失败/);assert.equal(bot.pending.size,0);
  }
});
