import {credentialPath,loadCredential} from './jev.mjs';
import {settingsApi} from './settings-api.mjs';
import {contextThreads} from './project-contexts.mjs';
import {productTrial} from './product-trial.mjs';
import { jevRuntime } from './jev-runtime.mjs';
import { createServer } from 'node:http';
import { existsSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { metadataClient } from './metadata-client.mjs';
import { clientKind, chooseLocalRoute, requestPhase, turnIdentity, hasEffortUpdate } from './policy.mjs';
import { listAvailablePairs } from './catalog.mjs';
import { statusSnapshot, dashboardHtml, dashboardScript } from './dashboard.mjs';
import { routeStore } from './route-store.mjs';
import { logStore } from './log-store.mjs';
import { testBudget } from './test-budget.mjs';
import { readJson } from './local-state.mjs';
import { jevShadow } from './jev-shadow.mjs';
import { responseUsage } from './metrics.mjs';
import { experimentController } from './experiment.mjs';

const omittedHeaders = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'accept-encoding', 'content-encoding',
]);

function upstreamBase(headers, override) {
  if (override) return override;
  return headers['chatgpt-account-id']
    ? 'https://chatgpt.com/backend-api/codex'
    : 'https://api.openai.com/v1';
}

export function inspectSseFrame(frame, metadata) {
  const declaredEvent = /^event:\s*([^\r\n]+)/m.exec(frame)?.[1];
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (data.length > 262144) return;
  try {
    const parsed = JSON.parse(data);
    const eventName = declaredEvent ?? parsed.type;
    if (eventName === 'response.output_text.delta') {
      if (typeof parsed.delta === 'string' && parsed.delta.length && metadata.firstTextMs == null && metadata.upstreamStartedMs != null)
        metadata.firstTextMs = Math.round(performance.now() - metadata.upstreamStartedMs);
      return false;
    }
    if (!['response.created', 'response.completed', 'response.output_item.added', 'response.output_item.done', 'response.failed', 'response.incomplete'].includes(eventName)) return false;
    const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : null;
    const remember = (item) => {
      const id = identifier(item?.id);
      if (item?.type !== 'message' || !id) return;
      metadata.outputItems ??= [];
      const entry = { id, type: 'message', role: item.role === 'assistant' ? 'assistant' : null,
        phase: ['final_answer', 'commentary'].includes(item.phase) ? item.phase : null };
      const index = metadata.outputItems.findIndex((saved) => saved.id === id);
      if (index >= 0) metadata.outputItems[index] = { ...metadata.outputItems[index], ...entry,
        phase: entry.phase ?? metadata.outputItems[index].phase };
      else if (metadata.outputItems.length < 64) metadata.outputItems.push(entry);
    };
    remember(parsed.item);
    if (eventName === 'response.failed' || eventName === 'response.incomplete') metadata.failedEvent = eventName;
    if (eventName === 'response.created') metadata.createdEvent = true;
    if (eventName === 'response.completed') metadata.completedEvent = true;
    const response = parsed.response;
    if (!response) return true;
    const responseId = identifier(response.id);
    if (responseId && metadata.responseId && responseId !== metadata.responseId) metadata.responseIdConflict = true;
    metadata.responseId = responseId ?? metadata.responseId ?? null;
    for (const item of response.output ?? []) remember(item);
    if (eventName === 'response.created') {
      metadata.createdModel = response.model ?? null;
      metadata.createdEffort = response.reasoning?.effort ?? null;
    } else if (eventName === 'response.completed') {
      metadata.completedModel = response.model ?? null;
      metadata.completedEffort = response.reasoning?.effort ?? null;
      metadata.reportedServiceTier = ['default','priority','flex','scale','auto'].includes(response.service_tier) ? response.service_tier : null;
      metadata.speedMode = response.service_tier === 'default' ? 'standard' : null;
      metadata.usage = responseUsage(response.usage);
    }
    return true;
  } catch { /* Unknown upstream frame: preserve it unchanged. */ }
}

function waitForWritable(response) {
  return new Promise((resolve) => {
    const done = () => {
      response.off('drain', done);
      response.off('close', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
  });
}

export async function startRouter({
  port = 18765,
  upstream,
  logPath,
  fetchImpl = globalThis.fetch,
  baseline = { model: 'gpt-6-sol', effort: 'high' },
  availablePairs,
  diagnostic = false,
  pidPath,
  metadataHome,
  testRegistryPath = logPath ? join(dirname(logPath), 'test-threads.json') : undefined,
  routePath = logPath ? join(dirname(logPath), 'routes.json') : undefined,
  testSessionPath = logPath ? join(dirname(logPath), 'test-session.json') : undefined,
  testLedgerPath = logPath ? join(dirname(logPath), 'test-ledger.json') : undefined,
  jevOptions = {},
  experimentOptions = {},
  runtimeOptions = {},
  settingsOptions = {},
} = {}) {
  if (!logPath) throw new Error('ROUTER_LOG is required');
  let catalog = availablePairs ?? await listAvailablePairs();
  const catalogTimer = availablePairs ? null : setInterval(async () => {
    const refreshed = await listAvailablePairs();
    if (refreshed.length) catalog = refreshed;
  }, 30 * 60 * 1000);
  catalogTimer?.unref();
  let requestNumber = 0;
  let activeResponses = 0;
  let preparingResponses=0;
  const runId = randomUUID();
  const routes = routeStore(routePath, baseline, catalog);
  const budget = testBudget(testSessionPath, testLedgerPath);
  const localMetadata = metadataHome ? metadataClient(metadataHome) : null;
  const logger = logStore(logPath, () => activeResponses + (shadow?.snapshot().pending ?? 0) + (experiment?.snapshot().pending ?? 0));
  const log = (record) => logger.append({ at: new Date().toISOString(), runId, ...record });
  const shadow = jevShadow({ configPath: join(dirname(logPath), 'jev-config.json'),
    statePath: join(dirname(logPath), 'jev-turns.json'), budgetPath: join(dirname(logPath), 'jev-budget.json'),
    catalog: () => catalog, baseline, onEvent: log, ...jevOptions });
  const experiment = experimentController({ configPath: join(dirname(logPath), 'evaluation-config.json'),
    catalog: () => catalog, baseline, onEvent: log, ...experimentOptions });

  const installDirectory=dirname(logPath);
  const localKeyPath=metadataHome&&resolve(metadataHome)!==resolve(join(homedir(),'.codex'))?join(metadataHome,'credentials','codex-model-advisor','opencode-jev.dpapi'):credentialPath;
  const trial=productTrial({configPath:join(installDirectory,'product-trial.json')});
  const runtime = jevRuntime({credentialLoader:()=>loadCredential(localKeyPath),directoryResolver:threadId=>contextThreads(metadataHome,[threadId])[0]?.cwd??null,scopeAllowed:threadId=>['unrestricted','allowed'].includes(trial.scope(threadId)),reserveJev:({threadId})=>trial.reserveJev({id:randomUUID(),threadId}),settleJev:(id,result)=>trial.settleJev(id,result), configPath: join(dirname(logPath), 'routing-mode.json'), statePath: join(dirname(logPath), 'runtime-turns.json'), counterPath: join(dirname(logPath), 'runtime-usage.json'), catalog: () => catalog, baseline, onEvent: log, ...runtimeOptions });

  const handleSettings=settingsApi({directory:installDirectory,keyPath:localKeyPath,metadataHome,catalog:()=>catalog,baseline,busy:()=>preparingResponses>0||runtime.snapshot().pending>0||experiment.snapshot().pending>0||shadow.snapshot().pending>0,threadIds:()=>statusSnapshot({logPath,catalog,baseline,runId,testRegistryPath}).turns.map(t=>t.threadId),trial,onModeChange:()=>runtime.refreshCredentials(),...settingsOptions});
  const server = createServer((request, response) => {
    const routingRequest=request.method==='POST'&&/\/responses(?:\?|$)/.test(request.url??'');if(routingRequest)preparingResponses++;
    void (async () => {
      const id = ++requestNumber;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if(await handleSettings(request,response,url))return;
      if(url.pathname.startsWith('/api/')){if(url.pathname!=='/api/status'){response.writeHead(404);response.end();return;}}
      if (['/', '/api/status', '/dashboard.js'].includes(url.pathname)) {
        if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(request.headers.host ?? '') || request.method !== 'GET') {
          response.writeHead(403); response.end(); return;
        }
        const contentType = url.pathname === '/api/status' ? 'application/json' : url.pathname === '/' ? 'text/html' : 'text/javascript';
        response.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
        let snapshot;
        if (url.pathname === '/api/status') {
          snapshot = statusSnapshot({ logPath, catalog, baseline, runId, testRegistryPath });
          const targets = snapshot.turns.map(({ threadId, turnId }) => ({ threadId, turnId })).concat(budget.targets());
          const metadata = localMetadata?.snapshot(targets);
          snapshot = statusSnapshot({ logPath, catalog, baseline, runId, testRegistryPath,
            metadata });
          snapshot.activeRequests = preparingResponses;
          snapshot.testBudget = budget.snapshot(metadata);
          snapshot.routePersistence = routes.status();
          snapshot.logRetention = logger.status();
          snapshot.jev = shadow.snapshot();
          snapshot.evaluation = experiment.snapshot();
          snapshot.routing = runtime.snapshot();
          snapshot.productTrial=trial.snapshot();
          for (const turn of snapshot.turns) {
            turn.selection = runtime.get(turn.threadId, turn.turnId) ?? turn.selection ?? null;
            turn.jev = shadow.get(turn.threadId, turn.turnId) ?? turn.jev ?? null;
            for (const r of turn.requests) if (r.jev?.status === 'pending' && turn.jev?.status !== 'pending') r.jev = turn.jev;
          }
        }
        response.end(url.pathname === '/' ? dashboardHtml : url.pathname === '/dashboard.js' ? dashboardScript
          : JSON.stringify(snapshot));
        return;
      }
      if (url.pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, schemaVersion: 2, availablePairs: catalog.length }));
        return;
      }

      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const isResponse = request.method === 'POST' && /\/responses$/.test(url.pathname);
      let body;
      if (isResponse) {
        try { body = JSON.parse(raw.toString('utf8')); }
        catch { response.writeHead(400); response.end(); log({ id, event: 'invalid_json' }); return; }
      }
      const before = body ? { model: body.model ?? null, effort: body.reasoning?.effort ?? null } : null;
      const requestStartedMs = performance.now();
      const controller = new AbortController();
      request.on('aborted', () => controller.abort());
      response.on('close', () => { if (!response.writableEnded) controller.abort(); });
      const client = clientKind(request.headers);
      const phase = body ? requestPhase(body) : { kind: 'none' };
      const turn = client === 'desktop' || experimentOptions.isolated ? turnIdentity(request.headers) : null;
      const rawThreadId = request.headers['thread-id'];
      const threadId = (client === 'desktop' || experimentOptions.isolated) && typeof rawThreadId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(rawThreadId)
        ? rawThreadId : null;
      if(isResponse&&trial.scope(threadId)==='blocked'){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'product_trial_blocked',message:'Local product trial is paused. Do not retry; inspect the trial ledger. No model call sent.'}}));return;}
      let requestKind = null;
      try { const value = JSON.parse(request.headers['x-codex-turn-metadata'] ?? '{}').request_kind;
        if (['turn','title','summary','review'].includes(value)) requestKind = value; } catch {}
      if (isResponse) {
        budget.snapshot(localMetadata?.snapshot([{ threadId, turnId: turn }, ...budget.targets()]));
        let registered = []; try { const value = readJson(testRegistryPath); if (Array.isArray(value)) registered = value; } catch {}
        const permit = budget.reserve({ key: `${runId}:${id}`, at: new Date().toISOString(), threadId, turnId: turn }, registered);
        if (!permit.allowed) {
          log({ id, event: 'budget_blocked', threadId, turnId: turn, reason: permit.reason });
          response.writeHead(429, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: permit.reason, message: 'This registered test batch cannot send more model requests.' } })); return;
        }
      }
      let decision = body ? { ...before, reason: 'pass_through' } : null;
      const shadowInput = body ? { ...body, reasoning: { ...body.reasoning } } : null;
      let changed = false;
      // The registered product trial is explicitly run at standard speed.
      if(isResponse&&trial.scope(threadId)==='allowed'&&body.service_tier!=='default'){
        body.service_tier='default';changed=true;
        log({id,event:'trial_standard_speed',threadId,turnId:turn,serviceTier:'default'});
      }
      let automatic = null;
      const evaluation = body && trial.scope(threadId)==='unrestricted' ? await experiment.route({ threadId, turnId: turn, client, body, requestKey: randomUUID(), signal: controller.signal }) : null;
      if (evaluation?.blocked) {
        log({id,event:'evaluation_blocked',threadId,turnId:turn,reason:evaluation.blocked});
        response.writeHead(400, {'content-type':'application/json'});
        response.end(JSON.stringify({error:{code:evaluation.blocked,message:'Controlled evaluation is not permitted for this request.'}}));return;
      }
      if (body && (evaluation || client === 'desktop' && turn)) {
        const previousRoute = routes.get(threadId, turn);
        decision = evaluation ? evaluation.decision ?? {...before,reason:evaluation.experiment.fallback??'evaluation_auxiliary'}
          : chooseLocalRoute({ body, availablePairs: catalog, baseline, previousRoute });
        if (!evaluation) { automatic = await runtime.route({id,threadId,turnId:turn,client,body:shadowInput,rule:decision,signal:controller.signal}); if(automatic)decision=automatic.decision; }
        if (!previousRoute && phase.kind === 'tool' && decision.reason === 'not_user_turn') decision.reason = 'same_turn_route_missing';
        if (!evaluation && !automatic) routes.set(threadId, turn, decision);
        if (decision.model && decision.effort &&
            (decision.model !== before.model || decision.effort !== before.effort)) {
          body.model = decision.model;
          body.reasoning = { ...(body.reasoning ?? {}), effort: decision.effort };
          changed = true;
        }
      }
      let trialPermit={tracked:false};
      if(isResponse){
        trialPermit=trial.reserveGpt({id:randomUUID(),threadId,body,catalog,baseline});
        if(!trialPermit.allowed){log({id,event:'budget_blocked',threadId,turnId:turn,reason:trialPermit.reason});response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:trialPermit.reason,message:'Local product trial budget refused this request. Do not retry automatically.'}}));return;}
        // Codex's subscription endpoint rejects max_output_tokens. The local
        // token allowance is an estimate for stopping subsequent requests,
        // not a server-enforced limit or an actual billing cap.
        if(trialPermit.tracked&&Object.hasOwn(body,'max_output_tokens')){delete body.max_output_tokens;changed=true;}
      }
      const path = (request.url ?? '/').replace(/^\/v1(?=\/)/, '');
      const destination = upstreamBase(request.headers, upstream).replace(/\/$/, '') + path;
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !omittedHeaders.has(key)));
      const input = body?.input;
      const inputTypes = diagnostic && Array.isArray(input) ? input.map((item) => ({
        type: item?.type ?? null, role: item?.role ?? null,
        contentTypes: Array.isArray(item?.content) ? item.content.map((part) => part?.type ?? null) : [],
      })) : undefined;
      let turnMetadataKeys = [];
      let turnFlags = {};
      if (diagnostic) {
        try {
          const meta = JSON.parse(request.headers['x-codex-turn-metadata'] ?? '{}');
          turnMetadataKeys = Object.keys(meta);
          turnFlags = { requestKind: meta.request_kind ?? null,
            turnTrigger: meta.turn_trigger ?? null, threadSource: meta.thread_source ?? null,
            agentName: meta.agent_name ?? null };
        }
        catch { turnMetadataKeys = ['unparsed']; }
      }
      log({ id, event: 'request', method: request.method, path: url.pathname, client, phase: phase.kind,
        threadId, turnId: turn, requestKind, effortUpdate: body ? hasEffortUpdate(body) : false,
        phaseLength: diagnostic ? phase.text?.length ?? 0 : undefined,
        reason: decision?.reason ?? null, before,
        experiment: evaluation?.experiment ?? null, selection: automatic?.selection ?? null,
        after: body ? { model: body.model, effort: body.reasoning?.effort ?? null } : null,
        ...(diagnostic ? { headerNames: Object.keys(request.headers).sort(),
          userAgent: request.headers['user-agent'] ?? null,
          originator: request.headers.originator ?? null,
          turnMetadataKeys, turnFlags,
          clientMetadataKeys: body?.client_metadata ? Object.keys(body.client_metadata).sort() : [],
          bodyKeys: body ? Object.keys(body).sort() : [], inputTypes } : {}),
        hasAuthorization: Boolean(request.headers.authorization),
        hasChatgptAccountId: Boolean(request.headers['chatgpt-account-id']) });
      if (isResponse && !evaluation && !automatic && trial.scope(threadId)==='unrestricted') {
        try { shadow.start({ id, threadId, turnId: turn, client, body: shadowInput, signal: controller.signal }); }
        catch { log({ id, event: 'jev_adapter_error' }); }
      }

      const metadata = { createdEvent: false, completedEvent: false, outputItems: [], responseId: null,
        usage: responseUsage(null), firstTextMs: null,
        createdModel: null, createdEffort: null,
        completedModel: null, completedEffort: null };
      if (isResponse) activeResponses++;
      metadata.upstreamStartedMs = performance.now();
      try {
        const upstreamResponse = await fetchImpl(destination, {
          method: request.method,
          headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : changed ? JSON.stringify(body) : raw,
          signal: controller.signal,
        });
        response.statusCode = upstreamResponse.status;
        for (const [key, value] of upstreamResponse.headers) {
          if (!omittedHeaders.has(key)) response.setHeader(key, value);
        }
        log({ id, event: 'upstream', status: upstreamResponse.status,
          contentType: upstreamResponse.headers.get('content-type') });
        let pending = '';
        const decoder = new TextDecoder();
        if (upstreamResponse.body) {
          for await (const chunk of upstreamResponse.body) {
            if (isResponse && upstreamResponse.ok) {
              pending += decoder.decode(chunk, { stream: true });
              let separator;
              while ((separator = /\r?\n\r?\n/.exec(pending))) {
                if (inspectSseFrame(pending.slice(0, separator.index), metadata)) { const { upstreamStartedMs, ...evidence } = metadata; log({ id, event: 'observation', ...evidence }); }
                pending = pending.slice(separator.index + separator[0].length);
              }
              if (pending.length > 1048576) pending = '';
            }
            if (response.destroyed) break;
            if (!response.write(chunk)) await waitForWritable(response);
          }
        }
        if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
        if (pending.trim()) inspectSseFrame(pending + decoder.decode(), metadata);
        const { upstreamStartedMs, ...evidence } = metadata;
        log({ id, event: 'finished', status: upstreamResponse.status, ...evidence,
          durationMs: Math.round(performance.now() - upstreamStartedMs), totalDurationMs: Math.round(performance.now() - requestStartedMs),
          firstTextTotalMs: metadata.firstTextMs == null ? null : metadata.firstTextMs + Math.round(upstreamStartedMs - requestStartedMs) });
        response.end();
      } catch (error) {
        const event = controller.signal.aborted
          ? (metadata.completedEvent ? 'client_closed_after_complete' : 'cancelled')
          : 'error';
        const { upstreamStartedMs, ...evidence } = metadata;
        log({ id, event,
          error: error.cause?.code ?? error.name, ...evidence, durationMs: Math.round(performance.now() - upstreamStartedMs), totalDurationMs: Math.round(performance.now() - requestStartedMs) });
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        if (!response.writableEnded) response.end('{"error":"router_probe_upstream_failed"}');
      } finally {
        if(trialPermit.tracked)trial.settleGpt(trialPermit.id,metadata);
        if (isResponse) activeResponses--;
        logger.rotate();
      }
    })().catch((error) => {
      log({ event: 'internal_error', error: error.name });
      if (!response.headersSent) response.writeHead(500);
      if (!response.writableEnded) response.end();
    }).finally(()=>{if(routingRequest)preparingResponses--;});
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  if (pidPath) writeFileSync(pidPath, String(process.pid), 'utf8');
  logger.rotate();
  log({ event: 'listening', port: server.address().port });
  return { port: server.address().port, close: () => {
    shadow.close();
    experiment.close(); runtime.close();
    if (catalogTimer) clearInterval(catalogTimer);
    return new Promise((resolve) => server.close(() => {
      if (pidPath && existsSync(pidPath)) unlinkSync(pidPath);
      void localMetadata?.close();
      resolve();
    }));
  } };
}

export function metadataHomeFromArgs(args) {
  const indices = args.flatMap((arg, index) => arg === '--metadata-home' ? [index] : []);
  if (!indices.length) return join(homedir(), '.codex');
  const value = args[indices[0] + 1];
  if (indices.length !== 1 || !value || !isAbsolute(value)) throw new Error('--metadata-home requires one absolute directory');
  try { if (!statSync(value).isDirectory()) throw new Error(); }
  catch { throw new Error('--metadata-home requires an existing directory'); }
  return resolve(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startRouter({ port: Number(process.env.ROUTER_PORT ?? 18765),
    logPath: process.env.ROUTER_LOG,
    baseline: { model: process.env.ROUTER_BASELINE_MODEL ?? 'gpt-6-sol',
      effort: process.env.ROUTER_BASELINE_EFFORT ?? 'high' },
    pidPath: process.env.ROUTER_PID_PATH,
    metadataHome: metadataHomeFromArgs(process.argv.slice(2)),
    diagnostic: process.env.ROUTER_DIAGNOSTIC === '1' }).catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
