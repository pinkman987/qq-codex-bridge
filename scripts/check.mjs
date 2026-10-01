import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, defaults, validateConfig } from '../src/config.mjs';
validateConfig(defaults);
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.(mjs|js)$/.test(file))files.push(file);}}
for(const dir of ['src','scripts','public','test'])walk(path.join(ROOT,dir));
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error(`${path.relative(ROOT,file)}: ${result.stderr}`);}
const html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
if(new Set(ids).size!==ids.length)throw new Error('Duplicate HTML element IDs');
const app=fs.readFileSync(path.join(ROOT,'public/app.js'),'utf8');
for(const match of app.matchAll(/\$\('([^']+)'\)/g))if(!ids.includes(match[1]))throw new Error(`Missing HTML element: ${match[1]}`);
const version=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
if(!html.includes(`v${version}`))throw new Error('Console version mismatch');
for(const file of ['src/codex.mjs','src/server.mjs'])if(!fs.readFileSync(path.join(ROOT,file),'utf8').includes(`version:'${version}'`))throw new Error(`${file} version mismatch`);
console.log(`配置模板、${files.length} 个脚本语法、界面元素和版本检查通过。`);
