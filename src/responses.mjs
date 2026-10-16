// Completed Responses only: never expose reasoning, raw errors or partial results.
const safeErrors=new WeakSet();
function failure(message,status){const error=new Error(message);if(status)error.status=status;safeErrors.add(error);return error;}
export async function responsesCompletion(config,messages,{fetchImpl=fetch,signal,timeoutMs=300000,search=false,onUsage=()=>{},onSearch=()=>{}}={}){
  const timeout=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  const endpoint=config.baseUrl.replace(/\/+$/,'').replace(/\/(?:chat\/completions|responses)$/,'');
  const input=messages.map(message=>({role:message.role,content:typeof message.content==='string'?message.content:message.content.map(part=>{
    if(part.type==='text')return {type:message.role==='assistant'?'output_text':'input_text',text:part.text};
    if(part.type==='image_url'&&message.role==='user')return {type:'input_image',image_url:part.image_url.url};
    throw failure('Kimi 当前仅接收文字和图片');
  })}));
  let response;
  try{
    response=await fetchImpl(endpoint+'/responses',{method:'POST',redirect:'error',signal:combined,headers:{'Content-Type':'application/json',...(config.apiKey?{Authorization:`Bearer ${config.apiKey}`}:{})},body:JSON.stringify({model:config.model,input,stream:false,store:false,enable_thinking:true,max_output_tokens:4096,...(search?{tools:[{type:'web_search'}]}:{})})});
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw failure(`Kimi 接口返回 HTTP ${response.status}，请核对模型权限与服务地址`,response.status);}
    const reader=response.body?.getReader();if(!reader)throw failure('Kimi 返回空响应');
    const chunks=[];let bytes=0;
    const read=()=>new Promise((resolve,reject)=>{const abort=()=>reject(failure('Kimi 请求已取消'));if(combined.aborted)return abort();combined.addEventListener('abort',abort,{once:true});reader.read().then(resolve,reject).finally(()=>combined.removeEventListener('abort',abort));});
    try{while(true){const row=await read();if(row.done)break;bytes+=row.value.length;if(bytes>2*1024*1024)throw failure('Kimi 响应过大');chunks.push(Buffer.from(row.value));}}finally{await reader.cancel().catch(()=>{});}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('Kimi 返回无效 JSON');}
    if(combined.aborted)throw failure('Kimi 请求已取消');
    if(data.status!=='completed'||!Array.isArray(data.output))throw failure('Kimi 响应未完整完成，未发送半截答案');
    if(data.output.some(item=>item.type==='function_call'))throw failure('Kimi 请求了未开放的工具，已拦截');
    const web=data.output.filter(item=>item.type==='web_search_call');
    if(web.some(item=>item.status!=='completed'))throw failure('Kimi 联网检索未完成，请重试');
    const text=data.output.filter(item=>item.type==='message'&&item.role==='assistant'&&(!item.status||item.status==='completed')).flatMap(item=>item.content||[]).filter(item=>item.type==='output_text'&&typeof item.text==='string').map(item=>item.text).join('\n').trim();
    if(!text||text.length>32000)throw failure('Kimi 没有返回有效完整文本');
    const usage=data.usage;onUsage(Number.isFinite(usage?.input_tokens)&&Number.isFinite(usage?.output_tokens)?{input:usage.input_tokens,output:usage.output_tokens}:null);
    const reported=usage?.x_tools?.web_search?.count;
    const count=Number.isInteger(reported)&&reported>=0?reported:web.length;
    if(!search&&count>0)throw failure('未授权本回合联网检索');
    onSearch({count,verified:count>0});
    return text;
  }catch(error){
    if(signal?.aborted)throw new Error('聊天已停止');
    if(timeout.aborted)throw new Error(`Kimi 分析超时（${Math.ceil(timeoutMs/1000)}秒），请稍后重试`);
    if(safeErrors.has(error))throw error;
    throw new Error('无法连接 Kimi 服务，请检查服务地址与网络');
  }
}
