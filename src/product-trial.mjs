import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { creditEstimate, creditRateCard } from './cost-080.mjs';

const limits = Object.freeze({ gpt: 48, jev: 12, credits: 20 });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, data) => { const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(data, null, 2)); renameSync(temp, path); };
const validId = id => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
const count = n => Number.isSafeInteger(n) && n >= 0;

// This initializer never adopts or resets an existing ledger, including a closed one.
export function initializeProductTrial({ configPath, ledgerPath, threadIds, expiresAt, authorization, outputTokenLimit = 4096, allowConnectionChecks = false }) {
  configPath = resolve(configPath); ledgerPath = resolve(ledgerPath);
  const manifestPath = `${ledgerPath}.manifest.json`;
  if ([configPath, ledgerPath, manifestPath].some(existsSync)) throw new Error('trial_files_already_exist');
  if (!Array.isArray(threadIds) || !threadIds.length || !threadIds.every(validId) || new Set(threadIds).size !== threadIds.length ||
      !(Date.parse(expiresAt) > Date.now()) || typeof authorization !== 'string' || !authorization.trim() ||
      !Number.isSafeInteger(outputTokenLimit) || outputTokenLimit < 1) throw new Error('invalid_trial_authorization');
  const trialId = randomUUID(), createdAt = new Date().toISOString();
  const manifest = { version: 1, trialId, createdAt, authorization, configPath, ledgerPath, threadIds, expiresAt,
    limits, outputTokenLimit, allowConnectionChecks, policy: 'research-v5b-r10', estimateNotice: 'Estimated credit stop threshold; not an actual billing cap. Subscription attribution unknown.' };
  mkdirSync(dirname(configPath), { recursive: true }); mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  writeFileSync(ledgerPath, JSON.stringify({ version: 1, trialId, entries: [], blockedReason: null }), { flag: 'wx' });
  const config = { version: 1, trialId, enabled: true, threadIds, expiresAt, ledgerPath, manifestPath, outputTokenLimit, allowConnectionChecks };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { flag: 'wx' });
  return config;
}

export function productTrial({ configPath }) {
  configPath = resolve(configPath);
  const owned = new Set();
  function state() {
    if (!existsSync(configPath)) return null;
    const c = read(configPath);
    if (c.version !== 1 || !Array.isArray(c.threadIds) || !c.threadIds.every(validId)) throw new Error('invalid_trial_config');
    const m = read(c.manifestPath), l = read(c.ledgerPath);
    if (m.version !== 1 || l.version !== 1 || m.trialId !== c.trialId || l.trialId !== c.trialId ||
        m.configPath !== configPath || m.ledgerPath !== resolve(c.ledgerPath) || !m.authorization ||
        JSON.stringify(m.threadIds) !== JSON.stringify(c.threadIds) || m.expiresAt !== c.expiresAt ||
        m.outputTokenLimit !== c.outputTokenLimit || m.allowConnectionChecks !== c.allowConnectionChecks ||
        JSON.stringify(m.limits) !== JSON.stringify(limits) || !Array.isArray(l.entries)) throw new Error('trial_manifest_mismatch');
    if (new Set(l.entries.map(e => e?.id)).size !== l.entries.length || l.entries.some(e =>
      !validId(e?.id) || !['gpt', 'jev'].includes(e.kind) || !['pending', 'unknown', 'settled'].includes(e.status) ||
      !Number.isFinite(e.holdCredits) || e.holdCredits < 0 ||
      (e.credits != null && (!Number.isFinite(e.credits) || e.credits < 0)) ||
      (e.kind === 'gpt' && e.status === 'settled' && e.credits == null))) throw new Error('invalid_trial_ledger');
    if(l.costExceptions!==undefined&&(!Array.isArray(l.costExceptions)||new Set(l.costExceptions.map(x=>x.entryId)).size!==l.costExceptions.length||l.costExceptions.some(x=>{
      const e=l.entries.find(e=>e.id===x.entryId);
      return !e||e.kind!=='gpt'||e.status!=='unknown'||typeof x.authorization!=='string'||!x.authorization.trim()||!Number.isFinite(Date.parse(x.at))||!Number.isFinite(x.reservedCredits)||x.reservedCredits<=0||x.reservedCredits<e.holdCredits;
    })))throw Error('invalid_cost_exception');
    return { c, m, l };
  }
  function reason(s) {
    if (!s.c.enabled) return 'trial_disabled';
    if (!(Date.parse(s.c.expiresAt) > Date.now())) return 'trial_expired';
    const unresolved=s.l.entries.some(e=>e.status==='unknown'&&!(s.l.costExceptions??[]).some(x=>x.entryId===e.id));
    if (s.l.blockedReason && !(s.l.blockedReason==='cost_unconfirmed'&&!unresolved)) return s.l.blockedReason;
    if (s.l.entries.some(e => e.status === 'pending' && !owned.has(e.id))) return 'unsettled_prior_request';
    if (unresolved) return 'cost_unconfirmed';
    const t = totals(s.l);
    if (t.gpt >= limits.gpt || t.jev >= limits.jev || t.knownCredits + t.heldCredits >= limits.credits) return 'trial_budget_exhausted';
    return null;
  }
  function totals(l) {
    return { gpt: l.entries.filter(e => e.kind === 'gpt').length, jev: l.entries.filter(e => e.kind === 'jev').length,
      knownCredits: l.entries.reduce((n, e) => n + (e.credits ?? 0), 0),
      unknownCostCount:l.entries.filter(e=>e.status==='unknown').length,
      exceptionReservedCredits:(l.costExceptions??[]).reduce((n,x)=>n+x.reservedCredits,0),
      heldCredits: l.entries.filter(e => e.status === 'pending').reduce((n, e) => n + (e.holdCredits ?? 0), 0)+(l.costExceptions??[]).reduce((n,x)=>n+x.reservedCredits,0) };
  }
  function scope(threadId) {
    try { const s = state(); if (!s) return 'unrestricted'; if (!s.c.threadIds.includes(threadId)) return 'excluded'; return reason(s) ? 'blocked' : 'allowed'; }
    catch { return 'blocked'; }
  }
  function transaction(fn) {
    const lock = `${configPath}.lock`;
    try { mkdirSync(lock); } catch { return { allowed: false, tracked: false, reason: 'trial_lock_unavailable' }; }
    try { return fn(); } catch { return { allowed: false, tracked: false, reason: 'trial_persistence_invalid' }; }
    finally { rmdirSync(lock); }
  }
  function reserve(kind, args) {
    if (!existsSync(configPath)) return { allowed: true, tracked: false };
    return transaction(() => {
      const s = state();
      const check = kind === 'jev' && args.isConnectionCheck === true && args.threadId == null && s.c.allowConnectionChecks;
      if (!check && !s.c.threadIds.includes(args.threadId)) return args.isConnectionCheck ? { allowed: false, tracked: false, reason: 'connection_check_not_authorized' } : { allowed: true, tracked: false };
      const stop = reason(s);
      if (stop) return { allowed: false, tracked: false, reason: stop };
      if (!validId(args.id) || s.l.entries.some(e => e.id === args.id)) return { allowed: false, tracked: false, reason: 'duplicate_or_invalid_request_id' };
      let holdCredits = 0, maxOutputTokens = null, inputByteBound = null;
      if (kind === 'gpt') {
        const body = args.body;
        if (!body || !Array.isArray(args.catalog) || !args.catalog.length) return { allowed: false, tracked: false, reason: 'request_estimate_unavailable' };
        maxOutputTokens = Math.min(body.max_output_tokens ?? s.c.outputTokenLimit, s.c.outputTokenLimit);
        const encoded = JSON.stringify(body);
        // Images/audio, server-side history and opaque file references cannot be byte-bounded here.
        if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || body.previous_response_id || body.conversation ||
            /"(?:input_image|input_audio|input_file|file_id|image_url|audio_url)"/.test(encoded)) return { allowed: false, tracked: false, reason: 'request_estimate_unavailable' };
        const models = [body.model];
        if (!models.length || models.some(model => !creditRateCard.rates[model])) return { allowed: false, tracked: false, reason: 'rate_missing' };
        // One token per UTF-8 byte plus a framing allowance is a reservation, never measured usage.
        inputByteBound = Buffer.byteLength(encoded, 'utf8') + 8192;
        const speed = args.speedMode ?? (body.service_tier === 'default' ? 'standard' : null);
        if (!Object.hasOwn(creditRateCard.speedMultipliers, speed ?? '')) return { allowed: false, tracked: false, reason: 'speed_unconfirmed' };
        holdCredits = Math.max(...models.map(model => { const r = creditRateCard.rates[model]; return (inputByteBound * r[0] + maxOutputTokens * r[2]) / 1e6 * creditRateCard.speedMultipliers[speed]; }));
        const t = totals(s.l);
        if (t.knownCredits + t.heldCredits + holdCredits > limits.credits) return { allowed: false, tracked: false, reason: 'credit_reservation_exceeds_budget', holdCredits };
      }
      const entry = { id: args.id, kind, threadId: args.threadId ?? null, isConnectionCheck: check, status: 'pending', startedAt: new Date().toISOString(), holdCredits, maxOutputTokens, inputByteBound,
        requestedModel: kind === 'gpt' ? args.body.model : null, outputLimitEnforced: false };
      s.l.entries.push(entry); save(s.c.ledgerPath, s.l); owned.add(args.id);
      return { allowed: true, tracked: true, id: args.id, holdCredits, maxOutputTokens };
    });
  }
  function settle(id, kind, data) {
    return transaction(() => {
      const s = state(); if (!s) return { allowed: false, reason: 'trial_missing' };
      const e = s.l.entries.find(entry => entry.id === id && entry.kind === kind);
      if (!e || e.status !== 'pending') return { allowed: false, reason: 'reservation_missing_or_settled' };
      e.finishedAt = new Date().toISOString();
      if (kind === 'gpt') {
        const estimate = creditEstimate({ verification: data?.completedEvent === true && !data.failedEvent && !data.responseIdConflict ? 'confirmed' : 'unconfirmed',
          completionReported: { model: data?.completedModel }, reported: { model: data?.completedModel }, usage: data?.usage, speedMode: data?.speedMode });
        e.estimate = estimate; e.credits = estimate.value; e.status = estimate.value == null ? 'unknown' : 'settled';
        e.model = data?.completedModel ?? null; e.effort = data?.completedEffort ?? null;
        e.usage = safeUsage(data?.usage); e.speedMode = data?.speedMode ?? null;
        if (estimate.value == null) s.l.blockedReason = 'cost_unconfirmed';
        else if (estimate.value > e.holdCredits) s.l.blockedReason = 'reservation_exceeded';
        else if (data.completedModel !== e.requestedModel) s.l.blockedReason = 'execution_model_mismatch';
        else if (data.usage.inputTokens > e.inputByteBound || data.usage.outputTokens > e.maxOutputTokens) s.l.blockedReason = 'token_reservation_exceeded';
      } else {
        e.status = 'settled'; e.resultStatus = typeof data?.status === 'string' ? data.status : 'unknown';
        e.usage = safeUsage(data?.usage); e.providerCost = { currency: 'USD', value: null, evidence: 'not_verified' };
        if (!count(e.usage?.inputTokens) || !count(e.usage?.outputTokens) || data?.status === 'failed') {
          e.status = 'unknown'; s.l.blockedReason = 'jev_usage_unconfirmed';
        }
        // Jev provider USD is deliberately not added to Codex credit estimates.
      }
      save(s.c.ledgerPath, s.l); owned.delete(id);
      return { allowed: true, tracked: true, entry: e };
    });
  }
  return { scope, reserveGpt: args => reserve('gpt', args), reserveJev: args => reserve('jev', args),
    acknowledgeUnknownCost: (entryId,{authorization,reservedCredits})=>transaction(()=>{
      const s=state(),e=s?.l.entries.find(e=>e.id===entryId);
      if(!e||e.kind!=='gpt'||e.status!=='unknown'||typeof authorization!=='string'||!authorization.trim()||!Number.isFinite(reservedCredits)||reservedCredits<=0||reservedCredits<e.holdCredits||(s.l.costExceptions??[]).some(x=>x.entryId===entryId))return {allowed:false,reason:'invalid_cost_exception'};
      s.l.costExceptions??=[];s.l.costExceptions.push({entryId,authorization,reservedCredits,at:new Date().toISOString()});save(s.c.ledgerPath,s.l);
      return {allowed:true,unknownCostPreserved:true,reservedCredits};
    }),
    settleGpt: (id, data) => settle(id, 'gpt', data), settleJev: (id, data) => settle(id, 'jev', data),
    snapshot() { try { const s = state(); return s ? { enabled: s.c.enabled, trialId: s.c.trialId, expiresAt: s.c.expiresAt, limits, ...totals(s.l), blockedReason: reason(s), entries: s.l.entries } : { enabled: false, unrestricted: true }; } catch { return { enabled: false, blockedReason: 'trial_persistence_invalid' }; } } };
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  usage = { ...usage, inputTokens: usage.inputTokens ?? usage.input_tokens, outputTokens: usage.outputTokens ?? usage.output_tokens };
  return Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'].filter(k => count(usage[k])).map(k => [k, usage[k]]));
}
