import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRouter } from '../src/proxy.mjs';
import { routingModels, routingEfforts } from '../src/policy.mjs';

test('Desktop routes once, tool continuation stays routed, CLI and auxiliary pass through', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-model-router-'));
  const logPath = join(directory, 'events.jsonl');
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ body, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: response.created\ndata: {"response":{"model":"${body.model}","reasoning":{"effort":"${body.reasoning.effort}"}}}\n\nevent: response.completed\ndata: {"response":{"model":"${body.model}","reasoning":{"effort":"${body.reasoning.effort}"}}}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const router = await startRouter({ port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`,
    logPath, availablePairs: [{ model: 'gpt-6-luna', effort: 'low' }] });
  const send = async (input, agent, requestKind = 'turn') => {
    const response = await fetch(`http://127.0.0.1:${router.port}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer SECRET_SENTINEL', 'thread-id': 'thread-1',
        'content-type': 'application/json', 'user-agent': agent, originator: 'Codex Desktop',
        'x-codex-turn-metadata': JSON.stringify({ request_kind: requestKind, turn_id: 'turn-1' }) },
      body: JSON.stringify({ model: 'gpt-6-sol', reasoning: { effort: 'high' }, input, stream: true }),
    });
    assert.equal(response.status, 200);
    await response.text();
  };
  try {
    const user = (text) => [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }];
    await send(user('**请将你好翻译成英文**，不用调用 skill。  \n'), 'Codex Desktop/1 (Windows) dumb');
    await send([{ type: 'function_call_output', call_id: '1', output: 'TOOL_SENTINEL' }], 'Codex Desktop/1 (Windows) dumb');
    await send(user('请将你好翻译成英文'), 'Codex Desktop/1 (Windows) dumb (codex_exec; 1)');
    await send('make a title', 'Codex Desktop/1 (Windows) dumb', 'title');
    assert.deepEqual(received.map(({ body }) => [body.model, body.reasoning.effort]), [
      ['gpt-6-luna', 'low'], ['gpt-6-luna', 'low'], ['gpt-6-sol', 'high'], ['gpt-6-sol', 'high'],
    ]);
    assert.ok(received.every((item) => item.authorization === 'Bearer SECRET_SENTINEL'));
    const log = readFileSync(logPath, 'utf8');
    assert.doesNotMatch(log, /SECRET_SENTINEL|TOOL_SENTINEL|你好/);
    assert.match(log, /"completedModel":"gpt-6-luna"/);
    const snapshotResponse = await fetch(`http://127.0.0.1:${router.port}/api/status`);
    const snapshot = await snapshotResponse.json();
    const turn = snapshot.turns.find((item) => item.turnId === 'turn-1');
    assert.equal(turn.requests.length, 2);
    assert.ok(turn.requests.every((item) => item.verification === 'confirmed'));
    assert.equal(turn.threadId, 'thread-1');
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_SENTINEL|TOOL_SENTINEL|你好/);
    const page = await fetch(`http://127.0.0.1:${router.port}/`);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /dashboard.js/);
    assert.equal((await fetch(`http://127.0.0.1:${router.port}/api/status`, { method: 'POST' })).status, 403);
    const rejectedHost = await new Promise((resolve, reject) => {
      const probe = httpRequest({ hostname: '127.0.0.1', port: router.port, path: '/api/status',
        headers: { host: 'attacker.example' } }, (response) => { response.resume(); resolve(response.statusCode); });
      probe.on('error', reject); probe.end();
    });
    assert.equal(rejectedHost, 403);
  } finally {
    await router.close();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fifteen pairs traverse the proxy and appear as separately confirmed mock turns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'router-matrix-'));
  const availablePairs = routingModels.flatMap((model) => routingEfforts.map((effort) => ({ model, effort })));
  const received = [];
  const router = await startRouter({ port: 0, logPath: join(directory, 'events.jsonl'), availablePairs,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const pair = { model: body.model, effort: body.reasoning.effort };
      received.push(pair);
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ response: { model: pair.model,
        reasoning: { effort: pair.effort } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  const prompts = { 'gpt-6-luna': '请总结：阳光明媚。', 'gpt-6-sol': '请实现排序函数。', 'gpt-6-astra': '请分析分布式系统。' };
  try {
    for (const [index, pair] of availablePairs.entries()) {
      const response = await fetch(`http://127.0.0.1:${router.port}/responses`, { method: 'POST',
        headers: { 'user-agent': 'Codex Desktop/1', originator: 'Codex Desktop', 'thread-id': 'matrix',
          'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn', turn_id: `turn-${index}` }) },
        body: JSON.stringify({ model: 'gpt-6-sol', reasoning: { effort: 'high' },
          input: [{ role: 'user', content: `${prompts[pair.model]} 推理强度设为 ${pair.effort}` }] }) });
      await response.text();
    }
    assert.deepEqual(received, availablePairs);
    const snapshot = await (await fetch(`http://127.0.0.1:${router.port}/api/status`)).json();
    assert.equal(snapshot.turns.length, 15);
    assert.ok(snapshot.turns.every((turn) => turn.requests[0].verification === 'confirmed'));
  } finally { await router.close(); rmSync(directory, { recursive: true, force: true }); }
});
