export const limits085={gpt:128,jev:20};
export const stages085={main:{gpt:112,jev:12},reserve:{gpt:16,jev:8}};
export const creditStages085={main:40,reserve:10};
export function validApproval085(a){return a?.scope==='preacceptance085'&&a.approved===true&&Number.isFinite(Date.parse(a.approvedAt))&&/^[a-f0-9]{64}$/.test(a.evidenceHash??'');}
