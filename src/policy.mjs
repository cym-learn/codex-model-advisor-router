const simpleTask = /^(?:请|麻烦)?\s*(?:(?:把|将).{1,120}(?:翻译成|译成)(?:中文|英文|英语|汉语)(?:[。.!！?？\s]*(?:只回答译文|仅输出译文))?|(?:只|仅)(?:回答|输出)\s*[A-Za-z0-9_-]{1,40})[。.!！?？\s]*$/su;
const unsafeOrComplex = /```|\b(?:sudo|rm\s+-rf|delete|deploy|publish)\b|删除|部署|发布|支付|密码|密钥|隐私|医疗|法律|财务|多个文件|整个项目|修复|调试|设计|实现|重构/u;

export const routingModels = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'];
export const routingEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];

export function supportedRoutingPairs(catalog) {
  return catalog.filter(({ model, effort }) => routingModels.includes(model) && routingEfforts.includes(effort));
}

export function hasEffortUpdate(body) {
  return Boolean(body.previous_response_id) ||
    (Array.isArray(body.input) && body.input.some((item) => item?.type === 'configuration_update'));
}

export function clientKind(headers) {
  const agent = String(headers['user-agent'] ?? '');
  if (/\(codex_exec;/i.test(agent)) return 'cli';
  if (headers.originator === 'Codex Desktop' && /^Codex Desktop\//i.test(agent)) return 'desktop';
  return 'unknown';
}

export function turnIdentity(headers) {
  try {
    const metadata = JSON.parse(headers['x-codex-turn-metadata'] ?? '{}');
    return metadata.request_kind === 'turn' && metadata.turn_trigger !== 'app_tool_send_message'
      && typeof metadata.turn_id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(metadata.turn_id)
      ? metadata.turn_id : null;
  } catch { return null; }
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n');
}

export function requestPhase(body) {
  const input = body?.input;
  if (!Array.isArray(input) || input.length === 0) return { kind: 'unknown', text: '' };
  const last = input.at(-1);
  if (last?.type === 'function_call_output' || last?.type === 'custom_tool_call_output' || last?.role === 'tool') {
    return { kind: 'tool', text: '' };
  }
  const lastUser = input.findLast((item) => item?.role === 'user' && (!item.type || item.type === 'message'));
  const text = textFromContent(lastUser?.content).trim();
  if (text) return { kind: 'user', text };
  return { kind: 'unknown', text: '' };
}

export function chooseLocalRoute({ body, availablePairs, baseline, previousRoute }) {
  const original = { model: body.model, effort: body.reasoning?.effort ?? null };
  // These history items override the request-level effort reported by Responses.
  if (hasEffortUpdate(body)) return { ...original, reason: body.previous_response_id ? 'unseen_history' : 'configuration_update' };
  if (previousRoute) return { ...previousRoute, reason: 'same_turn' };
  const phase = requestPhase(body);
  if (phase.kind !== 'user') return { ...original, reason: 'not_user_turn' };
  if (original.model !== baseline.model || original.effort !== baseline.effort) {
    return { ...original, reason: 'manual_selection' };
  }
  const lastUser = body.input.findLast((item) => item?.role === 'user');
  if (Array.isArray(lastUser?.content) && lastUser.content.some((part) => part?.type !== 'input_text')) {
    return { ...original, reason: 'nontext_context' };
  }
  if (phase.text.length > 12000) return { ...original, reason: 'long_task' };
  const taskText = phase.text.replace(/^`([^`\r\n]+)`$/u, '$1')
    .replace(/^\*\*([^*\r\n]+)\*\*/u, '$1')
    .replace(/[，,]\s*不用调用\s*skill[。.!！\s]*$/iu, '').trim();
  const explicitEffort = /(?:推理强度|reasoning\s+effort)\s*(?:设为|使用|为|=|:|：)?\s*(low|medium|high|xhigh|max)\b/iu.exec(taskText)?.[1]?.toLowerCase();
  const bounded = taskText.length <= 180 && !unsafeOrComplex.test(taskText) && simpleTask.test(taskText);
  const frontier = /数学证明|定理|形式化验证|跨系统|分布式|安全审计|威胁建模|生产事故|医疗|法律|财务|\b(?:theorem|formal verification|distributed|security audit)\b/iu.test(taskText);
  const engineering = /代码|编程|函数|脚本|测试|调试|修复|实现|重构|设计|部署|发布|删除|整个项目|\b(?:code|debug|implement|refactor|deploy|delete)\b/iu.test(taskText);
  const language = /翻译|译成|摘要|总结|润色|改写|提取|格式化|\b(?:translate|summarize|rewrite|format)\b/iu.test(taskText);
  if (!bounded && !frontier && !engineering && !language) return { ...original, reason: 'not_bounded_simple' };
  // Lightweight routing requires a self-contained request; follow-ups stay on the incoming pair.
  if (!bounded && !frontier && !engineering && /上面|上述|刚才|附件|截图|文件|继续|再帮|然后|同时|并且|还要|密码|密钥|隐私|previous|attached/iu.test(taskText)) {
    return { ...original, reason: 'dependent_context' };
  }
  const model = frontier ? 'gpt-6-astra' : engineering ? 'gpt-6-sol' : 'gpt-6-luna';
  let effort = bounded ? 'low' : frontier ? 'high' : 'medium';
  if (/简单|单行|只改一处|只输出|仅输出|\b(?:simple|one.line)\b/iu.test(taskText)) effort = 'low';
  if (taskText.length > 1500 || /多步骤|多个文件|端到端|复杂|详细分析|\b(?:complex|end.to.end|multiple files)\b/iu.test(taskText)) effort = 'high';
  if (/严格|深入|系统性|权衡|边界情况|\b(?:rigorous|trade.offs|edge cases)\b/iu.test(taskText)) effort = 'xhigh';
  if (/穷尽|所有可能|完整证明|最高推理强度|\b(?:exhaustive|complete proof)\b/iu.test(taskText)) effort = 'max';
  if (explicitEffort) effort = explicitEffort;
  if (!supportedRoutingPairs(availablePairs).some((pair) => pair.model === model && pair.effort === effort)) {
    return { ...original, reason: 'target_unavailable' };
  }
  return { model, effort, reason: bounded ? 'bounded_simple_task' : `local_${frontier ? 'frontier' : engineering ? 'engineering' : 'language'}${explicitEffort ? '_explicit_effort' : ''}` };
}
