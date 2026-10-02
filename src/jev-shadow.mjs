import { openSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, safeId } from './local-state.mjs';
import { askJev, jevContext, loadCredential, jevPolicyVersion, safeJevResult } from './jev.mjs';

export function initJevBudget(path, limit = 60) {
  try { const existing = readJson(path); if (existing.version !== 1 || existing.limit !== limit || !Array.isArray(existing.entries)) throw Error(); return existing; }
  catch (error) { if (error.code !== 'ENOENT') throw Error('Jev budget exists but is incompatible; do not reset it.'); }
  const ledger = { version: 1, id: randomUUID(), limit, entries: [] }; writeJson(path, ledger); return ledger;
}
export function jevBudget(path) {
  function load() { const d = readJson(path);
    if (d.version !== 1 || !safeId(d.id) || !Number.isInteger(d.limit) || d.limit < 1 || d.limit > 60 || !Array.isArray(d.entries) ||
      !d.entries.every((e) => safeId(e.id) && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)))) throw Error();
    return d;
  }
  return {
    snapshot() { try { const d = load(); return { state: 'ready', id: d.id, used: d.entries.length, limit: d.limit, remaining: Math.max(0, d.limit - d.entries.length) }; }
      catch { return { state: 'unavailable', remaining: 0 }; } },
    reserve(id = randomUUID()) {
      let fd;
      try { fd = openSync(`${path}.lock`, 'wx'); const d = load();
        if (!safeId(id) || d.entries.some((e) => e.id === id)) return { allowed: false, reason: 'duplicate_call' };
        if (d.entries.length >= d.limit) return { allowed: false, reason: 'jev_budget_exhausted' };
        d.entries.push({ id, at: new Date().toISOString() }); writeJson(path, d); return { allowed: true, id };
      } catch { return { allowed: false, reason: 'jev_budget_unavailable' }; }
      finally { if (fd !== undefined) { closeSync(fd); try { unlinkSync(`${path}.lock`); } catch {} } }
    },
  };
}

export function jevShadow({ configPath, statePath, budgetPath, catalog, baseline, onEvent = () => {},
  credentialLoader = loadCredential, fetchImpl, timeoutMs = 5000 }) {
  const records = new Map(), pending = new Map();
  const budget = jevBudget(budgetPath);
  let persistence = 'ready', credentialPromise, unavailable = null;
  let failures = 0, cooldownUntil = 0, closed = false;
  const config = () => {
    try { const value = readJson(configPath);
      if (value.version !== 1 || !['off', 'shadow'].includes(value.mode) || !Array.isArray(value.threadIds) || !value.threadIds.every(safeId)) return { mode: 'off', threadIds: [], state: 'invalid' };
      return { ...value, state: 'ready' };
    } catch (e) { return { mode: 'off', threadIds: [], state: e.code === 'ENOENT' ? 'default' : 'invalid' }; }
  };
  try { const saved = readJson(statePath);
    if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > 1000 || !saved.entries.every((e) => safeId(e.threadId) && safeId(e.turnId) && Number.isFinite(e.at))) throw Error();
    for (const entry of saved.entries) if (Date.now() - entry.at < 7200000) {
      const restored = safeJevResult(entry.result);
      records.set(`${entry.threadId}:${entry.turnId}`, { threadId: entry.threadId, turnId: entry.turnId, at: entry.at,
        result: restored?.status === 'pending' ? { policyVersion: jevPolicyVersion, applied: false, status: 'failed', reason: 'interrupted', suggested: null }
          : restored ?? { policyVersion: jevPolicyVersion, applied: false, status: 'skipped', reason: 'previously_registered', suggested: null } });
    }
  } catch (e) { if (e.code !== 'ENOENT') persistence = 'unavailable'; }
  function persist() {
    for (const [key, entry] of records) if (Date.now() - entry.at >= 7200000 && !pending.has(key)) records.delete(key);
    while (records.size > 1000) { const key = [...records.keys()].find((k) => !pending.has(k)); if (!key) break; records.delete(key); }
    try { writeJson(statePath, { version: 1, entries: [...records.values()].map(({ threadId, turnId, at, result }) => ({ threadId, turnId, at, result: safeJevResult(result) })) }); return true; }
    catch { persistence = 'unavailable'; return false; }
  }
  function emit(record, id, result) {
    record.result = result;
    persist();
    onEvent({ id, event: 'jev', threadId: record.threadId, turnId: record.turnId, jev: result });
  }
  return {
    snapshot() { const c = config(); return { mode: c.mode, provider: 'opencode_zen', model: 'jev-1.13-free',
      state: unavailable ?? (persistence === 'unavailable' ? 'persistence_unavailable' : c.state), pending: pending.size,
      policyVersion: jevPolicyVersion, applied: false, budget: budget.snapshot(), registeredThreads: c.threadIds.length }; },
    get(threadId, turnId) { return records.get(`${threadId}:${turnId}`)?.result ?? null; },
    start({ id, threadId, turnId, client, body, signal }) {
      const c = config();
      if (closed || c.mode !== 'shadow' || client !== 'desktop' || !safeId(threadId) || !safeId(turnId) || !c.threadIds.includes(threadId)) return;
      const key = `${threadId}:${turnId}`;
      const existing = records.get(key);
      if (existing && Date.now() - existing.at < 7200000) { emit(existing, id, existing.result); return; }
      const prepared = jevContext(body, baseline);
      const record = { threadId, turnId, at: Date.now() }; records.set(key, record);
      let reason = prepared.skip ?? unavailable ?? (persistence === 'unavailable' ? 'persistence_unavailable' :
        pending.size >= 2 ? 'busy' : cooldownUntil > Date.now() ? 'cooldown' : null);
      if (!persist()) reason = 'persistence_unavailable';
      if (reason) { emit(record, id, { policyVersion: jevPolicyVersion, applied: false, status: 'skipped', reason, suggested: null }); return; }
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      pending.set(key, controller);
      emit(record, id, { policyVersion: jevPolicyVersion, applied: false, status: 'pending', reason: null, suggested: null });
      void (async () => {
        credentialPromise ??= credentialLoader();
        const secret = await credentialPromise;
        if (!secret) { unavailable = 'credential_unavailable'; return { status: 'skipped', reason: unavailable }; }
        if (controller.signal.aborted) return { status: 'skipped', reason: 'cancelled' };
        if (config().mode !== 'shadow') return { status: 'skipped', reason: 'disabled' };
        const permit = budget.reserve(); if (!permit.allowed) return { status: 'skipped', reason: permit.reason };
        const result = await askJev({ state: prepared.state, catalog: typeof catalog === 'function' ? catalog() : catalog,
          key: secret, fetchImpl, timeoutMs, signal: controller.signal });
        result.callId = permit.id;
        if (['authentication_failed', 'free_service_unavailable'].includes(result.reason)) unavailable = result.reason;
        if (result.status === 'failed') { if (++failures >= 3) cooldownUntil = Date.now() + 60000; } else failures = 0;
        return result;
      })().catch(() => ({ status: 'failed', reason: 'internal_error' })).then((result) => {
        emit(record, id, { policyVersion: jevPolicyVersion, applied: false, suggested: null, ...result });
      }).finally(() => { pending.delete(key); signal?.removeEventListener('abort', abort); });
    },
    close() { closed = true; for (const controller of pending.values()) controller.abort(); },
  };
}
