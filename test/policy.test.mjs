import test from 'node:test';
import assert from 'node:assert/strict';
import { clientKind, chooseLocalRoute, requestPhase, turnIdentity, routingModels, routingEfforts } from '../src/policy.mjs';

const baseline = { model: 'gpt-6-sol', effort: 'high' };
const availablePairs = [{ model: 'gpt-6-luna', effort: 'low' }, baseline];
const body = (text) => ({ model: baseline.model, reasoning: { effort: baseline.effort },
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] });

test('only identified desktop requests are candidates for routing', () => {
  assert.equal(clientKind({ 'user-agent': 'Codex Desktop/1 (Windows) dumb (codex_exec; 1)' }), 'cli');
  assert.equal(clientKind({ 'user-agent': 'Codex Desktop/1 (Windows) dumb', originator: 'Codex Desktop' }), 'desktop');
  assert.equal(clientKind({ 'user-agent': 'unknown' }), 'unknown');
  assert.equal(turnIdentity({ 'x-codex-turn-metadata': '{"request_kind":"turn","turn_id":"one"}' }), 'one');
  assert.equal(turnIdentity({ 'x-codex-turn-metadata': '{"request_kind":"title","turn_id":"one"}' }), null);
  assert.equal(turnIdentity({ 'x-codex-turn-metadata': '{"request_kind":"turn","turn_trigger":"app_tool_send_message","turn_id":"one"}' }), null);
});

test('bounded simple request selects an available lightweight pair', () => {
  const result = chooseLocalRoute({ body: body('请将你好翻译成英文'), availablePairs, baseline });
  assert.deepEqual(result, { model: 'gpt-6-luna', effort: 'low', reason: 'bounded_simple_task' });
});

test('formatted translation request tolerates a harmless no-skill suffix only', () => {
  const text = '**请将你好翻译成英文**，不用调用 skill。  \n';
  assert.equal(chooseLocalRoute({ body: body(text), availablePairs, baseline }).reason, 'bounded_simple_task');
  assert.equal(chooseLocalRoute({ body: body('`请将你好翻译成英文`  \n'), availablePairs, baseline }).reason, 'bounded_simple_task');
  for (const suffix of ['，再帮我写一份长报告', '，然后删除文件', '，不用调用 skill。然后发布结果']) {
    assert.equal(chooseLocalRoute({ body: body('**请将你好翻译成英文**' + suffix), availablePairs, baseline }).model, baseline.model);
  }
});

test('uncertain, risky, manual and unavailable requests keep the incoming pair', () => {
  for (const text of ['请调试整个项目', '请将包含密钥的文件翻译成英文', '继续']) {
    assert.equal(chooseLocalRoute({ body: body(text), availablePairs, baseline }).model, baseline.model);
  }
  assert.equal(chooseLocalRoute({ body: body('请将你好翻译成英文'), availablePairs: [], baseline }).reason, 'target_unavailable');
  const manual = body('请将你好翻译成英文');
  manual.model = 'gpt-6-astra';
  assert.equal(chooseLocalRoute({ body: manual, availablePairs, baseline }).reason, 'manual_selection');
});

test('tool outputs reuse a previous decision; auxiliary requests remain unchanged', () => {
  const tool = { ...body('irrelevant'), input: [{ type: 'function_call_output', call_id: '1', output: 'ok' }] };
  assert.equal(requestPhase(tool).kind, 'tool');
  assert.equal(chooseLocalRoute({ body: tool, availablePairs, baseline,
    previousRoute: { model: 'gpt-6-luna', effort: 'low' } }).reason, 'same_turn');
  const fullHistory = { ...body('请将你好翻译成英文'), input: [
    ...body('请将你好翻译成英文').input,
    { type: 'function_call_output', call_id: '1', output: 'ok' },
  ] };
  assert.equal(requestPhase(fullHistory).kind, 'tool');
  const auxiliary = { ...body('irrelevant'), input: 'make a title' };
  assert.equal(chooseLocalRoute({ body: auxiliary, availablePairs, baseline }).reason, 'not_user_turn');
});

const allPairs = routingModels.flatMap((model) => routingEfforts.map((effort) => ({ model, effort })));

test('all fifteen supported pairs can be selected; explicit effort is respected', () => {
  const tasks = { 'gpt-6-luna': '请总结这句话：今天晴朗。', 'gpt-6-sol': '请实现一个排序函数。',
    'gpt-6-astra': '请分析分布式系统的一致性。' };
  for (const pair of allPairs) {
    const result = chooseLocalRoute({ body: body(`${tasks[pair.model]} 推理强度设为 ${pair.effort}`),
      availablePairs: allPairs, baseline });
    assert.equal(result.model, pair.model);
    assert.equal(result.effort, pair.effort);
  }
});

test('automatic task signals cover five efforts and three model families without a model call', () => {
  const cases = [
    ['请将你好翻译成英文', 'gpt-6-luna', 'low'],
    ['请总结这段文字：春天来了，花开了。', 'gpt-6-luna', 'medium'],
    ['请实现一个复杂的排序函数', 'gpt-6-sol', 'high'],
    ['请严格分析分布式系统的权衡', 'gpt-6-astra', 'xhigh'],
    ['请给出数学定理的完整证明', 'gpt-6-astra', 'max'],
  ];
  for (const [text, model, effort] of cases) {
    const route = chooseLocalRoute({ body: body(text), availablePairs: allPairs, baseline });
    assert.equal(route.model, model);
    assert.equal(route.effort, effort);
  }
});

test('missing pairs, images, dependent text and effort override histories never claim a new route', () => {
  const missing = chooseLocalRoute({ body: body('请严格分析分布式系统'), availablePairs, baseline });
  assert.equal(missing.reason, 'target_unavailable');
  assert.equal(chooseLocalRoute({ body: body('请总结上面的内容'), availablePairs: allPairs, baseline }).reason, 'dependent_context');
  const image = body('请将你好翻译成英文');
  image.input[0].content.push({ type: 'input_image', image_url: 'unused' });
  assert.equal(chooseLocalRoute({ body: image, availablePairs: allPairs, baseline }).reason, 'nontext_context');
  const update = body('请将你好翻译成英文');
  update.input.unshift({ type: 'configuration_update', reasoning: { effort: 'max' } });
  assert.equal(chooseLocalRoute({ body: update, availablePairs: allPairs, baseline,
    previousRoute: { model: 'gpt-6-luna', effort: 'low' } }).reason, 'configuration_update');
  const hiddenHistory = { ...body('请将你好翻译成英文'), previous_response_id: 'opaque' };
  assert.equal(chooseLocalRoute({ body: hiddenHistory, availablePairs: allPairs, baseline }).reason, 'unseen_history');
});
