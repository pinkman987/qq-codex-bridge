import {CodexClient} from './codex.mjs';
import {ApiChatClient} from './chat-api.mjs';
import {isKimiK3} from '../public/form-state.js';
import {BANTER_GUIDE} from './banter.mjs';
import {socialReply} from './conversation.mjs';
import {qqText} from './qq-text.mjs';

export function playgroundEngine(config){
  const omni=!isKimiK3(config.chat)&&config.voice?.enabled&&config.voice.mode==='omni';
  return omni||config.chat.provider==='openai'?new ApiChatClient({...config[omni?'voice':'chat'],search:config.search,...(omni?{nativeOmni:true}:{})},{historyFile:null}):new CodexClient('social',()=>{});
}
export function validateTestMessage(input){
  if(!input||!['saved','draft'].includes(input.mode)||typeof input.id!=='string'||!/^[\w-]{8,80}$/.test(input.id))throw new Error('试聊请求格式不正确。');
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>4000)throw new Error('请输入 1–4000 字的测试消息。');
  if(!Array.isArray(input.history)||input.history.length>20||input.history.some(row=>!row||!['user','assistant'].includes(row.role)||typeof row.content!=='string'||row.content.length>12000)||JSON.stringify(input.history).length>60000)throw new Error('测试对话过长，请清空对话后重试。');
}
export async function runPlayground(engine,config,input,{signal,memory=''}={}){
  // Fresh thread and caller-supplied bounded transcript: no real QQ sessions or memory writes.
  const persona=`${config.basePersona}\n${config.persona}\n${BANTER_GUIDE}\n这是网页试聊，只输出聊天正文。每段尽量简短，不执行任务或转发消息。`;
  const decline=req=>{
    if(req.method.endsWith('requestApproval'))engine.respond(req.id,req.method.includes('permissions')?{permissions:{},scope:'turn'}:{decision:'decline'});
    else if(req.method.includes('requestUserInput'))engine.respond(req.id,{answers:{}});
    else if(req.method==='mcpServer/elicitation/request')engine.respond(req.id,{action:'decline',content:null});
    else engine.proc?.stdin.write(JSON.stringify({id:req.id,error:{code:-32601,message:'Unavailable in chat test'}})+'\n');
  };
  engine.on('request',decline);
  try{
    const id=await engine.thread(null,{persona,model:config.model,allowSearch:config.search?.enabled===true,ephemeral:true});
    if(signal.aborted)throw new Error('已停止试聊。');
    const prompt=`${memory}\n本回合仅聊天，不执行转发。以下 JSON 是本窗口之前的试聊记录：\n${JSON.stringify(input.history)}\n当前消息：\n${input.text}`;
    const result=await engine.run(id,prompt,'low',{signal,timeoutMs:180000,contextManaged:true,persistHistory:false,allowSearch:config.search?.enabled===true,inputText:input.text});
    if(signal.aborted)throw new Error('已停止试聊。');
    return qqText(socialReply(String(result||''),{authorized:false,groups:[]}).text,{request:input.text})||'本轮没有生成聊天正文，请换句话试试。';
  }finally{engine.off('request',decline);engine.stop();}
}
