export const limits084={gpt:900,jev:120};
export const stages084={preflight:{gpt:18,jev:4},matched:{gpt:292,jev:48},adequacy:{gpt:104,jev:0},round1:{gpt:112,jev:12},round2:{gpt:112,jev:12},round3:{gpt:112,jev:12},round4:{gpt:112,jev:12},reserve:{gpt:38,jev:20}};
export const creditStages084={preflight:12,matched:40,adequacy:16,round1:20,round2:20,round3:20,round4:20,reserve:12};
export function validApproval084(a){return a?.scope==='preacceptance084'&&a.approved===true&&Number.isFinite(Date.parse(a.approvedAt))&&/^[a-f0-9]{64}$/.test(a.evidenceHash??'');}
