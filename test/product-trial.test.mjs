import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProductTrial, productTrial } from '../src/product-trial.mjs';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'product-trial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'product-trial.json'), ledgerPath = join(dir, 'ledger.json');
  const args = { configPath, ledgerPath, threadIds: ['test-thread'], expiresAt: new Date(Date.now() + 3600000).toISOString(),
    authorization: 'User approved dedicated synthetic trial: 48 GPT, 12 Jev, 20 estimated credits.', outputTokenLimit: 2048, ...options };
  initializeProductTrial(args);
  return { ...args, trial: productTrial({ configPath }) };
}
const request = id => ({ id, threadId: 'test-thread', body: { model: 'gpt-6-sol', service_tier: 'default', input: 'Synthetic task' },
  catalog: [{ model: 'gpt-6-sol', effort: 'medium' }] });
const completed = { completedEvent: true, completedModel: 'gpt-6-sol', completedEffort: 'medium', speedMode: 'standard',
  usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 } };
const jev = { status: 'suggested', usage: { input_tokens: 400, output_tokens: 20 }, returnedModel: 'jev-1.13-free' };

test('absent trial leaves normal product unrestricted', t => {
  const dir = mkdtempSync(join(tmpdir(), 'product-trial-absent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trial = productTrial({ configPath: join(dir, 'missing.json') });
  assert.equal(trial.scope('x'), 'unrestricted');
  assert.deepEqual(trial.reserveGpt(request('g')), { allowed: true, tracked: false });
});

test('new trial requires authorization and refuses existing ledgers', t => {
  const f = fixture(t);
  assert.throws(() => initializeProductTrial(f), /already_exist/);
  assert.equal(f.trial.scope('test-thread'), 'allowed');
  assert.equal(f.trial.scope('other'), 'excluded');
  assert.equal(f.trial.reserveGpt({ ...request('outside'), threadId: 'other' }).tracked, false);
  assert.equal(f.trial.snapshot().gpt, 0);
});

test('GPT reserves an output estimate and confirmed speed, without claiming a server output cap', t => {
  const { trial } = fixture(t);
  const req = request('g1'); req.catalog.push({ model: 'gpt-6-astra', effort: 'high' });
  const permit = trial.reserveGpt(req);
  assert.equal(permit.allowed, true);
  assert.equal(permit.maxOutputTokens, 2048);
  assert.ok(permit.holdCredits > 0 && permit.holdCredits < 2);
  assert.equal(trial.reserveGpt(req).reason, 'duplicate_or_invalid_request_id');
  const result = trial.settleGpt('g1', completed);
  assert.equal(result.entry.status, 'settled');
  assert.equal(result.entry.outputLimitEnforced,false);
  assert.equal(result.entry.credits, 0.066);
  assert.equal(trial.snapshot().heldCredits, 0);
  assert.equal(trial.snapshot().gpt, 1);
  assert.equal(trial.settleGpt('g1', completed).allowed, false);
  const unknown = request('g2'); delete unknown.body.service_tier;
  assert.equal(trial.reserveGpt(unknown).reason, 'speed_unconfirmed');
  unknown.body.previous_response_id = 'server-history';
  assert.equal(trial.reserveGpt(unknown).reason, 'request_estimate_unavailable');
});

test('GPT failure counts and locks subsequent requests without assuming zero cost', t => {
  const { trial } = fixture(t);
  trial.reserveGpt(request('failure'));
  trial.settleGpt('failure', { failedEvent: 'response.failed' });
  assert.equal(trial.snapshot().gpt, 1);
  assert.equal(trial.scope('test-thread'), 'blocked');
  assert.equal(trial.reserveJev({ id: 'j1', threadId: 'test-thread' }).allowed, false);
  assert.equal(trial.snapshot().entries[0].credits, null);
});

test('authorized fee exception preserves the failed entry and consumes budget; new unknown costs still block',t=>{
 const {trial}=fixture(t);trial.reserveGpt(request('failed'));trial.settleGpt('failed',{failedEvent:'response.failed'});
 const original=JSON.stringify(trial.snapshot().entries[0]);
 assert.equal(trial.acknowledgeUnknownCost('failed',{authorization:'',reservedCredits:1}).allowed,false);
 assert.equal(trial.acknowledgeUnknownCost('failed',{authorization:'User explicitly requested resuming after failure',reservedCredits:1}).allowed,true);
 assert.equal(trial.scope('test-thread'),'allowed');assert.equal(trial.snapshot().gpt,1);assert.equal(trial.snapshot().unknownCostCount,1);assert.equal(trial.snapshot().heldCredits,1);
 assert.equal(JSON.stringify(trial.snapshot().entries[0]),original);
 trial.reserveGpt(request('failed-again'));trial.settleGpt('failed-again',{failedEvent:'response.failed'});
 assert.equal(trial.scope('test-thread'),'blocked');
});

test('unfinished requests cannot silently resume after controller restart', t => {
  const f = fixture(t);
  f.trial.reserveGpt(request('interrupted'));
  const restarted = productTrial({ configPath: f.configPath });
  assert.equal(restarted.scope('test-thread'), 'blocked');
  assert.equal(restarted.snapshot().blockedReason, 'unsettled_prior_request');
});

test('disabled, expired, corrupt config or manifest remain closed for trial threads', t => {
  const f = fixture(t);
  const c = JSON.parse(readFileSync(f.configPath, 'utf8'));
  writeFileSync(f.configPath, JSON.stringify({ ...c, enabled: false }));
  assert.equal(f.trial.scope('test-thread'), 'blocked');
  assert.equal(f.trial.scope('other'), 'excluded');
  writeFileSync(f.configPath, JSON.stringify({ ...c, expiresAt: '2000-01-01T00:00:00Z' }));
  assert.equal(f.trial.scope('test-thread'), 'blocked');
  writeFileSync(f.configPath, '{');
  assert.equal(f.trial.scope('test-thread'), 'blocked');
  assert.equal(f.trial.reserveGpt(request('g')).allowed, false);
});

test('Jev free-provider usage is separate from GPT credits and capped at 12', t => {
  const { trial } = fixture(t);
  for (let i = 0; i < 12; i++) {
    assert.equal(trial.reserveJev({ id: `j${i}`, threadId: 'test-thread' }).allowed, true);
    assert.equal(trial.settleJev(`j${i}`, jev).entry.status, 'settled');
  }
  const s = trial.snapshot();
  assert.equal(s.jev, 12); assert.equal(s.knownCredits, 0);
  assert.equal(s.entries[0].usage.inputTokens, 400);
  assert.equal(s.entries[0].providerCost.value, null);
  assert.equal(trial.reserveJev({ id: 'j13', threadId: 'test-thread' }).allowed, false);
});

test('Jev failure or missing usage locks subsequent real calls', t => {
  const { trial } = fixture(t);
  trial.reserveJev({ id: 'failure', threadId: 'test-thread' });
  trial.settleJev('failure', { status: 'failed' });
  assert.equal(trial.snapshot().jev, 1);
  assert.equal(trial.snapshot().blockedReason, 'jev_usage_unconfirmed');
  assert.equal(trial.reserveGpt(request('g')).allowed, false);
});

test('connection checks need explicit permission and consume Jev budget', t => {
  const f = fixture(t);
  assert.equal(f.trial.reserveJev({ id: 'check', threadId: null, isConnectionCheck: true }).allowed, false);
  const permitted = fixture(t, { allowConnectionChecks: true }).trial;
  assert.equal(permitted.reserveJev({ id: 'check', threadId: null, isConnectionCheck: true }).tracked, true);
  permitted.settleJev('check', jev);
  assert.equal(permitted.snapshot().jev, 1);
});

test('GPT request cap includes every completed tool continuation', t => {
  const { trial } = fixture(t);
  for (let i = 0; i < 48; i++) {
    assert.equal(trial.reserveGpt(request(`g${i}`)).allowed, true);
    trial.settleGpt(`g${i}`, completed);
  }
  assert.equal(trial.snapshot().gpt, 48);
  assert.equal(trial.reserveGpt(request('g49')).allowed, false);
});

test('concurrent reservations and credit threshold stop before dispatch', t => {
  const { trial } = fixture(t, { outputTokenLimit: 20000 });
  const expensive = id => ({ ...request(id), body: { ...request(id).body, model: 'gpt-6-astra', max_output_tokens: 20000 } });
  assert.equal(trial.reserveGpt(expensive('too-large')).reason, 'credit_reservation_exceeds_budget');
  assert.equal(trial.snapshot().gpt, 0);
  const r = request('g1'); r.body.max_output_tokens = 10000;
  const p = trial.reserveGpt(r);
  assert.equal(p.allowed, true);
  trial.settleGpt('g1', { ...completed, usage: { inputTokens: 1000000, cachedInputTokens: 0, outputTokens: 0 } });
  assert.equal(trial.snapshot().blockedReason, 'reservation_exceeded');
});

test('ledger stores counts and safe metadata, never request text or raw Jev payload', t => {
  const f = fixture(t);
  f.trial.reserveGpt({ ...request('g'), body: { ...request('g').body, input: 'PRIVATE_MARKER' } });
  f.trial.settleGpt('g', { ...completed, secret: 'PRIVATE_MARKER' });
  f.trial.reserveJev({ id: 'j', threadId: 'test-thread' });
  f.trial.settleJev('j', { ...jev, raw: 'PRIVATE_MARKER' });
  assert.equal(readFileSync(f.ledgerPath, 'utf8').includes('PRIVATE_MARKER'), false);
});
