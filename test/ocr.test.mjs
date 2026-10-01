import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseOcrOutput,ocrImageFile} from '../src/ocr.mjs';
import {linesFromBubbles} from '../src/distill.mjs';

const fixture=lines=>JSON.stringify({width:1080,height:41000,tiles:14,maxDimension:10000,lines});
const row=(text,x,y,width=120,height=30)=>({text,x,y,width,height,imageWidth:1080});
test('OCR returns global geometry and actual text center, collapses Chinese spacing and keeps long-image metadata',()=>{
  const result=parseOcrOutput(fixture([row('你 好',800,3000)]));
  assert.equal(result.lines[0].text,'你好');assert.equal(result.lines[0].ratio,860/1080);assert.equal(result.lines[0].y,3000);assert.equal(result.tiles,14);assert.equal(result.height,41000);
});
test('overlapping strip lines deduplicate by position while genuine repeated messages stay separate and in order',()=>{
  const result=parseOcrOutput(fixture([row('好的',200,4000),row('你好',200,2970),row('你好',201,2972),row('好的',200,6000)]));
  assert.deepEqual(result.lines.map(v=>[v.text,v.y]),[['你好',2970],['好的',4000],['好的',6000]]);
});
test('same-side bubbles separated by a vertical gap are not collapsed into one message',()=>{
  const result=parseOcrOutput(fixture([row('今晚',120,100),row('吃啥',120,140),row('先聊点别的',120,280)]));
  assert.deepEqual(linesFromBubbles(result.lines),['对方：今晚吃啥','对方：先聊点别的']);
});
test('a timestamp separates same-side messages and wrapped aligned text keeps the right sender',()=>{
  const lines=[{...row('这是一段长的回复',500,100,500),ratio:.7},{...row('换行之后',500,140,60),ratio:.49},{...row('16:20',500,240),ratio:.5},{...row('下一句',500,340),ratio:.8}];
  assert.deepEqual(linesFromBubbles(lines),['我：这是一段长的回复换行之后','我：下一句']);
});
test('bad OCR output is a recognition error rather than zero usable chat lines',()=>{
  assert.throws(()=>parseOcrOutput(''),/格式异常/);assert.throws(()=>parseOcrOutput('{}'),/缺少尺寸/);
  assert.equal(parseOcrOutput(fixture([])).lines.length,0);
});
test('OCR wrapper uses bounded strips, real word rectangles, hidden process and removes its temporary script',async()=>{
  let scriptPath;
  const result=await ocrImageFile('fixture.png',{details:true,execFileImpl:(command,args,options,callback)=>{
    scriptPath=args[args.indexOf('-File')+1];const script=fs.readFileSync(scriptPath,'utf8');
    assert.match(script,/MaxImageDimension/);assert.match(script,/transform.Bounds/);assert.match(script,/word.BoundingRect/);assert.doesNotMatch(script,/line.BoundingRect/);assert.match(script,/coreTop/);assert.equal(options.windowsHide,true);
    callback(null,fixture([row('你好',100,100)]),'');
  }});
  assert.equal(result.lines.length,1);assert.equal(fs.existsSync(scriptPath),false);
});
test('PowerShell errors cannot be mistaken for a partial success and timeouts are actionable',async()=>{
  let scriptPath;
  await assert.rejects(()=>ocrImageFile('fixture.png',{execFileImpl:(command,args,options,callback)=>{scriptPath=args[args.indexOf('-File')+1];callback(null,fixture([]),'识别引擎错误');}}),/识别引擎错误/);
  assert.equal(fs.existsSync(scriptPath),false);
  await assert.rejects(()=>ocrImageFile('fixture.png',{execFileImpl:(command,args,options,callback)=>callback({killed:true},'','')}),/超时/);
});
