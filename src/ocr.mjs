import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';

const PS_SCRIPT=`
param([string]$Path)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapTransform,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapBounds,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
function Await($WinRtTask,$ResultType){
  $asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethodDefinition } | Select-Object -First 1
  $task=$asTask.MakeGenericMethod($ResultType).Invoke($null,@($WinRtTask))
  $task.Wait(-1) | Out-Null
  return $task.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$imgWidth=[int]$decoder.PixelWidth
$imgHeight=[int]$decoder.PixelHeight
$maxSize=[int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
if($imgWidth -gt $maxSize){throw ('图片宽度 ' + $imgWidth + ' 超过本机 OCR 上限 ' + $maxSize + '，请使用原始聊天截图')}
if([long]$imgWidth*$imgHeight -gt 200000000){throw '图片像素总量超过2亿，请分成几张截图上传'}
$lang = $null
foreach($tag in @('zh-Hans-CN','zh-CN','en-US')){
  try{ $candidate = [Windows.Globalization.Language]::new($tag); if([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($candidate)){ $lang=$candidate; break } }catch{}
}
if(-not $lang){ $lang = [Windows.Globalization.Language]::new((Get-Culture).Name) }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if(-not $engine){ throw ('OCR 语言包不可用：' + $lang.LanguageTag) }
$tileSize=[math]::Min(3200,$maxSize)
$overlap=[math]::Min(120,[math]::Floor($tileSize/8))
$coreSize=$tileSize-2*$overlap
$rows=New-Object System.Collections.ArrayList
$tiles=0
try{
  for($coreTop=0;$coreTop -lt $imgHeight;$coreTop+=$coreSize){
    $coreEnd=[math]::Min($imgHeight,$coreTop+$coreSize)
    $cropTop=[math]::Max(0,$coreTop-$overlap)
    $cropEnd=[math]::Min($imgHeight,$coreEnd+$overlap)
    $bounds=[Windows.Graphics.Imaging.BitmapBounds]::new()
    $bounds.X=0;$bounds.Y=[uint32]$cropTop;$bounds.Width=[uint32]$imgWidth;$bounds.Height=[uint32]($cropEnd-$cropTop)
    $transform=[Windows.Graphics.Imaging.BitmapTransform]::new()
    $transform.Bounds=$bounds
    $software=$null
    try{
      $software=Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,$transform,[Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,[Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result=Await ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
      foreach($line in $result.Lines){
        if($line.Words.Count -eq 0){continue}
        $left=[double]::PositiveInfinity;$top=[double]::PositiveInfinity;$right=0.0;$bottom=0.0
        foreach($word in $line.Words){
          $rect=$word.BoundingRect
          $left=[math]::Min($left,$rect.X);$top=[math]::Min($top,$rect.Y)
          $right=[math]::Max($right,$rect.X+$rect.Width);$bottom=[math]::Max($bottom,$rect.Y+$rect.Height)
        }
        $globalTop=$top+$cropTop
        $centerY=($top+$bottom)/2+$cropTop
        # Overlap protects characters; center ownership prevents duplicated boundary lines.
        if($centerY -lt $coreTop -or $centerY -ge $coreEnd){continue}
        $null=$rows.Add(@{text=$line.Text;x=$left;y=$globalTop;width=($right-$left);height=($bottom-$top);imageWidth=$imgWidth})
      }
      $tiles++
    }finally{if($software){$software.Dispose()}}
  }
  @{width=$imgWidth;height=$imgHeight;tiles=$tiles;maxDimension=$maxSize;lines=@($rows)} | ConvertTo-Json -Depth 6 -Compress
}finally{$stream.Dispose()}
`;

const collapseCjk=line=>line
  .replace(/([㐀-鿿＀-￯])\s+(?=[㐀-鿿＀-￯\d])/g,'$1')
  .replace(/(\d)\s+(?=[㐀-鿿＀-￯])/g,'$1');

export function parseOcrOutput(stdout){
  let data;try{data=JSON.parse(String(stdout).replace(/^\uFEFF/,'').trim());}catch{throw new Error('图片识别结果格式异常，请重试');}
  if(!Array.isArray(data.lines)||!Number.isFinite(data.width)||!Number.isFinite(data.height))throw new Error('图片识别结果缺少尺寸或文字');
  const lines=data.lines.map(row=>{
    const text=collapseCjk(String(row.text||'').trim());
    const {x,y,width,height}=row,imageWidth=row.imageWidth||data.width;
    if(!text||![x,y,width,height,imageWidth].every(Number.isFinite)||height<=0||imageWidth<=0)return null;
    return {text,ratio:(x+width/2)/imageWidth,x,y,width,height,imageWidth};
  }).filter(Boolean).sort((a,b)=>a.y-b.y||a.x-b.x);
  const seen=new Map();
  const unique=lines.filter(row=>{
    const prior=seen.get(row.text)||[];
    if(prior.some(v=>Math.abs(v.x-row.x)<8&&Math.abs(v.y-row.y)<Math.min(v.height,row.height)/2))return false;
    prior.push(row);seen.set(row.text,prior);return true;
  });
  return {width:data.width,height:data.height,tiles:data.tiles,maxDimension:data.maxDimension,lines:unique};
}

export async function ocrImageFile(file,{execFileImpl=execFile,timeoutMs=90000,details=false,signal}={}){
  if(process.platform!=='win32'&&execFileImpl===execFile)throw new Error('截图 OCR 需要 Windows 10/11 系统识别引擎；当前平台请使用粘贴或文件导入');
  file=path.resolve(file);
  const script=path.join(os.tmpdir(),`qq-ocr-${process.pid}-${randomUUID()}.ps1`);
  fs.writeFileSync(script,'﻿'+PS_SCRIPT,'utf8');
  try{
    const out=await new Promise((resolve,reject)=>{
      execFileImpl('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Path',file],{timeout:timeoutMs,maxBuffer:16*1024*1024,windowsHide:true,signal},(error,stdout,stderr)=>{
        if(error||String(stderr).trim())reject(new Error(signal?.aborted?'蒸馏任务已取消':error?.killed?'图片识别超时，请把长图分成几张重试':`图片识别失败：${String(stderr||error?.message).replace(/\r?\n/g,' ').slice(0,250)}`));
        else resolve(stdout);
      });
    });
    const parsed=parseOcrOutput(out);return details?parsed:parsed.lines;
  }finally{fs.rmSync(script,{force:true});}
}
