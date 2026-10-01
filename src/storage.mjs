import fs from 'node:fs';
import path from 'node:path';

export function readState(file,fallback){
  if(!fs.existsSync(file))return structuredClone(fallback);
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid object');
    return value;
  }catch{
    throw new Error(`本地状态文件 ${path.basename(file)} 无法读取或格式损坏。请先备份 config.json 和 state/，修复该文件后重启；程序不会自动清空原数据。`);
  }
}
