import {SocialState} from '../src/social-state.mjs';
import {ConversationQueue} from '../src/conversation.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-companion-benchmark-')),file=path.join(dir,'memory.json');
try{
  const memory=new SocialState(file),key='private:benchmark',all=[];
  memory.edit(key,{text:'我的宠物是一只白猫'},1);
  for(let n=0;n<80;n++)for(const role of ['user','assistant']){
    const text=`合成${role}第${n}轮：`+'用于控制规模的长对话样本。'.repeat(30);
    all.push({role,text});memory.append(key,role,text,n+2);
  }
  const naive=JSON.stringify(all).length,context=memory.context(key,100,'白猫今天怎么样'),payload=JSON.parse(context.split('\n')[1]);
  const queue=new ConversationQueue({delay:20,maxWait:60});let calls=0;
  for(let burst=0;burst<10;burst++)await Promise.all(Array.from({length:3},(_,n)=>queue.push('mock',{text:`合成消息${burst}-${n}`},async()=>{calls++;})));
  console.log(JSON.stringify({type:'synthetic-no-model-no-QQ',history:{turns:80,naiveFullHistoryChars:naive,boundedHistoryPayloadChars:JSON.stringify(payload).length,budget:6000,relevantFactRetrieved:payload.memories.some(v=>v.text==='我的宠物是一只白猫')},aggregation:{messages:30,bursts:10,naivePerMessageCalls:30,queuedChatCalls:calls,mergedInputs:30-calls},note:'字符数不等于token；合成输入批次数不代表真实端到端回复速度。实际token与模型耗时请看运行统计。'},null,2));
}finally{
  // This helper owns exactly this temporary file and directory; no recursive cleanup.
  if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir);
}
