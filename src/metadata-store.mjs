import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : null;
const displayName = (value) => typeof value === 'string' && value.trim() && value.length <= 200
  && !/[\r\n\x00-\x1f]/.test(value) ? value.trim() : null;

function open(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
  return db;
}

// Select only display names and identifiers. Never select title, preview, prompts or full item_json.
export function readMetadata(home, targets) {
  const result = { state: 'unavailable', historyState: 'unavailable', threads: {}, turns: {} };
  let state, history, catalog;
  try {
    state = open(join(home, 'state_5.sqlite'));
    const threadQuery = state.prepare('SELECT id,name,source,thread_source FROM threads WHERE id=?');
    const edgeQuery = state.prepare('SELECT DISTINCT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id=?');
    try { catalog = open(join(home, 'sqlite', 'codex-dev.db')); } catch {}
    let nameQuery;
    try { nameQuery = catalog?.prepare('SELECT DISTINCT display_title FROM local_thread_catalog WHERE thread_id=?'); } catch {}
    const rows = new Map();
    function load(id, depth = 0) {
      if (!id || rows.has(id) || depth > 16) return;
      const row = threadQuery.get(id);
      const parents = edgeQuery.all(id).map((edge) => safeId(edge.parent_thread_id)).filter(Boolean);
      const names = nameQuery?.all(id).map((entry) => displayName(entry.display_title)).filter(Boolean) ?? [];
      const uniqueNames = [...new Set(names)];
      const name = uniqueNames.length === 1 ? uniqueNames[0] : uniqueNames.length > 1 ? null : displayName(row?.name);
      rows.set(id, { row, parents, name });
      for (const parent of parents) load(parent, depth + 1);
    }
    for (const target of targets.slice(0, 100)) load(safeId(target.threadId));
    function relation(id, seen = new Set()) {
      const entry = rows.get(id);
      if (!entry?.row) return { taskRole: 'unknown', rootThreadId: null, parentThreadId: null, relationshipEvidence: 'missing_thread' };
      if (seen.has(id) || seen.size > 16 || entry.parents.length > 1) {
        return { taskRole: 'unknown', rootThreadId: null, parentThreadId: null, relationshipEvidence: 'conflict' };
      }
      if (entry.parents.length === 1) {
        const parent = entry.parents[0];
        const ancestry = relation(parent, new Set([...seen, id]));
        return ancestry.rootThreadId ? { taskRole: 'child', parentThreadId: parent,
          rootThreadId: ancestry.rootThreadId, relationshipEvidence: 'spawn_edge' }
          : { taskRole: 'unknown', parentThreadId: parent, rootThreadId: null, relationshipEvidence: ancestry.relationshipEvidence };
      }
      // Forks and user-created conversations have no spawn edge and remain independent.
      const interactive = ['vscode', 'cli', 'app', 'desktop'].includes(entry.row.source)
        && !['subagent', 'guardian_review'].includes(entry.row.thread_source);
      return { taskRole: interactive ? 'main' : 'unknown', parentThreadId: null,
        rootThreadId: interactive ? id : null, relationshipEvidence: interactive ? 'independent_thread' : 'unknown_source' };
    }
    for (const [id, entry] of rows) result.threads[id] = { threadId: id, displayName: entry.name, ...relation(id) };
    result.state = 'ready';
  } catch { result.state = 'unavailable_or_incompatible'; result.threads = {}; }
  finally { catalog?.close(); state?.close(); }
  try {
    history = open(join(home, 'thread_history_1.sqlite'));
    const turnQuery = history.prepare('SELECT status,final_agent_item_id FROM thread_turns WHERE thread_id=? AND turn_id=?');
    const itemQuery = history.prepare("SELECT item_type,json_extract(item_json,'$.phase') AS phase FROM thread_items WHERE thread_id=? AND turn_id=? AND item_id=?");
    for (const target of targets.slice(0, 100)) {
      const thread = safeId(target.threadId), turn = safeId(target.turnId);
      if (!thread || !turn) continue;
      const record = turnQuery.get(thread, turn);
      const itemId = safeId(record?.final_agent_item_id);
      const items = itemId ? itemQuery.all(thread, turn, itemId) : [];
      result.turns[`${thread}:${turn}`] = { status: record?.status ?? null, finalItemId: itemId,
        finalPhase: items.length === 1 && items[0].item_type === 'agentMessage' ? items[0].phase : null };
    }
    result.historyState = 'ready';
  } catch { result.historyState = 'unavailable_or_incompatible'; result.turns = {}; }
  finally { history?.close(); }
  return result;
}
