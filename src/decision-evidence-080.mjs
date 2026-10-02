export function decisionEvidence(request){
 const s=request.experiment??request.selection,j=s?.jev??request.jev,reason=s?.fallback??s?.reason??j?.reason??null;
 let category='not_requested';
 if(j?.status==='suggested')category='valid_suggestion';
 else if(j?.status==='abstained'||reason==='information_insufficient')category='model_abstention';
 else if(reason==='timeout')category='timeout';
 else if(['authentication_failed','free_service_unavailable','http_error','connection_failed'].includes(reason))category='service_failure';
 else if(['invalid_response','invalid_choice','invalid_pair','response_too_large','model_unconfirmed'].includes(reason))category='invalid_output';
 else if(reason)category='controller_skip_or_protection';
 const version=s?.policyVersion??j?.policyVersion??null;
 return {source:s?.source??(s?.arm==='rule'?'rule':s?.arm==='fixed'?'fixed':j?.status==='suggested'&&s?.applied?'jev':'unknown'),
   policyVersion:version,candidateSetVersion:version?.startsWith('research-v5')?(version.endsWith('wide')?'catalog-080-expanded':'catalog-080-base'):null,
   category,reason,subscriptionQuota:{unit:'percentage_points',evidence:'unknown',value:null,reason:'no_attributable_per_request_meter'}};
}
