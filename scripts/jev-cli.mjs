import { join } from 'node:path';
import { readJson, writeJson, safeId } from '../src/local-state.mjs';
import { initJevBudget, jevBudget } from '../src/jev-shadow.mjs';

const [action, directory, ...ids] = process.argv.slice(2);
try {
  if (!directory || !['status', 'shadow', 'off'].includes(action)) throw Error('Use status|shadow|off INSTALL_DIR [THREAD_ID ...]');
  const configPath = join(directory, 'jev-config.json'), budgetPath = join(directory, 'jev-budget.json');
  if (action === 'shadow') {
    if (!ids.length || !ids.every(safeId)) throw Error('Explicit test thread IDs are required.');
    initJevBudget(budgetPath);
    writeJson(configPath, { version: 1, mode: 'shadow', threadIds: [...new Set(ids)] });
  } else if (action === 'off') {
    writeJson(configPath, { version: 1, mode: 'off', threadIds: [] });
  }
  let config; try { config = readJson(configPath); } catch { config = { mode: 'off', threadIds: [] }; }
  console.log(JSON.stringify({ mode: config.mode, registeredThreads: config.threadIds.length, budget: jevBudget(budgetPath).snapshot(), applied: false }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
