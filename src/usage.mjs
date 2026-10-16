// Keep numeric quota fields only; never forward account identifiers or raw errors.
export function quotaSnapshot(raw,at=Date.now()){
  const buckets=raw?.rateLimitsByLimitId&&typeof raw.rateLimitsByLimitId==='object'?Object.entries(raw.rateLimitsByLimitId):raw?.rateLimits?[[raw.rateLimits.limitId||'codex',raw.rateLimits]]:[];
  const windows=[];
  for(const [index,[id,bucket]]of buckets.slice(0,8).entries())for(const key of ['primary','secondary']){
    const value=bucket?.[key];if(!value)continue;
    const numeric=v=>typeof v==='number'&&Number.isFinite(v);
    windows.push({bucket:id==='codex'?'Codex':`额度组 ${index+1}`,kind:key,
      remaining:numeric(value.usedPercent)?Math.max(0,Math.min(100,100-value.usedPercent)):null,
      minutes:numeric(value.windowDurationMins)&&value.windowDurationMins>0?value.windowDurationMins:null,
      resetsAt:numeric(value.resetsAt)&&value.resetsAt>0&&value.resetsAt<8640000000000?value.resetsAt:null});
  }
  return windows.length?{at,windows}:null;
}
function duration(minutes){
  const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),mins=Math.ceil(minutes%60);
  return [days?`${days}天`:'',hours?`${hours}小时`:'',mins?`${mins}分钟`:''].filter(Boolean).join('')||'不到1分钟';
}
export function quotaText(snapshot,now=Date.now()){
  if(!snapshot||now-snapshot.at>90000||now<snapshot.at)return '用量：暂时读取不到。';
  const rows=snapshot.windows.map(w=>{
    const label=w.minutes?`${duration(w.minutes)}额度`:w.kind==='primary'?'主要额度':'次要额度';
    const passed=w.resetsAt!==null&&w.resetsAt*1000<=now;
    const remaining=passed?'等待刷新后的数据':w.remaining===null?'剩余未知':`剩余 ${Math.round(w.remaining*10)/10}%`;
    const reset=passed?'刷新时间已到，等待服务更新':w.resetsAt===null?'刷新时间未知':`约 ${duration(Math.ceil((w.resetsAt*1000-now)/60000))}后刷新`;
    return `${w.bucket==='Codex'?'':w.bucket+' · '}${label}：${remaining}\n${reset}`;
  });
  return `账户剩余额度（共享）\n${rows.join('\n')}`;
}
