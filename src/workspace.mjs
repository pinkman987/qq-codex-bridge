import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const folderScript=`Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = '选择机器人工作目录'
$picker.ShowNewFolderButton = $false
try {
  if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    ConvertTo-Json -Compress -InputObject $picker.SelectedPath
  } else { Write-Output 'null' }
} finally { $picker.Dispose() }`;

export async function pickWorkDirectory({platform=process.platform,run=promisify(execFile)}={}){
  if(platform!=='win32')throw new Error('此系统请手动填写工作目录的绝对路径。');
  try{
    const {stdout}=await run('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(folderScript,'utf16le').toString('base64')],{windowsHide:true,timeout:120000,maxBuffer:16384,encoding:'utf8'});
    const directory=JSON.parse(stdout.trim());
    if(directory!==null&&typeof directory!=='string')throw new Error();
    return directory;
  }catch{throw new Error('未能完成文件夹选择，请重试或手动填写绝对路径。');}
}

export function resolveWorkDirectory(config,input){
  if(typeof input?.directory==='string'&&input.directory.trim()){
    let directory;
    try{
      const value=input.directory.trim();
      if(value.length>4096||!path.isAbsolute(value)||!fs.statSync(value).isDirectory())throw new Error();
      directory=fs.realpathSync(value);
    }catch{throw new Error('请填写已存在的文件夹绝对路径。');}
    const existing=Object.entries(config.projects).find(([,dir])=>dir===directory);
    if(existing)return {config,project:existing[0]};
    const base=path.basename(directory).replace(/[^\p{L}\p{N}_-]/gu,'_').slice(0,20)||'工作目录';
    const hash=createHash('sha256').update(directory).digest('hex');
    let name=Object.hasOwn(config.projects,base)?`${base}_${hash.slice(0,8)}`:base;
    if(Object.hasOwn(config.projects,name))name=`目录_${hash.slice(0,29)}`;
    if(Object.hasOwn(config.projects,name))throw new Error('目录名称冲突，请在工作空间中手动配置项目。');
    return {config:{...config,projects:{...config.projects,[name]:directory}},project:name};
  }
  if(typeof input?.project!=='string'||input.project&&!Object.hasOwn(config.projects,input.project))throw new Error('请选择已配置的工作目录。');
  return {config,project:input.project};
}
