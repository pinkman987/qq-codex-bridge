import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, defaults } from '../src/config.mjs';

export function releaseFiles(root=ROOT){
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const files=['package.json','package-lock.json','.gitignore',...pkg.files];
  const result=[];
  const walk=relative=>{
    const file=path.join(root,relative),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())throw new Error(`Cannot release symlink: ${relative}`);
    if(stat.isDirectory()){for(const name of fs.readdirSync(file).sort())walk(path.posix.join(relative,name));}
    else if(stat.isFile())result.push(relative.replaceAll('\\','/'));
  };
  for(const item of files)walk(item.replace(/\/$/,''));
  // Workflow dotfiles are intentionally separate from npm package files.
  walk('.github');
  const unique=[...new Set(result)].sort();
  for(const file of unique){
    if(/(^|\/)(?:state|node_modules|work|dist|\.git)(?:\/|$)|(^|\/)config\.json$|\.(?:log|db|sqlite|pem|key)$/i.test(file))throw new Error(`Private file in release: ${file}`);
    const text=fs.readFileSync(path.join(root,file),'utf8');
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text))throw new Error(`Possible credential in ${file}`);
  }
  const example=JSON.parse(fs.readFileSync(path.join(root,'config.example.json'),'utf8'));
  if(example.enabled||example.ownerQQ||example.groups.length||example.onebot.accessToken||example.chat.apiKey||example.voice?.apiKey||Object.keys(example.projects).length||example.snowlumaDbPath)throw new Error('Example config contains private settings');
  return unique;
}
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
// Deterministic ZIP, stored entries; no external archiver or runtime dependency.
export function createZip(entries){
  const local=[],central=[];let offset=0;
  for(const {name,data} of entries){
    const filename=Buffer.from(name),crc=crc32(data),header=Buffer.alloc(30),index=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(0x21,12);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
    index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt16LE(0x800,8);index.writeUInt16LE(0x21,14);
    index.writeUInt32LE(crc,16);index.writeUInt32LE(data.length,20);index.writeUInt32LE(data.length,24);index.writeUInt16LE(filename.length,28);index.writeUInt32LE(offset,42);
    local.push(header,filename,data);central.push(index,filename);offset+=header.length+filename.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export function buildRelease(){
  const version=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
  const files=releaseFiles(),manifest={version,files:files.map(file=>({path:file,sha256:createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex')}))};
  const entries=files.map(file=>({name:`qq-codex-bridge/${file}`,data:fs.readFileSync(path.join(ROOT,file))}));
  entries.push({name:'qq-codex-bridge/RELEASE-MANIFEST.json',data:Buffer.from(JSON.stringify(manifest,null,2)+'\n')});
  const dir=path.join(ROOT,'dist');fs.mkdirSync(dir,{recursive:true});
  const name=`qq-codex-bridge-${version}-windows.zip`,file=path.join(dir,name),zip=createZip(entries);fs.writeFileSync(file,zip);
  fs.writeFileSync(file+'.sha256',createHash('sha256').update(zip).digest('hex')+'  '+name+'\n');
  console.log(`已生成 ${name}（${files.length} 个公开文件），配置、会话、密钥和依赖未打包。`);
  return file;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))buildRelease();
