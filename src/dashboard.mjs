import {safeSelection} from './jev-runtime.mjs';
import { readFileSync } from 'node:fs';
import { supportedRoutingPairs } from './policy.mjs';
import { readLogRecords } from './log-store.mjs';
import { sumUsage } from './metrics.mjs';
import {creditEstimate,sumCredits} from './cost-080.mjs';
import {decisionEvidence} from './decision-evidence-080.mjs';

function recentRecords(path) {
  return readLogRecords(path, 2 * 1024 * 1024);
}

export function statusSnapshot({ logPath, catalog, baseline, runId, metadata, testRegistryPath, records, turnLimit = 50 }) {
  const requests = new Map();
  let legacyRun = 'legacy';
  const history = records ? { records, truncated: false, totalBytes: null, retainedFiles: null } : recentRecords(logPath);
  for (const record of history.records) {
    if (record.event === 'listening') legacyRun = record.at;
    const key = `${record.runId ?? legacyRun}:${record.id}`;
    if (record.event === 'selection_pending' || record.event === 'request' && /\/responses$/.test(record.path)) {
      requests.set(key, { key, at: record.at, runId: record.runId ?? legacyRun,
        threadId: record.threadId ?? null, turnId: record.turnId ?? null,
        client: record.client, selection: safeSelection(record.selection), experiment: record.experiment ?? null, requestKind: record.requestKind ?? null, reason: record.reason, before: record.before, planned: record.after,
        effortUpdate: typeof record.effortUpdate === 'boolean' ? record.effortUpdate
          : Array.isArray(record.inputTypes) ? record.inputTypes.some((item) => item.type === 'configuration_update') : null,
        httpStatus: null, state: 'pending',
        reported: { model: null, effort: null }, completed: false, responseId: null, outputItems: [] });
    }
    const request = requests.get(key);
    if (!request) continue;
    if (record.event === 'selection') request.selection = safeSelection(record.selection);
    if (record.event === 'jev') { request.jev = record.jev; request.jevAt = record.at; }
    if (record.event === 'upstream') { request.httpStatus = record.status; request.state = 'executing'; }
    if (record.event === 'observation') {
      request.state = record.failedEvent ? 'failed' : 'executing';
      request.reported = { model: record.completedModel ?? record.createdModel ?? null,
        effort: record.completedEffort ?? record.createdEffort ?? null };
      request.responseId = record.responseId ?? null;
      request.outputItems = record.outputItems ?? [];
    }
    if (['finished', 'client_closed_after_complete', 'cancelled', 'error'].includes(record.event)) {
      request.httpStatus = record.status ?? request.httpStatus;
      request.state = record.event;
      request.completed = Boolean(record.completedEvent);
      request.usage = record.usage ?? null;
      request.speedMode = record.speedMode ?? null;
      request.durationMs = record.durationMs ?? null;
      request.totalDurationMs = record.totalDurationMs ?? null;
      request.firstTextMs = record.firstTextMs ?? null;
      request.firstTextTotalMs = record.firstTextTotalMs ?? null;
      request.reported = { model: record.completedModel ?? record.createdModel ?? null,
        effort: record.completedEffort ?? record.createdEffort ?? null };
      request.responseId = record.responseId ?? null;
      request.outputItems = record.outputItems ?? [];
      request.failedEvent = record.failedEvent ?? null;
      request.responseIdConflict = Boolean(record.responseIdConflict);
      request.completionReported = { model: record.completedModel ?? null, effort: record.completedEffort ?? null };
      if (record.failedEvent || request.httpStatus >= 400) request.state = 'failed';
      else if (record.event === 'finished' && !request.completed) request.state = 'interrupted';
    }
  }
  const turns = new Map();
  for (const request of requests.values()) {
    if (request.runId !== runId && runId && ['pending', 'executing'].includes(request.state)) request.state = 'interrupted';
    const pair = request.reported;
    const fields = Boolean(pair.model && pair.effort);
    const match = pair.model === request.planned?.model && pair.effort === request.planned?.effort;
    request.verification = fields && !match ? 'mismatch'
      : request.completed && request.completionReported?.model && request.completionReported?.effort
        && !request.responseIdConflict && ['finished', 'client_closed_after_complete'].includes(request.state)
        && fields && request.effortUpdate === false && request.httpStatus >= 200 && request.httpStatus < 300
        ? 'confirmed' : 'unconfirmed';
    request.evidenceState = request.verification === 'confirmed' ? 'completed_confirmed'
      : request.verification === 'mismatch' ? 'mismatch' : request.reported.model || request.reported.effort ? 'reported_unconfirmed' : 'planned';
    request.costEvidence = creditEstimate(request);
    request.decisionEvidence = decisionEvidence(request);
    request.candidateSetVersion = request.decisionEvidence.candidateSetVersion;
    // CLI, auxiliary and historical requests remain visible but do not claim automatic routing.
    const key = request.turnId ? `${request.threadId}:${request.turnId}` : request.key;
    if (!turns.has(key)) turns.set(key, { key, threadId: request.threadId, turnId: request.turnId,
      at: request.at, requests: [] });
    const turn = turns.get(key);
    turn.latestAt = request.at;
    turn.requests.push(request);
    if (request.jev && (!turn.jevAt || request.jevAt >= turn.jevAt)) { turn.jev = request.jev; turn.jevAt = request.jevAt; }
  }
  let testThreads = [];
  try { const registered = JSON.parse(readFileSync(testRegistryPath, 'utf8').replace(/^\uFEFF/, ''));
    if (Array.isArray(registered)) testThreads = registered.filter((id) => typeof id === 'string'); } catch {}
  const visibleTurns = [...turns.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt)).slice(0, turnLimit);
  const conversations = new Map();
  for (const turn of visibleTurns) {
    turn.usage = sumUsage(turn.requests);
    turn.costEvidence = sumCredits(turn.requests.map(r=>r.costEvidence));
    turn.selection = turn.requests.findLast(r=>r.selection)?.selection ?? null;
    turn.experiment = turn.requests.findLast(r => r.experiment)?.experiment ?? null;
    const uniqueWaits=new Map();
    for(const r of turn.requests.filter(r=>r.experiment)){const e=r.experiment,key=e.jev?.callId??e.runId??r.key;const previous=uniqueWaits.get(key);if(previous===undefined||Number.isFinite(e.waitMs)&&e.waitMs>previous)uniqueWaits.set(key,e.waitMs);}
    const waits=[...uniqueWaits.values()];
    turn.experimentWaitMs=waits.length&&waits.every(v=>Number.isFinite(v)&&v>=0)?waits.reduce((sum,v)=>sum+v,0):null;
    const thread = metadata?.threads?.[turn.threadId];
    turn.conversationName = thread?.displayName ?? null;
    turn.parentThreadId = thread?.parentThreadId ?? null;
    turn.rootThreadId = thread?.rootThreadId ?? null;
    turn.taskRole = thread?.taskRole ?? 'unknown';
    turn.isAuxiliary = !turn.turnId;
    turn.relationshipEvidence = thread?.relationshipEvidence ?? 'metadata_unavailable';
    turn.isTest = Boolean(turn.experiment) || testThreads.includes(turn.threadId) || testThreads.includes(turn.rootThreadId);
    turn.sourceKind = turn.isTest ? 'test' : turn.requests.every((r) => r.client === 'cli') ? 'cli'
      : turn.requests.every((r) => r.client === 'desktop') && turn.turnId
        ? turn.rootThreadId ? 'desktop' : 'desktop_unknown' : 'auxiliary_or_unknown';
    for (const request of turn.requests) request.requestClass = turn.isAuxiliary ? 'auxiliary_unattributed'
      : turn.taskRole === 'child' ? 'child' : turn.taskRole === 'main' ? 'main' : 'unknown';
    const native = metadata?.turns?.[turn.key];
    turn.nativeStatus = native?.status ?? null;
    const matching = native?.finalItemId ? turn.requests.filter((r) => r.outputItems.some((item) => item.id === native.finalItemId && item.role === 'assistant'
      && (item.phase === 'final_answer' || item.phase === null))) : [];
    const completed = native?.status === 'completed' && native.finalPhase === 'final_answer';
    const confirmed = completed && matching.length === 1 && matching[0].verification === 'confirmed';
    turn.finalReply = { status: confirmed ? 'confirmed' : matching.length > 1 ? 'conflict' : 'unconfirmed',
      itemId: native?.finalItemId ?? null, requestKey: confirmed ? matching[0].key : null,
      pair: confirmed ? matching[0].reported : null,
      evidence: confirmed ? 'native_final_item_and_completed_response' : matching.length > 1 ? 'duplicate_output_id'
        : turn.isAuxiliary ? 'no_turn_identity' : native?.status === 'interrupted' ? 'native_turn_interrupted'
          : !native?.finalItemId ? 'native_final_item_missing' : !matching.length ? 'output_id_not_observed'
          : !completed ? 'native_turn_incomplete' : 'request_configuration_unconfirmed' };
    for (const request of turn.requests) request.isFinalReply = confirmed && request.key === turn.finalReply.requestKey;
    const key = `${turn.sourceKind}:${turn.rootThreadId ?? turn.threadId ?? turn.key}`;
    if (!conversations.has(key)) conversations.set(key, { key, rootThreadId: turn.rootThreadId,
      displayName: metadata?.threads?.[turn.rootThreadId]?.displayName ?? (turn.taskRole === 'main' ? turn.conversationName : null),
      sourceKind: turn.sourceKind, latestAt: turn.latestAt, turns: [] });
    conversations.get(key).turns.push(turn);
  }
  return { ok: true, schemaVersion: 2, runId, baseline, availablePairs: supportedRoutingPairs(catalog),
    metadataStatus: { state: metadata?.state ?? 'unavailable', historyState: metadata?.historyState ?? 'unavailable', updatedAt: metadata?.updatedAt ?? null },
    history: { truncated: history.truncated || turns.size > 50, retainedFiles: history.retainedFiles,
      totalBytes: history.totalBytes, maxTurns: 50, note: '仅展示保留日志末尾 2 MiB 内最多 50 轮；完整验收导出另读归档。' },
    generatedAt: new Date().toISOString(), historyLimitBytes: 2 * 1024 * 1024,
    turns: visibleTurns, conversations: [...conversations.values()] };
}

export const dashboardHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex 模型路由状态</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#172033}
body{max-width:1080px;margin:0 auto;padding:32px 22px}h1{font-size:26px;margin:0 0 10px}p{line-height:1.7;color:#58647a}
.panel,article{background:#fff;border:1px solid #dce1e9;border-radius:14px;padding:20px;margin:18px 0}.top{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.badge{background:#e5f3eb;color:#17633e;border-radius:20px;padding:5px 12px;font-size:13px}.warn{background:#fff0d3;color:#81540c}.error{background:#fde8e7;color:#963c36}
input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #cad2df;border-radius:8px;font:inherit;background:transparent;color:inherit}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #e6e9ee;vertical-align:top}th{color:#66748a;font-weight:500}
.scroll{overflow:auto}.muted,small{color:#66748a}code{font-size:12px;overflow-wrap:anywhere}.empty{padding:30px;text-align:center}.pair{white-space:nowrap}summary{cursor:pointer;margin-top:14px}.detail{font-size:13px;line-height:1.8}.labels{display:flex;gap:8px;flex-wrap:wrap}.labels span{background:#f0f2f6;padding:5px 9px;border-radius:6px}
@media(prefers-color-scheme:dark){:root{background:#151921;color:#e5eaf3}.panel,article{background:#202630;border-color:#394253}p,.muted,small,th{color:#a9b5c9}td,th{border-color:#394253}.labels span{background:#303949}input{border-color:#4c586b}}
</style></head><body>
<div class="top"><div><h1>Codex 模型路由状态</h1><div class="muted">所属对话、主／子任务，以及最终回复由哪次请求生成。</div></div><span id="health" class="badge">连接中</span></div>
<section class="panel"><div id="catalog" class="labels"></div><p id="baseline"></p><p>保持安装时的模型和推理强度即可自动判断；手动换成其他组合时保留你的选择。每次发送新问题判断一次，同一轮工具执行沿用该轮选择。</p><small>这里只显示经过本机控制器的请求。旧任务可能仍使用原通道，没有记录不代表任务未运行。界面原来的模型选择器不会同步变化。</small></section>
<input id="filter" aria-label="按对话名称或 ID 筛选" placeholder="按对话名称或 ID 筛选（可输入 ID 的一部分）">
<p id="summary" class="muted"></p><main id="turns" aria-live="polite"></main>
<footer><p>“完成确认”要求上游完成且配置一致；最终回复还须匹配本机最终消息 ID。字段缺失、取消或会话内强度覆盖均标为未证实。默认按规则执行；只建议模式不改变配置；同意发送任务文本后可开启 Jev 自动。独立登记的对照试验与日常模式分别标注。日志不保存问题、回答或密钥，显示名称从本机只读读取。</p><small>本地研究预览版 · 未接入个人化 · 最多显示日志末尾 2 MB 内的 50 轮</small></footer>
<script src="/dashboard.js" defer></script></body></html>`;

export const dashboardScript = readFileSync(new URL('./dashboard-client.js', import.meta.url), 'utf8');
