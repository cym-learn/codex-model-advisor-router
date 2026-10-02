import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusSnapshot } from '../src/dashboard.mjs';

test('one Jev call counts its waiting time once across tool requests', () => {
  const pair={model:'gpt-6-sol',effort:'medium'};
  const records=[1,2,3].map(id=>({id,runId:'service',event:'request',path:'/responses',client:'desktop',threadId:'test',turnId:'turn',before:pair,after:pair,experiment:{runId:'eval',waitMs:1932,jev:{callId:'one-call'}}}));
  const snapshot=statusSnapshot({records,catalog:[pair],baseline:pair});
  assert.equal(snapshot.turns[0].experimentWaitMs,1932);
});

test('native interruption is terminal evidence, while missing local metadata still waits', () => {
  const pair = { model: 'gpt-6-sol', effort: 'xhigh' };
  const records = [];
  for (const [id, turnId, event] of [[1, 'stopped', 'cancelled'], [2, 'delayed', 'finished'], [3, 'closed', 'client_closed_after_complete']]) {
    records.push({ at: `2026-09-27T05:00:0${id}Z`, runId: 'run', id, event: 'request', path: '/responses',
      client: 'desktop', threadId: 'task', turnId, before: pair, after: pair, effortUpdate: false });
    records.push({ runId: 'run', id, event, status: 200, createdModel: pair.model, createdEffort: pair.effort,
      completedEvent: event !== 'cancelled', completedModel: event !== 'cancelled' ? pair.model : null,
      completedEffort: event !== 'cancelled' ? pair.effort : null,
      outputItems: [{ id: `msg_${turnId}`, role: 'assistant', phase: 'final_answer' }] });
  }
  const snapshot = statusSnapshot({ records, catalog: [pair], baseline: pair, runId: 'run', metadata: {
    turns: { 'task:stopped': { status: 'interrupted', finalItemId: null },
      'task:closed': { status: 'completed', finalItemId: 'msg_closed', finalPhase: 'final_answer' } }
  } });
  const stopped = snapshot.turns.find(t => t.turnId === 'stopped');
  assert.equal(stopped.nativeStatus, 'interrupted');
  assert.equal(stopped.finalReply.evidence, 'native_turn_interrupted');
  assert.equal(stopped.finalReply.status, 'unconfirmed');
  assert.equal(stopped.requests[0].verification, 'unconfirmed');
  assert.equal(stopped.requests[0].isFinalReply, false);
  assert.equal(snapshot.turns.find(t => t.turnId === 'delayed').finalReply.evidence, 'native_final_item_missing');
  assert.equal(snapshot.turns.find(t => t.turnId === 'closed').finalReply.status, 'confirmed');
});

test('status distinguishes confirmation, missing fields, mismatch, cancellation and effective effort uncertainty', () => {
  const directory = mkdtempSync(join(tmpdir(), 'router-status-'));
  const logPath = join(directory, 'events.jsonl');
  const pair = { model: 'gpt-6-luna', effort: 'low' };
  const records = [];
  for (const [index, scenario] of ['confirmed', 'missing', 'mismatch', 'cancelled', 'update'].entries()) {
    const id = index + 1;
    records.push({ at: `2026-09-26T04:00:0${id}.000Z`, runId: 'run1', id, event: 'request',
      path: '/v1/responses', client: 'desktop', before: pair, after: pair, turnId: scenario,
      threadId: 'task', effortUpdate: scenario === 'update', authorization: 'SECRET_SENTINEL' });
    records.push({ runId: 'run1', id, event: scenario === 'cancelled' ? 'cancelled' : 'finished', status: 200,
      completedEvent: scenario !== 'cancelled', completedModel: scenario === 'mismatch' ? 'gpt-6-sol' : pair.model,
      completedEffort: scenario === 'missing' ? null : pair.effort });
  }
  // IDs restart after the service restarts; records must not be merged with old requests.
  records.push({ at: '2026-09-26T04:01:00.000Z', runId: 'run2', id: 1, event: 'request', path: '/responses',
    turnId: 'new', before: pair, after: pair });
  writeFileSync(logPath, records.map((item) => JSON.stringify(item)).join('\n'));
  try {
    const snapshot = statusSnapshot({ logPath, catalog: [pair, { model: 'gpt-6-sol', effort: 'ultra' }], baseline: pair });
    const state = (id) => snapshot.turns.find((turn) => turn.turnId === id).requests[0].verification;
    assert.equal(state('confirmed'), 'confirmed');
    assert.equal(state('missing'), 'unconfirmed');
    assert.equal(state('mismatch'), 'mismatch');
    assert.equal(state('cancelled'), 'unconfirmed');
    assert.equal(state('update'), 'unconfirmed');
    assert.equal(state('new'), 'unconfirmed');
    assert.deepEqual(snapshot.availablePairs, [pair]);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_SENTINEL/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
