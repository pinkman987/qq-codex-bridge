import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const LIMIT=12_000_000;
export function imageBytes(input){
  let bytes;
  if(Buffer.isBuffer(input))bytes=input;
  else if(typeof input?.base64==='string'){
    const encoded=input.base64.replace(/^data:image\/[\w.+-]+;base64,/, '');
    if(encoded.length>Math.ceil(LIMIT/3)*4||!encoded||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4!==0)throw new Error('图片编码无效或过大');
    bytes=Buffer.from(encoded,'base64');
  }else{
    const file=typeof input==='string'?input:input?.file;
    if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('未取得可解码的图片文件');
    const stat=fs.statSync(file);if(!stat.isFile()||stat.size>LIMIT)throw new Error('图片文件过大');
    bytes=fs.readFileSync(file);
  }
  if(!bytes.length||bytes.length>LIMIT)throw new Error('图片文件过大');
  return bytes;
}

export async function decodeImage(input,{maxFrames=24}={}){
  try{
    const bytes=imageBytes(input),meta=await sharp(bytes,{animated:true,limitInputPixels:32_000_000}).metadata();
    if(!['gif','webp','png','jpeg','avif'].includes(meta.format))throw new Error('format');
    const pages=meta.pages||1,height=meta.pageHeight||meta.height;
    if(pages>400||!meta.width||!height||meta.width*height*pages>32_000_000)throw new Error('size');
    const delays=Array.from({length:pages},(_,i)=>Math.max(10,meta.delay?.[i]||100));
    const duration=delays.reduce((a,b)=>a+b,0);
    if(pages>1&&duration>60000)throw new Error('duration');
    // Decode the complete first cycle before choosing frames; do not use a GIF thumbnail.
    const {data,info}=await sharp(bytes,{animated:true,limitInputPixels:32_000_000}).timeout({seconds:15}).resize({width:768,height:768,fit:'inside',withoutEnlargement:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const frameHeight=info.height/pages;
    if(!Number.isInteger(frameHeight))throw new Error('pages');
    const frameBytes=info.width*frameHeight*info.channels;
    const selected=new Set();
    if(pages<=maxFrames)for(let i=0;i<pages;i++)selected.add(i);
    else{
      const uniform=Math.ceil(maxFrames/2);
      for(let i=0;i<uniform;i++)selected.add(Math.round(i*(pages-1)/(uniform-1)));
      const changes=[];
      for(let i=1;i<pages;i++){
        let score=0;const stride=Math.max(1,Math.floor(frameBytes/2048));
        for(let j=0;j<frameBytes;j+=stride)score+=Math.abs(data[i*frameBytes+j]-data[(i-1)*frameBytes+j]);
        changes.push({i,score});
      }
      changes.sort((a,b)=>b.score-a.score);
      for(const {i}of changes){if(selected.size>=maxFrames)break;selected.add(i);}
    }
    const parts=[];let elapsed=0;const times=delays.map(delay=>{const at=elapsed;elapsed+=delay;return at;});
    for(const i of [...selected].sort((a,b)=>a-b)){
      const jpeg=await sharp(data.subarray(i*frameBytes,(i+1)*frameBytes),{raw:{width:info.width,height:frameHeight,channels:info.channels}}).flatten({background:'#ffffff'}).jpeg({quality:82}).toBuffer();
      if(pages>1)parts.push({type:'text',text:`动图画面 ${i+1}/${pages}，时间 ${(times[i]/1000).toFixed(2)}秒。`});
      parts.push({type:'image_url',image_url:{url:`data:image/jpeg;base64,${jpeg.toString('base64')}`}});
    }
    return {parts,animated:pages>1,note:pages>1?`动图一轮共${pages}帧、${(duration/1000).toFixed(2)}秒；已完成整轮解码，提供${selected.size}帧，覆盖开头、结尾和明显变化。${selected.size<pages?'属于抽帧，可能漏掉瞬时动作，不声称逐帧看完。':'本轮全部帧已按顺序附上。'}先综合动作、字幕变化及结尾，再根据当前问题回答，不只点评第一帧。`:'当前图片已直接附上'};
  }catch{throw new Error('图片或动图解码失败，可能文件不可读、损坏，或超过12MB/400帧/60秒/3200万像素限制');}
}

export async function prepareImage(source,file,onebot){
  if(typeof source!=='string')throw new Error('图片来源无效');
  if(path.isAbsolute(source))return decodeImage(source);
  if(/^data:image\/[\w.+-]+;base64,/.test(source))return decodeImage({base64:source});
  if(file){
    try{const result=await onebot.call('get_image',{file});return await decodeImage(result);}catch{}
  }
  if(/^https?:\/\//i.test(source)){
    const url=new URL(source);
    if(url.username||url.password)throw new Error('图片地址无效');
    if(/\.(?:gif|webp)(?:$|[?#])/i.test(source))throw new Error('动图没有取得可解码文件，请重新发送或使用原文件');
    return {parts:[{type:'image_url',image_url:{url:source}}],animated:false,note:'图片URL已附上；未取得本机可解码文件，无法确认是否包含动画。如图有动态内容，不能声称看完，请对方重发原文件。'};
  }
  return decodeImage(await onebot.call('get_image',{file:file||source}));
}
