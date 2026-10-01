import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractChatLog, listSessions, distillPrompt, notesToPersona, normalizePastedLog, parseStructuredLog, linesFromBubbles, chunkLines, observationPrompt, synthesizePrompt } from '../src/distill.mjs';

function tempDb(t,rows){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-distill-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'messages.db');
  const db=new DatabaseSync(file);
  db.exec('create table messages (message_hash integer primary key, is_group integer not null, session_id integer not null, sequence integer not null, event_name text not null, timestamp integer not null, data text not null)');
  const insert=db.prepare('insert into messages (message_hash,is_group,session_id,sequence,event_name,timestamp,data) values (?,?,?,?,?,?,?)');
  rows.forEach((row,index)=>insert.run(index+1,row.isGroup?1:0,row.session,index+1,'ev',row.timestamp,JSON.stringify(row.event)));
  db.close();
  return file;
}
const incoming=(user,nickname,text)=>({post_type:'message',message_type:'group',user_id:user,message:[{type:'text',data:{text}}],sender:{user_id:user,nickname}});
const outgoing=text=>({post_type:'message_sent',message_type:'group',user_id:999999,message:[{type:'text',data:{text}}],sender:{user_id:999999,nickname:'bot'}});

test('extractChatLog labels senders, drops CQ-only lines and keeps time order',t=>{
  const file=tempDb(t,[
    {isGroup:true,session:1,timestamp:100,event:incoming(11,'阿伟','今晚吃啥')},
    {isGroup:true,session:1,timestamp:110,event:outgoing('随便')},
    {isGroup:true,session:1,timestamp:120,event:incoming(12,'小美','[CQ:face,id=1]')},
    {isGroup:true,session:1,timestamp:130,event:incoming(11,'阿伟','火锅走起')},
  ]);
  const lines=extractChatLog(file,{selfId:999999});
  assert.deepEqual(lines,['阿伟：今晚吃啥','机器人：随便','阿伟：火锅走起']);
  const sessions=listSessions(file);
  assert.equal(sessions.length,1);assert.equal(sessions[0].n,4);assert.equal(sessions[0].is_group,1);
});
test('extractChatLog can narrow to one session',t=>{
  const file=tempDb(t,[
    {isGroup:true,session:1,timestamp:100,event:incoming(11,'阿伟','群里好')},
    {isGroup:false,session:2,timestamp:110,event:incoming(11,'阿伟','私聊好')},
  ]);
  assert.deepEqual(extractChatLog(file,{sessionId:2}),['阿伟：私聊好']);
});

test('SnowLuma reads all records by default and keeps optional explicit limits',t=>{
  const file=tempDb(t,Array.from({length:310},(_,i)=>({isGroup:true,session:i%2+1,timestamp:i,event:incoming(11,'阿伟',`消息${i}`)})));
  const all=extractChatLog(file);assert.equal(all.length,310);
  assert.equal(all[0],'阿伟：消息0');assert.equal(all.at(-1),'阿伟：消息309');
  const session=extractChatLog(file,{sessionId:1});assert.equal(session.length,155);
  assert.equal(session[0],'阿伟：消息0');assert.equal(session.at(-1),'阿伟：消息308');
  const limited=extractChatLog(file,{sessionId:1,limit:12});assert.equal(limited.length,12);
  assert.equal(limited.at(-1),'阿伟：消息308');
});
test('distillPrompt asks for second-person rules and examples; notes block is mergeable',()=>{
  const prompt=distillPrompt(['阿伟：今晚吃啥','机器人：随便']);
  assert.match(prompt,/第二人称/);assert.match(prompt,/阿伟：今晚吃啥/);
  const block=notesToPersona('短句优先\n[示例]\n走起');
  assert.match(block,/【从真实聊天记录蒸馏的风格】/);
  assert.match(block,/短句优先\n\[示例\]\n走起/);
});
test('normalizePastedLog rebuilds wechat merged-forward blocks into name: content lines',()=>{
  const wechat=['؋的聊天记录','؋','2026年9月29日 16:22','怎么说干啥呢','؋','2026年9月29日 16:41','[表情]','','聊天记录'];
  assert.deepEqual(normalizePastedLog(wechat.join('\n')),['؋：怎么说干啥呢','؋：[表情]']);
  const plain=['阿伟：今晚吃啥','小美：火锅'];
  assert.deepEqual(normalizePastedLog(plain.join('\n')),plain);
  const noTs=['随便一行','没有时间的记录'];
  assert.deepEqual(normalizePastedLog(noTs.join('\n')),noTs);
  const shortTs=['阿伟','16:22','冲','小美','昨天 22:01','冲个屁'];
  assert.deepEqual(normalizePastedLog(shortTs.join('\n')),['阿伟：冲','小美：冲个屁']);
});
test('normalizePastedLog skips OCR-garbled date lines',()=>{
  const ocr=['凵的聊天记录','2025年 g 启2g 日1 5：22','阿伟：今晚吃啥','2025年 g 启2g 日1 5：41','小美：火锅'];
  assert.deepEqual(normalizePastedLog(ocr.join('\n')),['阿伟：今晚吃啥','小美：火锅']);
});
test('distillPrompt focuses on target nicknames when given',()=>{
  const focused=distillPrompt(['阿伟：冲','小美：冲个屁'],['小美']);
  assert.match(focused,/只分析这些昵称的说话风格：小美/);
  assert.match(focused,/只作为对话上下文参考/);
  const unfocused=distillPrompt(['阿伟：冲']);
  assert.equal(unfocused.includes('只分析这些昵称'),false);
});
test('distillPrompt asks for shared memories section',()=>{
  const prompt=distillPrompt(['阿伟：上次那家店火锅真香']);
  assert.match(prompt,/^\[回忆\]$/m.test(prompt.split('\n').find(l=>l.includes('3. 再输出一行 [回忆]')))?/3. 再输出一行 \[回忆\]/:/3. 再输出一行 \[回忆\]/);
  assert.match(prompt,/共同回忆与共识/);
  assert.match(prompt,/写成「你」也亲历过的记忆/);
});
test('parseStructuredLog reads chatlog-keeper style JSON and header CSV',()=>{
  const json=JSON.stringify([
    {ts:1,'chat_uid':'c1',sender_name:'阿伟',content:'今晚吃啥',is_self:false},
    {ts:2,'chat_uid':'c1',sender_name:'me',content:'火锅',is_self:true},
    {ts:3,'chat_uid':'c1',sender_name:'阿伟',content:'',is_self:false},
  ]);
  assert.deepEqual(parseStructuredLog(json),['阿伟：今晚吃啥','我：火锅']);
  const csv='NickName,Content,CreateTime\r\n阿伟,"锅里下, 先煮肉",1790672503\r\n小美,走起,1790672510\r\n';
  assert.deepEqual(parseStructuredLog(csv),['阿伟：锅里下, 先煮肉','小美：走起']);
  assert.equal(parseStructuredLog('阿伟：今晚吃啥\n小美：走起'),null);
  assert.equal(parseStructuredLog('[not json'),null);
});
test('linesFromBubbles groups same-side OCR lines and labels both speakers',()=>{
  const ocr=[
    {text:'2026年9月29日 16:22',ratio:0.5},
    {text:'今晚',ratio:0.15},
    {text:'吃啥',ratio:0.15},
    {text:'火锅',ratio:0.85},
    {text:'走起',ratio:0.8},
  ];
  assert.deepEqual(linesFromBubbles(ocr),['对方：今晚吃啥','我：火锅走起']);
  assert.deepEqual(linesFromBubbles(ocr,{selfSide:'left',otherName:'小美'}),['我：今晚吃啥','小美：火锅走起']);
});
test('distillPrompt carries administrator background as facts',()=>{
  const prompt=distillPrompt(['阿伟：冲'],['阿伟'],'对方是我大学室友，认识六年了');
  assert.match(prompt,/管理员提供的背景信息/);
  assert.match(prompt,/对方是我大学室友，认识六年了/);
  assert.equal(distillPrompt(['阿伟：冲']).includes('管理员提供的背景信息'),false);
});
test('chunkLines splits evenly and two-stage prompts carry guards',()=>{
  const lines=Array.from({length:250},(_,i)=>`阿伟：消息${i}`);
  const chunks=chunkLines(lines,100);
  assert.deepEqual(chunks.map(c=>c.length),[100,100,50]);
  const obs=observationPrompt(chunks[0],['阿伟'],'室友');
  assert.match(obs,/S: 风格观察/);assert.match(obs,/M: 回忆候选/);assert.match(obs,/室友/);
  const syn=synthesizePrompt(['S: 爱说哦哦','M: 去过青岛'],['阿伟']);
  assert.match(syn,/合并为最终人设素材/);
  assert.match(syn,/不得以孤立单字或数字开头/);
  assert.match(syn,/S: 爱说哦哦/);
});
test('parseStructuredLog reads JSONL, compact sender-index and object sender shapes',()=>{
  const jsonl='{"sender_name":"阿伟","content":"冲"}\n{"sender_name":"小美","content":"冲个屁"}\n';
  assert.deepEqual(parseStructuredLog(jsonl),['阿伟：冲','小美：冲个屁']);
  const arkme=JSON.stringify({senders:[{name:'阿伟'},{name:'小美'}],messages:[{s:0,c:'走'},{s:1,c:'走起'}]});
  assert.deepEqual(parseStructuredLog(arkme),['阿伟：走','小美：走起']);
  const objSender=JSON.stringify([{sender:{nickname:'阿伟'},text:'在吗'},{is_self:true,text:'在'}]);
  assert.deepEqual(parseStructuredLog(objSender),['阿伟：在吗','我：在']);
});
test('parseStructuredLog reads WeFlow exports with isSend self flag and session fallback',()=>{
  const weflow=JSON.stringify({
    weflow:{version:'1.0.3'},
    session:{wxid:'wxid_other',nickname:'走',remark:'小红',displayName:'小红',type:'私聊'},
    messages:[
      {content:'[表情包]',isSend:1,senderUsername:'wxid_me',senderDisplayName:'小明'},
      {content:'冲',isSend:1,senderUsername:'wxid_me',senderDisplayName:'小明'},
      {content:'冲个屁',isSend:0,senderUsername:'wxid_other',senderDisplayName:'小红'},
      {content:'系统消息无isSend',senderUsername:'wxid_other'},
    ],
  });
  assert.deepEqual(parseStructuredLog(weflow),['我：[表情包]','我：冲','小红：冲个屁','小红：系统消息无isSend']);
});
