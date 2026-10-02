import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readJson } from '../src/local-state.mjs';
import { readLogRecords } from '../src/log-store.mjs';
import { readMetadata } from '../src/metadata-store.mjs';
import { budgetClass } from '../src/test-budget.mjs';
import { statusSnapshot } from '../src/dashboard.mjs';

const [sessionFile, outputFile] = process.argv.slice(2);
if (!sessionFile || !outputFile) throw Error('Usage: node scripts/export-evidence.mjs session.json output.json');
const session = readJson(sessionFile);
const install = process.env.ROUTER_INSTALL_DIR ?? join(homedir(), '.codex', 'codex-model-advisor-router');
const state = readJson(join(install, 'state.json'));
const live = await (await fetch(`http://127.0.0.1:${state.port}/api/status`)).json();
const { records, retainedFiles } = readLogRecords(join(install,'events.jsonl'));
const observed = [...new Map(records.filter(r => r.event === 'request' && /\/responses$/.test(r.path) && r.at >= session.startedAt &&
  (!session.closedAt || r.at <= session.closedAt)).map(r => [`${r.runId}:${r.id}`, r])).values()];
let ledgerEntries = [], ledgerState = 'not_applicable';
if (session.id) {
  try { const ledger = readJson(join(install,'test-ledger.json'));
    if (ledger.sessionId !== session.id || !Array.isArray(ledger.entries)) throw Error();
    ledgerEntries = ledger.entries; ledgerState = 'ready';
  } catch { ledgerState = 'unavailable'; }
}
const missingRequestLogs = ledgerEntries.filter(entry=>!observed.some(r=>`${r.runId}:${r.id}`===entry.key));
const completeObservations = observed.concat(missingRequestLogs.map(entry=>({...entry,logMissing:true})));
const keys = new Set(observed.map(r => `${r.runId}:${r.id}`));
const relevant = records.filter(r => keys.has(`${r.runId}:${r.id}`));
const targets = completeObservations.map(({threadId,turnId})=>({threadId,turnId}));
const home = process.env.ROUTER_METADATA_HOME ?? join(homedir(),'.codex');
const metadata = readMetadata(home, targets);
const snapshot = statusSnapshot({logPath:join(install,'events.jsonl'), records:relevant, turnLimit:Infinity,
  catalog:live.availablePairs, baseline:state.baseline, metadata, runId:live.runId, testRegistryPath:join(install,'test-threads.json')});
const countingSession = { ...session, windows:session.windows ?? [{startedAt:session.startedAt,endedAt:session.closedAt??null}] };
const observations = completeObservations.map(r=>({at:r.at,key:r.key??`${r.runId}:${r.id}`,threadId:r.threadId,turnId:r.turnId,before:r.before,planned:r.after,
  requestLogMissing:Boolean(r.logMissing),
  relation:budgetClass(countingSession,r,metadata.threads),relationshipEvidence:metadata.threads[r.threadId]?.relationshipEvidence??'unknown'}));
const used = observations.filter(r=>['registered_test','verified_child','unknown_window'].includes(r.relation)).length;
const tests = snapshot.turns.filter(t=>session.testThreadIds.includes(t.threadId)||session.testThreadIds.includes(t.rootThreadId));
const evidence = {generatedAt:new Date().toISOString(),startedAt:session.startedAt,closedAt:session.closedAt??null,budget:session.budget,
  observedRequests:observed.length,conservativeObservedRequests:used,budgetRemaining:Math.max(0,session.budget-used),
  ledgerState,missingRequestLogs:missingRequestLogs.map(r=>r.key),
  retainedFiles,metadataStatus:snapshot.metadataStatus,observations,
  turns:tests.map(t=>({threadId:t.threadId,turnId:t.turnId,at:t.at,isAuxiliary:t.isAuxiliary,taskRole:t.taskRole,
    parentThreadId:t.parentThreadId,rootThreadId:t.rootThreadId,relationshipEvidence:t.relationshipEvidence,finalReply:t.finalReply,
    requests:t.requests.map(r=>({key:r.key,at:r.at,before:r.before,planned:r.planned,reported:r.reported,reason:r.reason,
      httpStatus:r.httpStatus,state:r.state,verification:r.verification,effortUpdate:r.effortUpdate,responseId:r.responseId,
      outputItems:r.outputItems,isFinalReply:r.isFinalReply,requestClass:r.requestClass,requestKind:r.requestKind}))}))};
writeFileSync(outputFile,JSON.stringify(evidence,null,2),'utf8');
console.log(JSON.stringify({observed:evidence.observedRequests,counted:used,remaining:evidence.budgetRemaining,testTurns:tests.length}));
