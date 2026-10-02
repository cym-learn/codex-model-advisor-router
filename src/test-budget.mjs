import { readJson, writeJson, safeId } from './local-state.mjs';

export function budgetClass(session, entry, threads = {}) {
  const ids = session.testThreadIds, thread = threads[entry.threadId];
  if (ids.includes(entry.threadId)) return 'registered_test';
  if (thread?.taskRole === 'child' && ids.includes(thread.rootThreadId)) return 'verified_child';
  if (thread?.rootThreadId && !ids.includes(thread.rootThreadId)) return 'other_independent';
  if (session.windows.some((w) => entry.at >= w.startedAt && (!w.endedAt || entry.at <= w.endedAt))) return 'unknown_window';
  return 'outside_window';
}
export function testBudget(sessionPath, ledgerPath) {
  let threads = {};
  function load() {
    let session;
    try { session = readJson(sessionPath); } catch (error) { return error.code === 'ENOENT' ? null : { error: true }; }
    if (session.version !== 1 || !safeId(session.id) || !Number.isInteger(session.budget) || session.budget < 1 ||
        !Array.isArray(session.testThreadIds) || !session.testThreadIds.every(safeId) || !Array.isArray(session.windows) ||
        !session.windows.every((w) => typeof w.startedAt === 'string' && (!w.endedAt || typeof w.endedAt === 'string'))) return { error: true };
    let ledger = { version: 1, sessionId: session.id, entries: [] };
    try { ledger = readJson(ledgerPath); if (ledger.sessionId !== session.id || ledger.version !== 1 || !Array.isArray(ledger.entries)) return { error: true, session }; }
    catch { return { error: true, session }; }
    if (!ledger.entries.every((r) => typeof r.key === 'string' && /^[a-zA-Z0-9_-]+:\d+$/.test(r.key) &&
        typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) && (r.threadId === null || safeId(r.threadId)) &&
        (r.turnId === null || safeId(r.turnId)))) return { error: true, session };
    return { session, ledger };
  }
  function summary(data) {
    if (!data) return null;
    if (data.error) return { state: 'unavailable', remaining: 0 };
    const { session, ledger } = data;
    const entries = [...new Map(ledger.entries.map((r) => [r.key, r])).values()];
    const counts = { registered_test: 0, verified_child: 0, unknown_window: 0, other_independent: 0, outside_window: 0 };
    for (const entry of entries) counts[budgetClass(session, entry, threads)]++;
    const used = counts.registered_test + counts.verified_child + counts.unknown_window;
    return { state: session.closedAt ? 'closed' : 'open', sessionId: session.id, limit: session.budget, used,
      remaining: Math.max(0, session.budget - used), counts, windowOpen: session.windows.some((w) => !w.endedAt) };
  }
  return {
    targets() { const d = load(); return d?.ledger?.entries.map(({ threadId, turnId }) => ({ threadId, turnId })) ?? []; },
    snapshot(metadata) { if (metadata?.threads) threads = metadata.threads; return summary(load()); },
    reserve(entry, registered = []) {
      const d = load(); if (!d || d.session?.closedAt) return { allowed: true };
      const knownTest = registered.includes(entry.threadId) || d.session?.testThreadIds.includes(entry.threadId) ||
        d.session?.testThreadIds.includes(threads[entry.threadId]?.rootThreadId);
      if (d.error) return { allowed: !knownTest, reason: 'test_budget_unavailable' };
      const kind = budgetClass(d.session, entry, threads), status = summary(d);
      if (['registered_test','verified_child'].includes(kind) && status.remaining === 0) return { allowed: false, reason: 'test_budget_exhausted' };
      if (kind === 'outside_window') return { allowed: true };
      if (!d.ledger.entries.some((r) => r.key === entry.key)) d.ledger.entries.push(entry);
      try { writeJson(ledgerPath, d.ledger); } catch { return { allowed: !knownTest, reason: 'test_budget_unavailable' }; }
      return { allowed: true };
    },
  };
}
