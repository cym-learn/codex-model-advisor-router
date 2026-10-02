const byId = (id) => document.getElementById(id);
const modeNames = {rules:'固定规则', shadow:'Jev 只建议', auto:'Jev 自动选择'};
let settings = null;
let pending = false;
let refreshing = false;
let online = false;
let editing = false;
let originalTarget = null;
function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function notice(text, error = false) {
  byId('notice').textContent = text;
  byId('notice').className = error ? 'error' : 'success';
}
function available() { return online && Boolean(settings?.token) && !pending && !refreshing && settings?.busy === false; }
function catalogKnown() { return Number.isInteger(settings?.catalogCount) && settings.catalogCount > 0; }
function updateButtons() {
  const enabled = available();
  for (const id of ['key-setup','show-widget']) byId(id).disabled = !enabled;
  byId('check-connection').disabled = !enabled || settings?.credentialConfigured !== true;
  const text = byId('brief-text').value;
  byId('brief-save').disabled = !enabled || !byId('brief-target').value.trim() || !text.trim() || text.length > 2000 || !byId('brief-consent').checked;
  const mode = byId('mode').value;
  const needsJev = mode !== 'rules';
  byId('mode-save').disabled = !enabled || !Object.hasOwn(modeNames, mode) || needsJev && (settings?.credentialConfigured !== true || !catalogKnown() || !byId('routing-consent').checked);
  byId('mode-requirements').textContent = needsJev && !catalogKnown() ? '可用模型目录未知或为空。刷新确认后再启用 Jev。' : needsJev && settings?.credentialConfigured !== true ? '请先完成本机密钥设置。' : '切换前请让正在执行的任务完成。';
  byId('refresh').disabled = pending || refreshing;
  for (const button of byId('brief-list').querySelectorAll('button[data-mutation]')) button.disabled = !enabled;
}
function preview(changed = false) {
  if (changed) { editing = true; byId('brief-consent').checked = false; }
  const text = byId('brief-text').value;
  byId('brief-preview').textContent = text || '尚未填写摘要';
  byId('brief-count').textContent = text.length + ' / 2,000 字符' + (text.length > 2000 ? ' · 超出上限，请缩短' : '');
  updateButtons();
}
function updateTargets() {
  const project = byId('brief-scope').value === 'project';
  byId('target-label').textContent = project ? '项目完整路径（每行一个，含子目录）' : '对话 ID（一个）';
  byId('brief-target').placeholder = project ? 'C:\\Projects\\frontend\nD:\\Projects\\backend' : '填写完整对话 ID';
  byId('brief-target').rows = project ? 3 : 1;
  const targets = byId('targets'); targets.replaceChildren();
  const seen = new Set();
  for (const thread of settings?.threads ?? []) {
    const value = project ? thread.cwd : thread.threadId;
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    const option = element('option'); option.value = value;
    option.label = project ? value : (thread.name || '未命名对话') + ' · ' + (thread.cwd || '项目未知');
    targets.append(option);
  }
}
function renderBriefs() {
  const list = byId('brief-list'); list.replaceChildren();
  const entries = settings?.briefs?.entries;
  if (!Array.isArray(entries)) { list.append(element('p', '摘要状态未知；不要据此认为摘要已关闭。')); return; }
  if (!entries.length) list.append(element('p', '没有已保存的摘要。未登记范围的摘要默认关闭。', 'muted'));
  for (const entry of entries) {
    const scope = entry.scope ?? (entry.threadId ? 'thread' : 'project');
    const target = entry.target ?? entry.threadId ?? entry.projectPath;
    const card = element('article', undefined, 'brief-entry');
    const title = scope === 'thread' ? '对话覆盖' : '项目摘要';
    card.append(element('strong', title + ' · ' + (entry.enabled === true ? '已启用' : entry.enabled === false ? '已关闭' : '状态未知')));
    card.append(element('pre', typeof target === 'string' ? target : '目标未知', 'preview'));
    card.append(element('pre', typeof entry.text === 'string' ? entry.text : '内容未知', 'preview'));
    const actions = element('div', undefined, 'actions');
    const edit = element('button', '载入编辑', 'secondary'); edit.type = 'button';
    edit.disabled = typeof target !== 'string' || typeof entry.text !== 'string';
    edit.addEventListener('click', () => {
      if (editing && !window.confirm('用已保存内容替换尚未保存的编辑？')) return;
      byId('brief-scope').value = scope; byId('brief-target').value = target; byId('brief-text').value = entry.text;
      originalTarget = target;
      updateTargets(); preview(true); byId('brief-text').focus();
      notice('已载入编辑；保存前请重新检查范围与原文并授权。');
    });
    actions.append(edit);
    for (const [action, label] of [['disable','关闭'],['delete','删除']]) {
      const button = element('button', label, action === 'delete' ? 'danger' : 'secondary'); button.type = 'button'; button.dataset.mutation = 'true';
      button.addEventListener('click', () => {
        if (action === 'delete' && !window.confirm('删除此摘要登记？\n' + target + '\n删除后可能重新采用匹配的项目摘要；不会删除项目文件。')) return;
        mutate('/api/project-briefs', {action, scope, target}, action === 'delete' ? '摘要登记已删除。' : '摘要已关闭。');
      });
      if (typeof target === 'string') actions.append(button);
    }
    card.append(actions); list.append(card);
  }
}
function renderSettings() {
  byId('status').textContent = settings.busy === true ? '控制器忙碌，请等待任务结束后刷新，再手动重试。' : settings.busy === false ? '控制器在线 · 设置已读取；尚不代表执行链路通过。' : '控制器运行状态未知；请刷新确认。';
  byId('status').className = settings.busy === false ? '' : 'error';
  byId('credential-state').textContent = settings.credentialConfigured === true ? '本机已配置密钥（未显示明文）。' : settings.credentialConfigured === false ? '尚未配置密钥。' : '密钥状态未知。';
  byId('mode-state').textContent = '当前模式：' + (modeNames[settings.mode] ?? '未知');
  if (Object.hasOwn(modeNames, settings.mode)) byId('mode').value = settings.mode;
  const baseline = settings.baseline;
  byId('baseline').textContent = '控制器基准：' + (baseline?.model ?? '未知模型') + ' / ' + (baseline?.effort ?? '未知强度') + ' · 可用组合：' + (catalogKnown() ? settings.catalogCount : '未知或为空');
  byId('trial-state').textContent = settings.trial === null || settings.trial?.unrestricted === true ? '当前没有试用登记。' : settings.trial?.blockedReason ? '试用已暂停：' + settings.trial.blockedReason : settings.trial?.enabled ? '存在试用登记；具体范围和预算请查看服务端状态记录。' : '试用未启用。';
  updateTargets(); renderBriefs(); updateButtons();
}
async function refresh() {
  if (refreshing) return false;
  refreshing = true; updateButtons();
  try {
    const response = await fetch('/api/settings', {credentials:'same-origin', cache:'no-store', redirect:'error', signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw Error('设置接口返回 HTTP ' + response.status);
    const value = await response.json();
    if (!value || typeof value.token !== 'string' || !value.token) throw Error('设置令牌缺失，无法安全提交。');
    settings = value; online = true; renderSettings(); return true;
  } catch (error) {
    online = false; settings = null;
    byId('status').textContent = '无法读取当前设置。已有显示可能过期，请刷新后再操作。'; byId('status').className = 'error';
    byId('mode-state').textContent = '当前模式未知（状态读取失败）。';
    byId('credential-state').textContent = '密钥状态未知（状态读取失败）。';
    byId('baseline').textContent = '基准配置与模型目录未知（状态读取失败）。';
    notice(error.message || '本地控制器离线。', true); updateButtons(); return false;
  } finally { refreshing = false; updateButtons(); }
}
async function mutate(path, body, success) {
  if (!available()) { notice('当前不可提交；请等待空闲并刷新状态后手动重试。', true); return false; }
  pending = true; updateButtons();
  try {
    const response = await fetch(path, {method:'POST', credentials:'same-origin', redirect:'error', headers:{'Content-Type':'application/json','X-Advisor-Token':settings.token}, body:JSON.stringify(body), signal:AbortSignal.timeout(60000)});
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409) {
        settings.busy = true;
        throw Error('控制器忙碌，未确认本次变更。请等待任务结束，刷新状态后手动重试。');
      }
      throw Error(result.message || result.error || '提交失败（HTTP ' + response.status + '）');
    }
    if (body.action === 'check-connection') {
      byId('connection-result').textContent = result.message || (result.connected === true ? '本次连接检查成功；GPT实际完成配置仍需在状态页核对。' : result.connected === false ? '本次连接检查未通过；请核对本机配置后手动重试。' : '检查请求已完成，但响应未提供连接确认；不能认定链路通过。');
    }
    byId('routing-consent').checked = false;
    const loaded = await refresh();
    if (loaded) notice(success || result.message || '操作已完成。');
    else notice('服务端已响应成功，但最新状态读取失败；请刷新核对结果，不要重复提交。', true);
    return true;
  } catch (error) {
    if (body.action === 'check-connection') byId('connection-result').textContent = '本次检查未确认成功，不会自动重试。';
    notice(error.message || '请求结果未知，请刷新核对后再操作。', true); return false;
  } finally { pending = false; updateButtons(); }
}
byId('refresh').addEventListener('click', refresh);
byId('key-setup').addEventListener('click', () => mutate('/api/settings', {action:'key-setup'}, '本机密钥窗口请求已提交；填写后请刷新确认配置状态。'));
byId('check-connection').addEventListener('click', () => mutate('/api/settings', {action:'check-connection'}, '连接检查请求已完成，结果见下方。'));
byId('show-widget').addEventListener('click', () => mutate('/api/settings', {action:'show-widget'}, '已请求显示本机状态小窗。'));
byId('mode').addEventListener('change', () => { byId('routing-consent').checked = false; updateButtons(); });
byId('routing-consent').addEventListener('change', updateButtons);
byId('mode-save').addEventListener('click', () => {
  if (byId('mode-save').disabled) return;
  const mode = byId('mode').value;
  mutate('/api/settings', {action:'mode', mode, consent:mode === 'rules' ? false : byId('routing-consent').checked}, '模式已更新。');
});
for (const id of ['brief-text','brief-target']) byId(id).addEventListener('input', () => preview(true));
byId('brief-scope').addEventListener('change', () => { originalTarget=null; byId('brief-target').value = ''; updateTargets(); preview(true); });
byId('brief-consent').addEventListener('change', () => preview());
byId('brief-reset').addEventListener('click', () => {
  if (editing && !window.confirm('清空尚未保存的编辑？已有服务端摘要不会改变。')) return;
  originalTarget=null; byId('brief-text').value = ''; byId('brief-target').value = ''; preview(true); editing = false;
});
byId('brief-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (byId('brief-save').disabled) return;
  const body = {action:'save', scope:byId('brief-scope').value, target:byId('brief-target').value.trim(), text:byId('brief-text').value, consent:byId('brief-consent').checked};
  if(originalTarget!==null)body.originalTarget=originalTarget;
  if (await mutate('/api/project-briefs', body, '摘要已保存并启用；只应用于匹配的范围。')) {
    byId('brief-consent').checked = false;
    editing = body.scope !== byId('brief-scope').value || body.target !== byId('brief-target').value.trim() || body.text !== byId('brief-text').value;
    if(!editing){originalTarget=null;notice('摘要已保存。再次修改请从下方“载入编辑”，以统一更新所有文件夹。');}
    if (editing) notice('已保存刚才提交的版本；当前编辑仍未保存，请重新预览并授权。');
    updateButtons();
  }
});
preview(); refresh();
