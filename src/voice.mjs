import fs from 'node:fs';

// Audio comes from the authenticated local OneBot get_record API, never an arbitrary chat URL.
export function readAudio(source,{maxBytes=20*1024*1024}={}){
  let bytes;
  // SnowLuma returns the converted bytes in base64; its file field can still
  // identify the original SILK record. Prefer the converted payload, never fetch url.
  if(source&&typeof source==='object'&&Object.hasOwn(source,'base64')){
    let encoded=source.base64;
    if(typeof encoded!=='string'||encoded.length>Math.ceil(maxBytes/3)*4+128)throw new Error('语音网关返回的音频无效或过大');
    encoded=encoded.replace(/^data:audio\/[\w.+-]+;base64,/,'');
    const padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
    if(!encoded||encoded.length%4||/[^A-Za-z0-9+/]/.test(encoded.slice(0,encoded.length-padding)))throw new Error('语音网关返回的 Base64 无效');
    const size=encoded.length/4*3-padding;
    if(size<12||size>maxBytes)throw new Error('语音网关返回的音频无效或过大');
    bytes=Buffer.from(encoded,'base64');
  }else{
  const file=typeof source==='string'?source:source?.file;
  if(typeof file!=='string'||!file)throw new Error('语音网关没有返回可读音频');
  const fd=fs.openSync(file,'r');
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size<12||stat.size>maxBytes)throw new Error(maxBytes===20*1024*1024?'语音文件无效或超过20 MiB':'Omni 音频过大，请分段发送较短语音');
    bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)break;offset+=n;}
    if(offset!==bytes.length)throw new Error('语音文件读取不完整');
  }finally{fs.closeSync(fd);}
  }
  let extension;
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE')extension='wav';
  else if(bytes.toString('ascii',0,3)==='ID3'||bytes[0]===255&&(bytes[1]&224)===224)extension='mp3';
  else if(bytes.toString('ascii',0,4)==='OggS')extension='ogg';
  else if(bytes.toString('ascii',0,4)==='fLaC')extension='flac';
  else throw new Error('语音格式不支持，请确认 OneBot 能导出 WAV 或 MP3');
  return {bytes,extension};
}
export function omniAudio(file){
  // Qwen's inline Base64 audio must stay below 10 MB, including envelope margin.
  const {bytes,extension}=readAudio(file,{maxBytes:7_000_000});
  if(!['wav','mp3'].includes(extension))throw new Error('Omni 需要 OneBot 导出 WAV 或 MP3 音频');
  return {type:'input_audio',input_audio:{data:`data:;base64,${bytes.toString('base64')}`,format:extension}};
}
export function omniEvidence(raw,sources=[]){
  try{
    const data=JSON.parse(String(raw).replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/,'$1'));
    if(!Array.isArray(data.heard))return [];
    const seen=new Set();return data.heard.flatMap(row=>{
      const source=sources.find(s=>s.id===row?.id);
      if(!source||seen.has(row.id)||typeof row.text!=='string')return [];
      seen.add(row.id);const text=row.text.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,1000);
      return text?[{...source,heard:text}]:[];
    });
  }catch{return [];}
}
export async function transcribeAudio(config,file,{fetchImpl=fetch,signal,timeoutMs=30000}={}){
  if(!config?.enabled)throw new Error('语音识别尚未启用');
  if(!config.model)throw new Error('语音识别模型尚未配置');
  if(signal?.aborted)throw new Error('语音识别已取消');
  const {bytes,extension}=readAudio(file);
  const form=new FormData();form.set('model',config.model);form.set('file',new Blob([bytes]),`record.${extension}`);
  const headers=config.apiKey?{Authorization:`Bearer ${config.apiKey}`} : {};
  const timeout=AbortSignal.timeout(timeoutMs),requestSignal=signal?AbortSignal.any([timeout,signal]):timeout;
  try{
    const response=await fetchImpl(`${config.baseUrl.replace(/\/+$/,'')}/audio/transcriptions`,{method:'POST',headers,body:form,signal:requestSignal,redirect:'error'});
    if(!response.ok)throw new Error(`语音识别服务返回 HTTP ${response.status}，请检查模型、额度或密钥`);
    const result=await response.json();
    if(requestSignal.aborted)throw new Error('语音识别已取消');
    if(typeof result.text!=='string'||!result.text.trim())throw new Error('语音识别没有返回文字');
    return result.text.trim().slice(0,6000);
  }catch(error){
    if(timeout.aborted)throw new Error('语音识别超时，请重试或发送文字');
    if(signal?.aborted)throw new Error('语音识别已取消');
    if(/^语音识别/.test(error.message))throw error;
    throw new Error('语音识别请求失败，请检查服务地址和网络');
  }
}
