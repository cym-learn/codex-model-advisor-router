import { readFileSync } from 'node:fs';
import { listModelCatalog } from '../src/catalog.mjs';

const config = readFileSync(process.argv[2], 'utf8');
const root = config.split(/^\s*\[[^\]]+\]/m, 1)[0];
const selectedModel = /^model\s*=\s*"([^"]+)"/m.exec(root)?.[1];
const selectedEffort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(root)?.[1];
const catalog = await listModelCatalog({ command: process.argv[3] });
const selected = catalog.find((entry) => entry.id === selectedModel)
  ?? catalog.find((entry) => entry.isDefault);
if (!selected) throw new Error('No available Codex model; cannot enable router');
const effort = selectedEffort && selected.supportedEfforts.includes(selectedEffort)
  ? selectedEffort : selected.defaultEffort;
if (!effort || !selected.supportedEfforts.includes(effort)) throw new Error('No valid baseline effort');
process.stdout.write(JSON.stringify({ model: selected.id, effort }) + '\n');
