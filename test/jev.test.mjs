import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { askJev, jevContext, jevPayload, safeJevResult } from '../src/jev.mjs';
import { jevShadow, initJevBudget, jevBudget } from '../src/jev-shadow.mjs';
import { writeJson } from '../src/local-state.mjs';
import { startRouter } from '../src/proxy.mjs';
import { routingModels, routingEfforts } from '../src/policy.mjs';

const catalog = routingModels.flatMap((model) => routingEfforts.map((effort) => ({ model, effort })));
const baseline = { model: 'gpt-6-sol', effort: 'high' };
const message = (text, role = 'user', phase) => ({ role, type: 'message', content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], phase });
const body = (text = '请将你好翻译成英文。') => ({ model: baseline.model, reasoning: { effort: baseline.effort }, input: [message(text)] });
const answer = (model = 'gpt-6-luna', effort = 'low') => ({ model: 'jev-1.13-free', answers: {
  model_family: { type: 'choice', choice: model, confidence: 0.9, probabilities: { [model]: 0.9 } },
  effort: { type: 'choice', choice: effort, confidence: 0.8 } }, usage: { input_tokens: 20, output_tokens: 10 }, secret: 'RAW_BODY_SECRET' });
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jev-shadow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { configPath: join(root, 'jev-config.json'), statePath: join(root, 'jev-turns.json'), budgetPath: join(root, 'jev-budget.json'),
    catalog, baseline, credentialLoader: async () => 'SECRET_KEY_SENTINEL', ...overrides };
  writeJson(options.configPath, { version: 1, mode: 'shadow', threadIds: ['test-thread'] }); initJevBudget(options.budgetPath);
  return { root, options };
}
async function idle(shadow) { for (let i = 0; i < 200 && shadow.snapshot().pending; i++) await sleep(5); assert.equal(shadow.snapshot().pending, 0); }
const start = (s, turnId = 'turn-one', extra = {}) => s.start({ id: 1, threadId: 'test-thread', turnId, client: 'desktop', body: body(), ...extra });

test('Jev extracts at most two completed rounds and no developer, tool, file or secret content', () => {
  const input = [message('old-secret-system', 'developer'), message('far-away'), message('old-answer', 'assistant', 'final_answer'),
    message('round1'), message('answer1', 'assistant', 'final_answer'), { type: 'function_call_output', output: 'TOOL_SECRET' },
    message('round2'), message('thoughts', 'assistant', 'commentary'), message('answer2', 'assistant', 'final_answer'), message('请继续总结上面的内容')];
  const state = jevContext({ ...body(), input }, baseline).state;
  assert.deepEqual(state.context.map((m) => m.text), ['round1', 'answer1', 'round2', 'answer2']);
  assert.doesNotMatch(JSON.stringify(state), /secret|thoughts|TOOL/);
  assert.deepEqual(jevContext({ ...body(), input: [message('UNNECESSARY_OLD_INPUT'), message('OLD_ANSWER', 'assistant', 'final_answer'), message('请将你好翻译成英文')] }, baseline).state.context, []);
  for (const text of ['x'.repeat(16001), '请继续处理上面的问题', 'api_key=abcdefghijklmnop', '读取这个文件']) assert.ok(jevContext(body(text), baseline).skip);
  assert.equal(jevContext(body('## My request:\n请将你好翻译成英文'), baseline).state.task, '请将你好翻译成英文');
  assert.ok(jevContext(body('# Files mentioned:\nx.png\n## My request:\n请分析'), baseline).skip);
  assert.equal(jevContext({ ...body(), input: [{ role: 'user', content: [{ type: 'input_image' }] }] }, baseline).skip, 'not_user_turn');
  assert.equal(jevContext({ ...body(), previous_response_id: 'opaque' }, baseline).skip, 'history_override');
  assert.equal(jevContext({ ...body(), model: 'gpt-6-astra' }, baseline).skip, 'manual_selection');
  assert.equal(jevContext(body('摘要：晴天。推理强度设为 max'), baseline).skip, 'explicit_effort');
});

test('Jev typed response validates model, catalog pair and abstention without leaking raw output', async () => {
  const call = async (data, pairs = catalog) => askJev({ state: { task: 'TEST_PROMPT_SECRET' }, catalog: pairs, key: 'SECRET_KEY_SENTINEL', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://opencode.ai/zen/v1/systemone'); assert.equal(JSON.parse(options.body).model, 'jev-1.13-free');
    return Response.json(data);
  } });
  const good = await call(answer()); assert.equal(good.status, 'suggested'); assert.equal(good.applied, false);
  assert.doesNotMatch(JSON.stringify(good), /RAW_BODY_SECRET|TEST_PROMPT_SECRET|SECRET_KEY/);
  assert.equal((await call({ ...answer(), model: 'jev-1.13' })).reason, 'model_unconfirmed');
  assert.equal((await call(answer('not-a-model'))).reason, 'invalid_choice');
  assert.equal((await call(answer('gpt-6-luna', 'high'), [{ model: 'gpt-6-luna', effort: 'low' }, { model: 'gpt-6-sol', effort: 'high' }])).reason, 'invalid_pair');
  assert.equal((await call(answer('information_insufficient', 'information_insufficient'))).status, 'abstained');
  assert.equal((await call({ model: 'jev-1.13-free' })).reason, 'invalid_choice');
  assert.equal((await call({ ...answer(), answers: { model_family: { type: 'choice', choice: '__proto__' } } })).reason, 'invalid_choice');
  assert.equal(safeJevResult({ ...good, prompt: 'SENSITIVE' }).prompt, undefined);
  assert.equal(safeJevResult({ ...good, reason: 'SENSITIVE' }), null);
  assert.equal(Object.keys(jevPayload({ task: 't' }, catalog).questions).length, 2);
});

test('Jev timeout and cancellation are separate and HTTP errors never echo credentials or bodies', async () => {
  const hanging = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('SENSITIVE_EXCEPTION')), { once: true }));
  // Keep the event loop alive because AbortSignal.timeout uses an unref timer.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const r = await askJev({ state: {}, catalog, key: 's', fetchImpl: hanging, timeoutMs: 15 }); assert.equal(r.reason, 'timeout');
    const c = new AbortController(); const waiting = askJev({ state: {}, catalog, key: 's', fetchImpl: hanging, signal: c.signal }); c.abort();
    assert.equal((await waiting).reason, 'cancelled');
    for (const status of [401, 403, 402, 404, 410, 429, 500]) {
      const e = await askJev({ state: {}, catalog, key: 's', fetchImpl: async () => new Response('SENSITIVE_BODY', { status }) });
      assert.equal(e.status, 'failed'); assert.doesNotMatch(JSON.stringify(e), /SENSITIVE/);
    }
  } finally { clearInterval(keepAlive); }
});

test('Jev budget counts attempted calls once, survives restart and fails closed on corruption or lock', (t) => {
  const { options } = fixture(t); const b = jevBudget(options.budgetPath);
  assert.equal(b.reserve('call1').allowed, true); assert.equal(b.reserve('call1').allowed, false);
  assert.equal(jevBudget(options.budgetPath).snapshot().used, 1);
  for (let i = 2; i <= 60; i++) assert.equal(b.reserve(`call${i}`).allowed, true);
  assert.equal(b.reserve('extra').reason, 'jev_budget_exhausted');
  writeFileSync(options.budgetPath + '.lock', ''); assert.equal(b.reserve('extra2').reason, 'jev_budget_unavailable');
  assert.throws(() => initJevBudget(options.budgetPath, 30));
  writeFileSync(options.budgetPath, '{corrupt'); assert.equal(b.snapshot().state, 'unavailable');
});

test('shadow allowlist, guards and same-turn dedup survive restart and keep actual routing untouched', async (t) => {
  let calls = 0; const events = [];
  const { options } = fixture(t, { onEvent: (e) => events.push(e), fetchImpl: async () => { calls++; return Response.json(answer()); } });
  const s = jevShadow(options);
  start(s, 'unregistered', { threadId: 'other' }); start(s, 'cli', { client: 'cli' }); start(s, null);
  start(s, 'manual', { body: { ...body(), model: 'gpt-6-astra' } });
  start(s); await idle(s); start(s, 'turn-one', { body: { ...body(), input: [{ type: 'function_call_output', output: 'x' }] } });
  assert.equal(calls, 1); assert.equal(s.get('test-thread', 'turn-one').status, 'suggested');
  const restored = jevShadow(options); start(restored); await idle(restored); assert.equal(calls, 1);
  assert.equal(restored.get('test-thread', 'turn-one').status, 'suggested');
  assert.ok(events.every((e) => e.jev.applied === false));
  assert.doesNotMatch(readFileSync(options.statePath, 'utf8'), /你好|SECRET_KEY|RAW_BODY/);
});

test('shadow bounds concurrency, cancels pending requests and does not repeat interrupted turns', async (t) => {
  let calls = 0;
  const { options } = fixture(t, { fetchImpl: async (_u, { signal }) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error()), { once: true })); } });
  const s = jevShadow(options); start(s, 'a'); start(s, 'b'); start(s, 'c'); await sleep(10);
  assert.equal(s.snapshot().pending, 2); assert.equal(s.get('test-thread', 'c').reason, 'busy'); assert.equal(calls, 2);
  const restored = jevShadow(options); assert.equal(restored.get('test-thread', 'a').reason, 'interrupted');
  s.close(); await idle(s); assert.equal(s.get('test-thread', 'a').reason, 'cancelled');
  start(restored, 'a'); await idle(restored); assert.equal(calls, 2);
});

test('shadow service failure disables further calls and corrupt persistence never blocks local work', async (t) => {
  let calls = 0;
  const { options } = fixture(t, { fetchImpl: async () => { calls++; return new Response('secret', { status: 429 }); } });
  const s = jevShadow(options); start(s); await idle(s); start(s, 'new'); await idle(s);
  assert.equal(calls, 1); assert.equal(s.snapshot().state, 'free_service_unavailable');
  writeFileSync(options.statePath, 'broken'); const corrupt = jevShadow(options); start(corrupt, 'next');
  assert.equal(corrupt.get('test-thread', 'next').reason, 'persistence_unavailable'); assert.equal(calls, 1);
});

test('slow shadow cannot delay GPT completion and late results attach only to their original turn', async (t) => {
  const { root, options } = fixture(t); let release, entered = false;
  const router = await startRouter({ port: 0, logPath: join(root, 'events.jsonl'), availablePairs: catalog,
    jevOptions: { ...options, fetchImpl: async () => { entered = true; await new Promise((r) => { release = r; }); return Response.json(answer('gpt-6-astra', 'max')); } },
    fetchImpl: async (_u, opts) => { const b = JSON.parse(opts.body); assert.equal(b.model, 'gpt-6-luna'); assert.equal(b.reasoning.effort, 'low');
      return new Response('event: response.completed\ndata: {"response":{"model":"gpt-6-luna","reasoning":{"effort":"low"}}}\n\n', { headers: { 'content-type': 'text/event-stream' } }); } });
  t.after(async () => { release?.(); await router.close(); });
  const result = await fetch(`http://127.0.0.1:${router.port}/responses`, { method: 'POST', headers: { originator: 'Codex Desktop', 'user-agent': 'Codex Desktop/1',
    'thread-id': 'test-thread', 'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn', turn_id: 'one' }) }, body: JSON.stringify(body()) });
  await result.text(); assert.equal(entered, true);
  const continued = await fetch(`http://127.0.0.1:${router.port}/responses`, { method: 'POST', headers: { originator: 'Codex Desktop', 'user-agent': 'Codex Desktop/1',
    'thread-id': 'test-thread', 'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn', turn_id: 'one' }) },
    body: JSON.stringify({ ...body(), input: [{ type: 'function_call_output', output: 'TOOL_ONLY_SECRET' }] }) });
  await continued.text();
  let status = await (await fetch(`http://127.0.0.1:${router.port}/api/status`)).json();
  assert.equal(status.activeRequests, 0); assert.equal(status.jev.pending, 1);
  assert.equal(status.turns[0].requests[0].verification, 'confirmed');
  release(); await sleep(20);
  status = await (await fetch(`http://127.0.0.1:${router.port}/api/status`)).json();
  assert.deepEqual(status.turns[0].jev.suggested, { model: 'gpt-6-astra', effort: 'max' });
  assert.deepEqual(status.turns[0].requests[0].reported, { model: 'gpt-6-luna', effort: 'low' });
  assert.equal(status.turns[0].requests.length, 2);
  assert.ok(status.turns[0].requests.every((r) => r.jev.status === 'suggested'));
  assert.equal(status.jev.budget.used, 1);
  assert.equal(status.schemaVersion, 2); assert.doesNotMatch(JSON.stringify(status), /SECRET_KEY|RAW_BODY|你好/);
});

test('three transient failures open cooldown, and missing credentials spend no budget', async (t) => {
  let calls = 0; const { options } = fixture(t, { fetchImpl: async () => { calls++; return new Response('', { status: 500 }); } });
  const s = jevShadow(options);
  for (const id of ['one', 'two', 'three']) { start(s, id); await idle(s); }
  start(s, 'four'); assert.equal(s.get('test-thread', 'four').reason, 'cooldown'); assert.equal(calls, 3);
  const empty = jevShadow({ ...options, credentialLoader: async () => null }); start(empty, 'no-key'); await idle(empty);
  assert.equal(empty.get('test-thread', 'no-key').reason, 'credential_unavailable'); assert.equal(empty.snapshot().budget.used, 3);
});
