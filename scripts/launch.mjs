import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ROOT, STATE, loadConfig } from '../src/config.mjs';
const config=loadConfig(),tokenFile=path.join(STATE,'console-token');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||major===22&&minor<13){console.error('需要 Node.js 22.13 或更新版本。请安装后重新启动。');process.exit(1);}
if(!fs.existsSync(tokenFile))fs.writeFileSync(tokenFile,randomBytes(32).toString('hex'),{mode:0o600});
const token=fs.readFileSync(tokenFile,'utf8').trim();
const base=`http://127.0.0.1:${config.consolePort}`;
function openPage(){
  const url=`${base}/#${token}`;
  const cmd=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  const child=spawn(cmd,args,{windowsHide:true,stdio:'ignore'});child.on('error',()=>console.log(`请手动打开 ${url}`));child.unref();
}
try {
  const result=await fetch(base+'/api/state',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1500)});
  if(result.ok){console.log('桥接已经在运行，正在打开控制页。');if(!process.argv.includes('--no-browser'))openPage();process.exit(0);}
  console.error(`端口 ${config.consolePort} 已被其他服务或另一份桥接占用。请关闭该服务，或在 config.json 修改 consolePort。`);process.exit(1);
}catch{}
if(!fs.existsSync(path.join(ROOT,'node_modules/ws'))||!fs.existsSync(path.join(ROOT,'node_modules/@picocss/pico'))) {
  const command=process.platform==='win32'?'npm.cmd':'npm';
  const result=spawnSync(command,['ci','--no-audit','--no-fund'],{cwd:ROOT,stdio:'inherit',shell:process.platform==='win32',windowsHide:true});
  if(result.status!==0){console.error('依赖安装失败，请在此目录手动运行 npm ci。');process.exit(1);}
}
const { main }=await import('../src/server.mjs');
try{await main();if(!process.argv.includes('--no-browser'))openPage();}catch(error){console.error(`启动失败：${error.code==='EADDRINUSE'?'控制页端口已被占用，请关闭旧程序或修改 config.json 的 consolePort':error.message}`);process.exit(1);}
