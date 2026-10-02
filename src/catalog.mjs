import { spawn } from 'node:child_process';

export function listModelCatalog({ command = process.env.ROUTER_CODEX_PATH ?? 'codex', timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let done = false;
    let pending = '';
    const finish = (models) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 2) continue;
        const models = [];
        for (const model of message.result?.data ?? []) {
          const id = model.id ?? model.model;
          if (id) models.push({ id, defaultEffort: model.defaultReasoningEffort ?? null,
            isDefault: Boolean(model.isDefault),
            supportedEfforts: (model.supportedReasoningEfforts ?? [])
              .map((item) => item.reasoningEffort).filter(Boolean) });
        }
        finish(models);
      }
    });
    const messages = [
      { method: 'initialize', id: 1, params: { clientInfo: { name: 'codex-model-advisor-router', title: 'Codex Model Advisor Router', version: '0.1.0' } } },
      { method: 'initialized', params: {} },
      { method: 'model/list', id: 2, params: { limit: 100, includeHidden: false } },
    ];
    for (const message of messages) child.stdin.write(JSON.stringify(message) + '\n');
  });
}

export async function listAvailablePairs(options) {
  const models = await listModelCatalog(options);
  return models.flatMap((model) => model.supportedEfforts.map((effort) => ({ model: model.id, effort })));
}
