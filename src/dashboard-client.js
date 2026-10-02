const byId = (id) => document.getElementById(id);
const verificationNames = { confirmed: '完成确认', unconfirmed: '未证实', mismatch: '配置不匹配' };
const roleNames = { main: '主任务', child: '子任务', unknown: '角色未知' };
const states = { pending: '拟选配置，等待服务端', executing: '执行中', finished: '流已完成',
  client_closed_after_complete: '完成后关闭连接', cancelled: '已取消', error: '连接错误', interrupted: '流中断／缺少完成事件', failed: '请求失败' };
const reasonNames = {policy_changed_same_turn:'本轮已判断，策略变更从新轮次生效',pending:'正在等待 Jev 判断',timeout:'判断超过 5 秒，退回规则',busy:'已有两个判断进行中，退回规则',disabled:'已关闭 Jev，退回规则',cancelled:'本轮已取消',information_insufficient:'信息不足，退回规则',context_missing:'缺少必要上下文',text_too_long:'输入超过上限',possible_secret:'疑似包含凭据，未发送',free_service_unavailable:'免费服务不可用',authentication_failed:'认证失败',manual_selection:'保留手动选择',protected_configuration:'保留手动选择或强度覆盖',route_not_restored:'同轮选择未恢复',interrupted:'判断被重启中断',persistence_unavailable:'本机保存不可用，退回规则',provisional_profiles:'依据初始能力说明'};
function reasonLabel(value) { return value === 'independent_judgment' ? 'Jev 独立判断' : reasonNames[value] ?? value ?? '等待'; }
function selectionReason(s) { return reasonLabel(s.reason).replace('退回规则', s.fallbackPolicy === 'incoming' || s.source === 'incoming' ? '保留用户原配置' : '退回规则'); }
let latest;
function element(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function pair(p) { return (p?.model?.replace('gpt-6-', 'GPT-6 ') ?? '未知模型') + ' / ' + (p?.effort ?? '未知强度'); }
function sourceLabel(kind) { return ({ desktop: '日常 Desktop', desktop_unknown: 'Desktop · 所属未知', test: '专用测试', cli: 'CLI', auxiliary_or_unknown: '辅助／未知来源' })[kind] ?? kind; }
function jevLabel(j) {
  if (!j) return '未启用／本轮未登记';
  const labels = { pending: '后台判断中', suggested: '建议未执行', abstained: '信息不足，放弃建议', skipped: '已跳过', failed: '建议失败' };
  return (j.suggested ? pair(j.suggested) + ' · ' : '') + (labels[j.status] ?? '未证实') +
    (j.reason ? ' · ' + reasonLabel(j.reason) : '') + (j.elapsedMs != null ? ' · ' + j.elapsedMs + ' ms' : '');
}
function render() {
  if (!latest) return;
  const needle = byId('filter').value.trim().toLowerCase();
  const main = byId('turns');
  const open = new Set([...main.querySelectorAll('details[open]')].map((e) => e.dataset.key));
  main.replaceChildren();
  const groups = (latest.conversations ?? []).filter((c) => !needle ||
    (c.displayName + ' ' + c.turns.map((t) => [t.conversationName, t.threadId, t.turnId].join(' ')).join(' ')).toLowerCase().includes(needle));
  byId('summary').textContent = '最近 ' + latest.turns.length + ' 轮 · 元数据 ' + latest.metadataStatus.state +
    ' · ' + new Date(latest.generatedAt).toLocaleTimeString() + ' 更新 · 每 2 秒刷新 · ' + (latest.history?.note ?? '最多 50 轮') +
    (latest.testBudget?.state === 'open' ? ' · 测试预算 ' + (latest.testBudget.used ?? '?') + '/' + (latest.testBudget.limit ?? '?') + ' · ' + latest.testBudget.state : '');
  if (latest.jev?.mode === 'shadow' && (!latest.routing || latest.routing.mode === 'rules')) byId('summary').textContent += ' · Jev ' + (latest.jev.mode === 'shadow' ? '只建议' : '关闭') +
    ' · 调用 ' + (latest.jev.budget.used ?? '?') + '/' + (latest.jev.budget.limit ?? '?') + ' · ' + latest.jev.state;
  if (latest.routing) byId('summary').textContent += ' · 当前模式 ' + ({rules:'规则',shadow:'Jev 只建议',auto:'Jev 自动'}[latest.routing.mode] ?? '未知') + (latest.routing.mode === 'rules' ? '' : ' · ' + latest.routing.policyVersion) + ' · 判断中 ' + latest.routing.pending;
  if (latest.evaluation?.budget && latest.evaluation.mode === 'controlled') byId('summary').textContent += ' · 独立对照 GPT ' + latest.evaluation.budget.gpt.used + '/' + latest.evaluation.budget.gpt.limit + ' · Jev ' + latest.evaluation.budget.jev.used + '/' + latest.evaluation.budget.jev.limit + ' · ' + latest.evaluation.mode;
  if (!groups.length) main.append(element('div', '暂时没有匹配的请求。', 'panel empty'));
  for (const group of groups) {
    const section = element('section', undefined, 'panel');
    const heading = element('div', undefined, 'top');
    heading.append(element('h2', group.displayName ?? '所属对话未知'), element('span', sourceLabel(group.sourceKind), 'badge warn'));
    section.append(heading);
    for (const turn of group.turns) {
      const card = element('article');
      card.append(element('strong', new Date(turn.at).toLocaleString() + ' · ' + (turn.isAuxiliary ? '辅助请求／归属未证实' : roleNames[turn.taskRole]) +
        (turn.taskRole === 'child' ? ' · ' + (turn.conversationName ?? '名称未知') : '')));
      const final = turn.finalReply;
      const pending = turn.requests.some((r) => ['pending', 'executing'].includes(r.state));
      const stopped = !pending && (turn.nativeStatus === 'interrupted' || turn.requests.at(-1)?.state === 'cancelled');
      const finalLabel = turn.taskRole === 'child' ? '子任务最终结果' : turn.taskRole === 'main' ? '面向用户的最终回复' : '最终回复（角色未知）';
      card.append(element('p', final.status === 'confirmed'
        ? finalLabel + '：' + pair(final.pair) + ' · 消息 ID 与本机完成记录匹配'
        : turn.isAuxiliary ? '没有轮次 ID，不能认定是最终回复、输入或输出的独立步骤。'
          : stopped ? '本轮已取消／中止 · 没有已确认的最终回复 · 各次调用见下方'
          : finalLabel + '：归属未证实' + (pending ? ' · 执行中' : final.evidence === 'native_final_item_missing' ? ' · 等待本机记录' : '') + ' · 各次调用见下方', final.status === 'confirmed' ? '' : 'muted'));
      if (turn.selection) card.append(element('p', '选型来源：' + (turn.selection.source === 'jev' ? 'Jev 自动选择，执行配置见服务端确认' : turn.selection.source === 'incoming' ? '用户原配置' : '规则') + ' · ' + turn.selection.policyVersion + ' · 项目摘要' + (turn.selection.projectBriefEnabled ? '已启用' : '关闭') + ' · ' + (turn.selection.inputProfile ?? '历史版本') + ' · ' + selectionReason(turn.selection) + ' · ' + (turn.selection.waitMs ?? '?') + ' ms', 'muted'));
      if (turn.costEvidence) card.append(element('p', '估算 credit 成本：' + (turn.costEvidence.value == null ? '未知／字段不足' : turn.costEvidence.value.toFixed(4) + ' credits') + '；不是订阅额度百分比。', 'muted'));
      if (!turn.experiment && !turn.selection) card.append(element('p', 'Jev：' + jevLabel(turn.jev ?? turn.requests.findLast((r) => r.jev)?.jev), 'muted'));
      if (turn.experiment) {
        const wait=Object.hasOwn(turn,'experimentWaitMs')?turn.experimentWaitMs:turn.experiment.waitMs;
        card.append(element('p',
        (turn.experiment.arm === 'jev' ? 'Jev 试验' : turn.experiment.arm === 'rule' ? '规则试验' : '固定组合试验') +
        ' · ' + (turn.experiment.applied ? 'Jev 配置已应用于请求（实际执行见服务端确认）' : turn.experiment.fallback ? '退回／保护：' + selectionReason({...turn.experiment, reason:turn.experiment.fallback}) : '按登记的试验配置执行') +
        ' · 策略 ' + (turn.experiment.policyVersion ?? '固定规则/组合') + ' · 项目摘要' + (turn.experiment.projectBriefEnabled ? '已启用' : '关闭') + ' · 本轮判断等待 ' + (wait==null?'未知':wait+' ms')));
      }
      const details = element('details'); details.dataset.key = turn.key; details.open = open.has(turn.key);
      details.append(element('summary', '展开 ' + turn.requests.length + ' 次模型请求与证据'));
      const table = element('table'); const head = element('tr');
      for (const title of ['原配置／规则对照', 'Jev 建议／试验应用', '实际服务端报告', '请求状态／验证']) head.append(element('th', title));
      table.append(head);
      for (const r of turn.requests) {
        const experiment = r.experiment;
        const choiceLabel = experiment ? experiment.jev?.suggested ? pair(experiment.jev.suggested) + (experiment.applied ? ' · 试验请求已应用' : ' · 未应用') : experiment.fallback ?? '本组不调用 Jev' : (r.selection ?? turn.selection) ? ((r.selection ?? turn.selection).source === 'jev' ? pair((r.selection ?? turn.selection).selected) + ' · 已用于请求，执行见确认' : jevLabel((r.selection ?? turn.selection).jev)) : jevLabel(r.jev ?? turn.jev);
        const row = element('tr'); row.append(element('td', pair(experiment?.rule ?? experiment?.incoming ?? r.selection?.rule ?? r.selection?.incoming ?? r.planned), 'pair'), element('td', choiceLabel), element('td', pair(r.reported), 'pair'),
          element('td', (states[r.state] ?? r.state) + ' · ' + verificationNames[r.verification] + (r.isFinalReply ? ' · 最终回复来源' : '')));
        table.append(row);
        const diagnostic = element('tr'); const cell = element('td', '原选择 ' + pair(r.before) + ' · ' + r.reason +
          ' · HTTP ' + (r.httpStatus ?? '等待') + ' · 响应 ' + (r.responseId ?? '未记录') +
          ' · 消息阶段 ' + (r.outputItems.map((item) => item.phase ?? '未知').join(' / ') || '未记录'), 'detail');
        cell.append(document.createTextNode(' · GPT 输入 ' + (r.usage?.inputTokens ?? '未知') + '（缓存 ' + (r.usage?.cachedInputTokens ?? '未知') + '） · 输出 ' + (r.usage?.outputTokens ?? '未知') + '（含推理 ' + (r.usage?.reasoningTokens ?? '未知') + '） · 请求耗时 ' + (r.totalDurationMs ?? '未知') + ' ms · 首段文字 ' + (r.firstTextMs ?? '未知') + ' ms'));
        cell.colSpan = 4; diagnostic.append(cell); table.append(diagnostic);
      }
      const scroll = element('div', undefined, 'scroll'); scroll.append(table); details.append(scroll);
      details.append(element('p', '任务 ID ' + (turn.threadId ?? '未知') + ' · 轮次 ' + (turn.turnId ?? '未知') +
        ' · 父任务 ' + (turn.parentThreadId ?? '无／未知') + ' · 根对话 ' + (turn.rootThreadId ?? '未知') +
        ' · 关系证据 ' + turn.relationshipEvidence + ' · 最终回复证据 ' + final.evidence, 'detail'));
      card.append(details); section.append(card);
    }
    main.append(section);
  }
}
async function refresh() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw Error();
    latest = await response.json();
    byId('health').textContent = '控制器在线'; byId('health').className = 'badge';
    byId('catalog').replaceChildren();
    for (const model of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) byId('catalog').append(element('span',
      model.replace('gpt-6-', 'GPT-6 ') + ' · ' + latest.availablePairs.filter((p) => p.model === model).map((p) => p.effort).join(' / ')));
    byId('baseline').textContent = '自动判断基准：' + pair(latest.baseline) + ' · 当前可用 ' + latest.availablePairs.length + ' 种组合';
    render();
  } catch {
    byId('health').textContent = '离线 · 下方为历史快照'; byId('health').className = 'badge error';
    byId('summary').textContent = '无法连接控制器；下方信息不能视为当前状态。';
  }
}
const settingsLink = element('a', '路由设置');
settingsLink.href = '/settings';
settingsLink.style.marginLeft = '12px';
byId('health').parentElement.append(settingsLink);
byId('filter').addEventListener('input', render);
refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 2000);
