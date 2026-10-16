import test from 'node:test';
import assert from 'node:assert/strict';
import {qqText,wantsLinks,QQ_REPLY_GUIDE} from '../src/qq-text.mjs';

test('QQ renders tables as separate labeled items, keeping quantities and important advice',()=>{
  const reply=qqText('### 训练安排\n\n| 动作 | 组数 | 要点 |\n|---|---|---|\n| 哑铃划船 | 3 × 12 | 背部平直 |\n| 推举 | 2 × 8 | 疼痛时停止 |\n\n**休息**：60 秒');
  assert.equal(reply,'训练安排\n\n哑铃划船\n组数：3 × 12\n要点：背部平直\n\n推举\n组数：2 × 8\n要点：疼痛时停止\n\n休息：60 秒');
  assert.equal(qqText('a | b\n3 * 4 = 12'),'a | b\n3 * 4 = 12');
  assert.equal(qqText('3 * 4 * 5 = 60'),'3 * 4 * 5 = 60');
});
test('QQ removes unsolicited markdown and bare links but preserves requested links',()=>{
  const input='结论。\n[资料](https://example.test/report)\nhttps://example.test/raw\nwww.example.test\nciteturn0search0';
  const plain=qqText(input,{request:'搜索一下，告诉我结论'});
  assert.ok(!/https?:|www\.||\]\(/u.test(plain));assert.match(plain,/结论/);
  const requested=qqText(input,{request:'把资料链接发我'});assert.match(requested,/https:\/\/example.test\/report/);
  assert.ok(!qqText(input,{request:'给我结论，不要附上链接'}).includes('https:'));
  for(const text of ['给我链接','来源是什么？','给出参考文献','show sources','链接'])assert.equal(wantsLinks(text),true,text);
  for(const text of ['查一查','分析 https://example.test','这个网址安全吗','不用给来源','no links'])assert.equal(wantsLinks(text),false,text);
});
test('QQ guidance asks for missing essentials, stays concise and avoids needless completion banners',()=>{
  assert.match(QQ_REPLY_GUIDE,/120–220/);assert.match(QQ_REPLY_GUIDE,/不主动扩展多套目标/);assert.match(QQ_REPLY_GUIDE,/先直接问用户/);assert.match(QQ_REPLY_GUIDE,/等其回答再继续/);assert.match(QQ_REPLY_GUIDE,/不能删掉必要步骤/);
});

test('QQ cleans screenshot-style decoration and wrapped links without changing code or arithmetic',()=>{
  const input='### 今日安排 ###\n\n**早餐**\n* 燕麦、鸡蛋\n----\n*午餐*\n- 米饭、蔬菜\n___\n[卫健委建议]\n(https://www.nhc.gov.cn/example.shtml)';
  const result=qqText(input,{request:'规划一下一天的饮食'});
  assert.ok(!/[*#]|----|___|https:|\]\(/u.test(result));assert.match(result,/早餐\n燕麦、鸡蛋/);assert.match(result,/午餐\n米饭、蔬菜/);
  assert.equal(qqText('```js\nconst value = 3 * 4;\n// ----\n```'),'const value = 3 * 4;\n// ----');
});
