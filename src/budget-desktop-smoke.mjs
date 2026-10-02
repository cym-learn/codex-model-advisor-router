export const limitsDesktopSmoke={gpt:24,jev:3};
export const stagesDesktopSmoke={desktop:{gpt:24,jev:3}};
export function validApprovalDesktopSmoke(a){return a?.scope==='desktop-smoke-r1'&&a.approved===true&&Number.isFinite(Date.parse(a.approvedAt))&&/^[a-f0-9]{64}$/.test(a.evidenceHash??'');}
