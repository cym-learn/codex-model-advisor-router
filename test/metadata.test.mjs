import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMetadata } from '../src/metadata-store.mjs';
import { metadataClient } from '../src/metadata-client.mjs';
import { statusSnapshot } from '../src/dashboard.mjs';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'router-metadata-'));
  mkdirSync(join(home, 'sqlite'));
  const state = new DatabaseSync(join(home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,source TEXT,thread_source TEXT,title TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);');
  const insert = state.prepare('INSERT INTO threads VALUES(?,?,?,?,?)');
  for (const id of ['main', 'other', 'fork', 'child', 'grandchild', 'conflict', 'cycle-a', 'cycle-b', 'orphan'])
    insert.run(id, id === 'main' ? 'State display name' : null, ['child', 'grandchild', 'orphan'].includes(id) ? 'subagent' : 'vscode', 'user', 'PROMPT_SECRET');
  state.exec("INSERT INTO thread_spawn_edges VALUES('main','child','open'),('main','child','open'),('child','grandchild','open'),('main','conflict','open'),('other','conflict','open'),('cycle-a','cycle-b','open'),('cycle-b','cycle-a','open');");
  state.close();
  const catalog = new DatabaseSync(join(home, 'sqlite', 'codex-dev.db'));
  catalog.exec("CREATE TABLE local_thread_catalog(thread_id TEXT,display_title TEXT); INSERT INTO local_thread_catalog VALUES('main','Visible conversation');");
  catalog.close();
  const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
  history.exec("CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,final_agent_item_id TEXT); CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_type TEXT,item_json TEXT); INSERT INTO thread_turns VALUES('main','turn','completed','msg_final'); INSERT INTO thread_items VALUES('main','turn','msg_final','agentMessage','{\"phase\":\"final_answer\",\"text\":\"ANSWER_SECRET\"}');");
  history.close();
  return home;
}

test('readonly metadata maps explicit edges, independent/forked conversations, conflicts, missing IDs and final message without text', () => {
  const home = fixture();
  try {
    const data = readMetadata(home, ['main', 'other', 'fork', 'child', 'grandchild', 'conflict', 'cycle-a', 'orphan', 'missing'].map((threadId) => ({threadId, turnId:'turn'})));
    assert.equal(data.state, 'ready'); assert.equal(data.historyState, 'ready');
    assert.equal(data.threads.main.displayName, 'Visible conversation');
    assert.equal(data.threads.fork.taskRole, 'main');
    assert.equal(data.threads.child.parentThreadId, 'main');
    assert.equal(data.threads.grandchild.rootThreadId, 'main');
    for (const id of ['conflict', 'cycle-a', 'orphan', 'missing']) assert.equal(data.threads[id].taskRole, 'unknown');
    assert.equal(data.turns['main:turn'].finalItemId, 'msg_final');
    assert.doesNotMatch(JSON.stringify(data), /PROMPT_SECRET|ANSWER_SECRET/);
    const state = new DatabaseSync(join(home,'state_5.sqlite'), {readOnly:true});
    assert.equal(state.prepare('SELECT count(*) AS n FROM threads').get().n, 9); state.close();
  } finally { rmSync(home, {recursive:true,force:true}); }
});

test('worker refresh and incompatible schema fail independently of forwarding', async () => {
  const home = fixture(), reader = metadataClient(home);
  try {
    const targets = [{threadId:'main', turnId:'turn'}]; reader.snapshot(targets);
    let data;
    for (let i=0;i<40;i++) { await new Promise((r)=>setTimeout(r,25)); data=reader.snapshot(targets); if(data.state==='ready')break; }
    assert.equal(data.threads.main.taskRole, 'main');
    const broken = readMetadata(join(home,'absent'),targets);
    assert.equal(broken.state,'unavailable_or_incompatible');
    const state=new DatabaseSync(join(home,'state_5.sqlite'));state.exec('DROP TABLE thread_spawn_edges');state.close();
    assert.equal(readMetadata(home,targets).state,'unavailable_or_incompatible');
  } finally { await reader.close(); rmSync(home,{recursive:true,force:true}); }
});

test('final attribution requires native completed final item, unique output ID, and verified configuration; legacy never upgrades', () => {
  const home = fixture(), logPath = join(home,'events.jsonl');
  const pair={model:'gpt-6-luna',effort:'low'};
  const records = [
    {event:'request',id:1,at:'2026-09-26T00:00:00Z',runId:'r',path:'/responses',threadId:'main',turnId:'turn',client:'desktop',before:pair,after:pair,effortUpdate:false},
    {event:'finished',id:1,runId:'r',status:200,completedEvent:true,completedModel:pair.model,completedEffort:pair.effort,responseId:'resp_1',outputItems:[{id:'msg_final',type:'message',role:'assistant',phase:'final_answer'}]},
  ];
  const metadata=readMetadata(home,[{threadId:'main',turnId:'turn'}]);
  const snapshot=()=>statusSnapshot({logPath,catalog:[pair],baseline:pair,metadata,runId:'r'});
  const save=()=>writeFileSync(logPath,records.map(JSON.stringify).join('\n'));
  try {
    save(); assert.equal(snapshot().turns[0].finalReply.status,'confirmed');
    assert.equal(snapshot().conversations[0].displayName,'Visible conversation');
    records[1].outputItems[0].id='different';save();assert.equal(snapshot().turns[0].finalReply.status,'unconfirmed');
    records[1].outputItems[0].id='msg_final';records[0].effortUpdate=true;save();assert.equal(snapshot().turns[0].finalReply.status,'unconfirmed');
    records[0].effortUpdate=false;records.push({...records[0],id:2},{...records[1],id:2});save();assert.equal(snapshot().turns[0].finalReply.status,'conflict');
    records.pop();records.pop();delete records[1].outputItems;save();assert.equal(snapshot().turns[0].finalReply.status,'unconfirmed');
    metadata.turns['main:turn'].status='inProgress';save();assert.equal(snapshot().turns[0].finalReply.status,'unconfirmed');
  } finally {rmSync(home,{recursive:true,force:true});}
});
