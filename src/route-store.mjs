import { readJson, writeJson, safeId } from './local-state.mjs';

export const routeTtl = 2 * 60 * 60 * 1000;
export function routeStore(path, baseline, catalog, now = Date.now) {
  const routes = new Map();
  let state = 'ready';
  try {
    const saved = readJson(path);
    if (saved.version !== 1 || saved.baseline.model !== baseline.model || saved.baseline.effort !== baseline.effort || !Array.isArray(saved.entries)) throw Error();
    for (const entry of saved.entries.slice(-1000)) {
      if (!safeId(entry.threadId) || !safeId(entry.turnId) || !Number.isFinite(entry.at) || entry.at > now() || now() - entry.at >= routeTtl) continue;
      if (!catalog.some((p) => p.model === entry.route?.model && p.effort === entry.route?.effort)) continue;
      const reason = typeof entry.route.reason === 'string' && /^[a-z_]{1,80}$/.test(entry.route.reason) ? entry.route.reason : 'restored';
      routes.set(`${entry.threadId}:${entry.turnId}`, { route: { model: entry.route.model, effort: entry.route.effort, reason }, at: entry.at });
    }
  } catch (error) { state = error.code === 'ENOENT' ? 'new' : 'unavailable'; }
  return {
    get(thread, turn) {
      const entry = routes.get(`${thread}:${turn}`);
      return entry && now() - entry.at < routeTtl ? entry.route : null;
    },
    set(thread, turn, route) {
      if (!safeId(thread) || !safeId(turn)) return;
      routes.delete(`${thread}:${turn}`);
      routes.set(`${thread}:${turn}`, { route: { model: route.model, effort: route.effort, reason: route.reason }, at: now() });
      for (const [key, entry] of routes) if (now() - entry.at >= routeTtl) routes.delete(key);
      while (routes.size > 1000) routes.delete(routes.keys().next().value);
      const entries = [...routes].map(([key, value]) => { const [threadId, turnId] = key.split(':'); return { threadId, turnId, ...value }; });
      try { writeJson(path, { version: 1, baseline, entries }); state = 'ready'; } catch { state = 'unavailable'; }
    },
    status() { return { state, entries: routes.size, ttlMs: routeTtl }; },
  };
}
