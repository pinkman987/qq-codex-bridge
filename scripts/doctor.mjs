import { CodexClient } from '../src/codex.mjs';
import { loadConfig } from '../src/config.mjs';
import { inspectEnvironment } from '../src/environment.mjs';
const clients=[];
try{
  const config=loadConfig(),report=inspectEnvironment(config);
  for(const check of report.checks)console.log(`[${check.level}] ${check.message}`);
  if(!report.ok)process.exitCode=1;
  if(process.argv.includes('--engines')){
    const roles=config.chat.provider==='codex'?['social']:[];
    if(process.argv.includes('--work'))roles.push('work');
    if(!roles.length)console.log('兼容接口聊天：跳过 Codex。模型连通性请在网页测试（会调用模型）。');
    for(const role of roles){
      const client=new CodexClient(role,()=>{});clients.push(client);await client.start();
      if(config.model&&!client.models.some(m=>m.model===config.model))throw new Error('配置中的 Codex 模型不在可用模型列表');
      console.log(`${role==='social'?'聊天':'工作'}引擎启动、登录和模型目录检查通过。`);
    }
  }else console.log('仅完成本机检查。完整 Codex 检查：npm run doctor -- --engines --work');
  console.log('此检查不调用模型、不发送 QQ 消息、不回显密钥。');
}catch(error){console.error(`检查失败：${error.message}`);process.exitCode=1;}
finally{for(const client of clients)client.stop();}
