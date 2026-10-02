// Versioned Codex credit estimates, never a conversion to subscription percentages.
export const creditRateCard = Object.freeze({version:'codex-standard-2026-09-30',
  source:'https://learn.chatgpt.com/docs/pricing',reviewedAt:'2026-09-30',unit:'credits_per_million_tokens',
  rates:{'gpt-6-astra':[250,25,1250],'gpt-6-sol':[50,5,250],'gpt-6-luna':[2.5,.25,12.5],
    'gpt-5.6-sol':[100,10,500],'gpt-5.6-terra':[50,5,300],'gpt-5.6-luna':[5,.5,30]},
  speedMultipliers:{standard:1,fast:2,ultrafast:6}});
export function creditEstimate(request,{assumeStandard=false}={}) {
  const result={unit:'credits',evidence:'unknown',value:null,rateVersion:creditRateCard.version,reason:null};
  if(request.verification!=='confirmed')return {...result,reason:'execution_unconfirmed'};
  const rate=creditRateCard.rates[request.completionReported?.model??request.reported?.model];
  if(!rate)return {...result,reason:'rate_missing'};
  const u=request.usage,counts=[u?.inputTokens,u?.cachedInputTokens,u?.outputTokens];
  if(!counts.every(n=>Number.isSafeInteger(n)&&n>=0)||counts[1]>counts[0])return {...result,reason:'usage_missing_or_invalid'};
  let speed=request.speedMode;
  if(!speed&&assumeStandard)speed='standard';
  if(!Object.hasOwn(creditRateCard.speedMultipliers,speed??''))return {...result,reason:'speed_unconfirmed'};
  if(speed==='ultrafast'&&request.reported?.model!=='gpt-6-astra')return {...result,reason:'speed_model_unsupported'};
  return {...result,evidence:!request.speedMode?'conditional_standard':'rate_estimate',
    reason:!request.speedMode?'historical_speed_not_recorded':null,speed,
    value:((counts[0]-counts[1])*rate[0]+counts[1]*rate[1]+counts[2]*rate[2])/1e6*creditRateCard.speedMultipliers[speed]};
}
export function sumCredits(items) {
  return {unit:'credits',knownSubtotal:items.reduce((n,x)=>n+(x.value??0),0),unknownCount:items.filter(x=>x.value===null).length,
    value:items.length&&items.every(x=>x.value!==null)?items.reduce((n,x)=>n+x.value,0):null,
    evidence:!items.length?'unknown':items.some(x=>x.value===null)?'incomplete':items.some(x=>x.evidence==='conditional_standard')?'conditional_standard':'rate_estimate'};
}
export function quotaSnapshot(result,at=new Date().toISOString()) {
  const buckets=result?.rateLimitsByLimitId??(result?.rateLimits?{[result.rateLimits.limitId??'legacy']:result.rateLimits}:{});
  return {at,unit:'percent_used',windows:Object.entries(buckets).flatMap(([bucket,r])=>['primary','secondary'].flatMap(window=>{
    const v=r[window];return v&&[v.usedPercent,v.windowDurationMins,v.resetsAt].every(Number.isFinite)?[{bucket,window,usedPercent:v.usedPercent,windowDurationMins:v.windowDurationMins,resetsAt:v.resetsAt}]:[];
  }))};
}
export function quotaDifference(before,after,{exclusive=false,settled=false}={}) {
  return after.windows.map(v=>{const old=before.windows.find(x=>x.bucket===v.bucket&&x.window===v.window);
    const reason=!old?'baseline_missing':old.resetsAt!==v.resetsAt||old.windowDurationMins!==v.windowDurationMins?'window_reset':v.usedPercent<old.usedPercent?'nonmonotonic':!exclusive?'shared_account_activity':!settled?'refresh_or_precision_unconfirmed':null;
    return {bucket:v.bucket,window:v.window,unit:'percentage_points',observedDelta:old&&old.resetsAt===v.resetsAt?v.usedPercent-old.usedPercent:null,
      attributable:reason===null,reason,value:reason===null?v.usedPercent-old.usedPercent:null};});
}
