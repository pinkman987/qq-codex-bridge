// QQ displays plain text: keep model output readable even if it ignores the style guide.
export const QQ_REPLY_GUIDE='【QQ 回复方式】使用纯文本，先给结论或直接回答。默认控制在约 120–220 字、4–6 条短内容，简单问题更短；只回答当前需求，不主动扩展多套目标、替代方案或背景科普。用户明确要完整方案或细节时可展开，不能删掉必要步骤、风险或不确定性。每段 1–3 行，用空行分组；比较内容按「名称\n数量：…\n要点：…」逐项列出，不用 Markdown 表格、# 标题、加粗符号或长篇引用。不主动附链接、网址或来源清单；用户本轮明确索要链接、网址、出处或追问来源时才提供真实可核对的来源，单纯要求搜索不等于要求链接。缺少会影响方案的关键信息时，先直接问用户 1–3 个简短问题，等其回答再继续，不自行补造条件或先输出整套方案；这是必要澄清，可以只提问。已有信息不重复询问，普通细节自行判断。不在结尾机械添加「任务已完成」或重复结论。';

export function wantsLinks(request=''){
  const text=String(request);
  if(/(?:不要|不用|别|无需|不必|不需要)[^。！？\n]{0,16}(?:链接|网址|来源|出处)|(?:no|without|do not|don't)\s+(?:include\s+)?(?:links?|urls?|sources?|citations?)/iu.test(text))return false;
  if(/(?:链接|网址|来源|出处)[^。！？\n]{0,8}(?:给我|发我|附上|列出|贴上|提供)|(?:信息|资料|数据)的?(?:来源|出处)/u.test(text))return true;
  return /(?:给|发|附|提供|列|带|贴|要|求|找|分享|查看|告诉我)[^。！？\n]{0,12}(?:链接|网址|来源|出处|参考文献|引用地址)|(?:来源|出处|链接|网址)(?:呢|在哪|是什么|是啥|有没有|[？?])|(?:哪里|哪儿|哪).{0,5}(?:查到|看到|来的)|^\s*(?:链接|网址|来源|出处|参考文献)\s*$|\b(?:give|show|include|add|provide|send|cite|list|share)\b[^.!?\n]{0,25}\b(?:links?|urls?|sources?|citations?|references?)\b|\b(?:sources?|links?|references?)\s*\?/iu.test(text);
}

export function qqText(value,{request=''}={}){
  const links=wantsLinks(request);
  let text=String(value||'').replace(/\r\n/g,'\n').replace(/cite[^]*/gu,'');
  // Strip link syntax, retaining the label; bare destinations are gated separately.
  text=text.replace(/!?\[([^\]]*)\]\s*\(\s*<?([^\s)]+)>?(?:\s+"[^"]*")?\s*\)/g,(_,label,url)=>links?`${label}：${url}`:label);
  if(!links)text=text.replace(/(?:https?:\/\/|www\.)[^\s<>「」『』，。！？；）]+/giu,'');
  const lines=text.split('\n'),out=[];let inCode=false;
  const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(s=>s.trim());
  const separator=line=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  for(let i=0;i<lines.length;i++){
    if(/^\s*(`{3,}|~{3,})/.test(lines[i])){inCode=!inCode;continue;}
    if(inCode){out.push(lines[i]);continue;}
    if(/^\s*(?:(?:[-*_]\s*){3,}|[—─━]{3,})\s*$/.test(lines[i])){out.push('');continue;}
    if(i+1<lines.length&&lines[i].includes('|')&&separator(lines[i+1])){
      const headers=cells(lines[i]);i+=2;
      for(;i<lines.length&&lines[i].includes('|')&&lines[i].trim();i++){
        const row=cells(lines[i]);out.push(row.map((v,j)=>j===0?v:`${headers[j]||'补充'}：${v}`).join('\n'),'');
      }
      i--;continue;
    }
    out.push(lines[i].replace(/^\s{0,3}#{1,6}\s*/,'').replace(/\s+#{1,6}\s*$/,'').replace(/^\s*[-*+]\s+/,'').replace(/\*{1,3}(\S(?:[^*\n]*?\S)?)\*{1,3}/g,'$1').replace(/__([^_\n]+)__/g,'$1').replace(/`([^`\n]+)`/g,'$1'));
  }
  return out.join('\n').replace(/\(\s*\)|（\s*）/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
