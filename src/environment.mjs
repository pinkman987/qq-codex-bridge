import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { findCodex } from './codex.mjs';
import { findSnowlumaDb } from './distill.mjs';

export function supportedNode(version=process.versions.node){
  const [major,minor]=String(version).split('.').map(Number);
  return major>22 || major===22&&minor>=13;
}
// Local checks only: never request model output, connect QQ, or read chat rows.
export function inspectEnvironment(config){
  const checks=[];
  const add=(id,level,message)=>checks.push({id,level,message});
  add('node',supportedNode()?'ok':'error',`Node.js ${process.versions.node}${supportedNode()?'':'；需要 22.13 或更新版本'}`);
  add('platform',process.platform==='win32'?'ok':'warning',process.platform==='win32'?'Windows 本地部署；支持系统 OCR':'当前平台仅支持核心服务，截图 OCR 需要 Windows 10/11');
  if(config.chat.provider==='codex'){
    try{findCodex();add('codex','ok','找到 Codex CLI；运行 npm run doctor -- --engines 可核对登录和协议');}
    catch(error){add('codex','error',error.message);}
    const cache=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'models_cache.json');
    add('catalog',fs.existsSync(cache)?'ok':'warning',fs.existsSync(cache)?'Codex 模型目录存在':'尚未生成 Codex 模型目录；登录后首次启动会尝试初始化目录');
  }else add('codex','info','兼容接口聊天不需要 Codex；需要工作任务时再安装并登录');
  try{
    const db=findSnowlumaDb(undefined,config.snowlumaDbPath);
    if(!db)add('database','info','未发现 SnowLuma 消息库；可配置路径，或使用粘贴、文件和截图导入');
    else{
      const connection=new DatabaseSync(db,{readOnly:true});
      try{connection.prepare('select session_id,is_group,timestamp,sequence,data from messages limit 0').all();}
      finally{connection.close();}
      add('database','ok','SnowLuma 消息库存在且结构兼容（仅检查表结构）');
    }
  }catch(error){add('database','warning',`消息库不可用：${error.message}`);}
  add('owner',config.ownerQQ?'ok':'warning',config.ownerQQ?'已设置管理员 QQ':'首次使用：在账号连接填写管理员 QQ，机器人账号在 SnowLuma 登录');
  add('bridge',config.enabled?'info':'warning',config.enabled?'桥接已启用；连接情况见页面在线状态':'桥接已暂停；完成账号和模型设置后启用并保存');
  return {ok:checks.every(c=>c.level!=='error'),checks};
}
