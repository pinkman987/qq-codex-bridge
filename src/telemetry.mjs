import { readState } from './storage.mjs';
import fs from 'node:fs';
import {atomicWrite} from './config.mjs';
export class Telemetry{
  constructor(file){this.file=file;this.value=readState(file,{days:{},recent:[],decisions:[]});}
  day(now){return new Date(now+8*3600000).toISOString().slice(0,10);}
  record({kind,provider,model,durationMs,ok,usage=null},now=Date.now()){
    const key=this.day(now),d=this.value.days[key]??={calls:0,failures:0,durationMs:0,inputTokens:0,outputTokens:0,unknownUsage:0,kinds:{}};
    d.calls++;d.failures+=ok?0:1;d.durationMs+=durationMs;d.kinds[kind]=(d.kinds[kind]||0)+1;
    if(usage&&Number.isFinite(usage.input)&&Number.isFinite(usage.output)){d.inputTokens+=usage.input;d.outputTokens+=usage.output;}else d.unknownUsage++;
    this.value.recent.push({at:now,kind,provider,model,durationMs,ok,usage});this.value.recent=this.value.recent.slice(-30);
    for(const day of Object.keys(this.value.days).sort().slice(0,-14))delete this.value.days[day];this.save();
  }
  aggregate(count,now=Date.now()){
    const d=this.value.days[this.day(now)]??={calls:0,failures:0,durationMs:0,inputTokens:0,outputTokens:0,unknownUsage:0,kinds:{}};
    d.batches=(d.batches||0)+1;d.receivedMessages=(d.receivedMessages||0)+count;d.mergedRequests=(d.mergedRequests||0)+Math.max(0,count-1);this.save();
  }
  decision(reason,now=Date.now()){const last=this.value.decisions.at(-1);if(last?.reason===reason&&now-last.at<3600000)return;this.value.decisions.push({at:now,reason});this.value.decisions=this.value.decisions.slice(-30);this.save();}
  save(){atomicWrite(this.file,this.value);}
  view(now=Date.now()){const today=this.value.days[this.day(now)]||{calls:0,failures:0,durationMs:0,inputTokens:0,outputTokens:0,unknownUsage:0,kinds:{}};return {today:{...today,averageMs:today.calls?Math.round(today.durationMs/today.calls):0},recent:this.value.recent,decisions:this.value.decisions};}
}
