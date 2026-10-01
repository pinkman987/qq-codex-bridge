import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findSnowlumaDb } from '../src/distill.mjs';
import { supportedNode } from '../src/environment.mjs';
import { defaults, validateConfig } from '../src/config.mjs';
import { loadSocialCatalog } from '../src/codex.mjs';
import { readState } from '../src/storage.mjs';
import { releaseFiles,createZip } from '../scripts/release.mjs';
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-release-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function db(home,relative){const file=path.join(home,relative,'data','123456','messages.db');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'test');return file;}
test('message database supports direct desktop, nested desktop, OneDrive and explicit custom locations',t=>{
  for(const relative of ['Desktop/SnowLuma-test','Desktop/parent/SnowLuma-test','OneDrive/Desktop/SnowLuma-test']){
    const home=temp(t),file=db(home,relative);assert.equal(findSnowlumaDb(home),fs.realpathSync(file));
  }
  const home=temp(t),file=db(home,'custom');assert.equal(findSnowlumaDb(home,file),file);
  assert.equal(validateConfig({...defaults,snowlumaDbPath:file}).snowlumaDbPath,file);
  assert.throws(()=>validateConfig({...defaults,snowlumaDbPath:'missing.db'}),/绝对路径/);
});
test('multiple discovered databases require explicit selection instead of reading an arbitrary account',t=>{
  const home=temp(t);db(home,'Desktop/SnowLuma-a');const selected=db(home,'Desktop/SnowLuma-b');
  assert.throws(()=>findSnowlumaDb(home),/多个/);assert.equal(findSnowlumaDb(home,selected),selected);
});
test('cold Codex catalog initializes once without a model turn and still disables tools',async t=>{
  const home=temp(t);let initialized=0;
  const catalog=await loadSocialCatalog({home,initialize:async()=>{initialized++;fs.writeFileSync(path.join(home,'models_cache.json'),JSON.stringify({models:[{slug:'test',shell_type:'bash',supports_search_tool:true}]}));}});
  assert.equal(initialized,1);assert.equal(catalog.models[0].shell_type,'disabled');assert.equal(catalog.models[0].supports_search_tool,false);
  await loadSocialCatalog({home,initialize:()=>{throw new Error('Should use existing cache');}});
});
test('corrupted persistent state fails with recovery guidance and preserves original bytes',t=>{
  const dir=temp(t),file=path.join(dir,'sessions.json');fs.writeFileSync(file,'{broken');
  assert.throws(()=>readState(file,{}),/先备份/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
  assert.deepEqual(readState(path.join(dir,'absent.json'),{}),{});
  fs.writeFileSync(file,'\uFEFF{"hello":true}');assert.deepEqual(readState(file,{}),{hello:true});
});
test('release contains docs and workflow but excludes private runtime data',()=>{
  const files=releaseFiles();assert(files.includes('LICENSE'));assert(files.includes('.github/workflows/ci.yml'));assert(files.includes('docs/QUICKSTART.md'));
  assert(!files.includes('config.json'));assert(!files.some(v=>/^(state|node_modules)\//.test(v)));
  const zip=createZip([{name:'qq-codex-bridge/中文.txt',data:Buffer.from('hello')}]);assert.equal(zip.readUInt32LE(),0x04034b50);assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);
  assert.deepEqual(zip,createZip([{name:'qq-codex-bridge/中文.txt',data:Buffer.from('hello')}]));
});
test('minimum Node version accepts 22.13 and newer and rejects older versions',()=>{
  assert(!supportedNode('22.12.0'));assert(!supportedNode('20.19.0'));assert(supportedNode('22.13.0'));assert(supportedNode('24.0.0'));
});
