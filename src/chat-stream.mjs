// Consume completed SSE text only. Reasoning and tool payloads never become QQ replies.
export async function readChatStream(response,signal){
  const reader=response.body?.getReader();if(!reader)throw new Error('模型没有返回响应流');
  const decoder=new TextDecoder();let buffer='',text='',usage=null,finished=false,reasoning=false,total=0;
  const packet=block=>{
    const raw=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n').trim();
    if(!raw)return;if(raw==='[DONE]'){finished=true;return;}
    let data;try{data=JSON.parse(raw);}catch{throw new Error('模型响应流格式无效');}
    if(data.error)throw new Error('模型响应流报告错误，请检查服务或稍后重试');
    if(data.usage)usage=data.usage;
    const choice=data.choices?.find(v=>v.index===0)||data.choices?.[0];
    const delta=choice?.delta;
    if(delta?.reasoning_content)reasoning=true;
    if(typeof delta?.content==='string')text+=delta.content;
    if(text.length>32000)throw new Error('模型回复过长，请缩短输入后重试');
    if(choice?.finish_reason){
      if(choice.finish_reason!=='stop')throw new Error('模型回复未完整结束，请重试或缩短输入');
      finished=true;
    }
  };
  const read=()=>new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('模型响应流已取消'));
    if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});
    reader.read().then(resolve,reject).finally(()=>signal?.removeEventListener('abort',abort));
  });
  try{
    while(true){
      const {done,value}=await read();if(done)break;
      total+=value.byteLength;if(total>2*1024*1024)throw new Error('模型响应流过大');
      buffer+=decoder.decode(value,{stream:true});
      let match;while((match=/\r?\n\r?\n/.exec(buffer))){const block=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);packet(block);}
    }
    buffer+=decoder.decode();if(buffer.trim())packet(buffer);
    if(signal?.aborted)throw new Error('模型响应流已取消');
    if(!finished)throw new Error('模型响应流中断，未发送不完整回复');
    return {choices:[{message:{content:text,reasoning_content:reasoning?'[reasoning omitted]':''}}],usage};
  }finally{await reader.cancel().catch(()=>{});}
}
