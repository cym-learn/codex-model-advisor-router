import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const start = '# BEGIN codex-model-advisor-router';
const end = '# END codex-model-advisor-router';
const providerStart = '# BEGIN codex-model-advisor-router provider';
const providerEnd = '# END codex-model-advisor-router provider';
const providerName = 'advisor_router';

function replaceOnce(source, search, replacement) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) throw new Error(`expected one ${search}`);
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

function writeIfUnchanged(path, original, updated) {
  if (existsSync(path) && readFileSync(path, 'utf8') !== original) throw new Error('Codex config changed during update; no overwrite');
  const temporary = join(dirname(path), `.codex-model-router-${randomUUID()}.tmp`);
  writeFileSync(temporary, updated, 'utf8');
  try { renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function enableConfig(path, baseUrl, backupDir) {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (original.includes(start) || original.includes(providerStart)) throw new Error('Router configuration is already present');
  if (/^\s*\[model_providers\.advisor_router\]/m.test(original)) throw new Error('Provider name already exists');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const tableIndex = /^\s*\[[^\]]+\]/m.exec(original)?.index ?? original.length;
  const prefix = original.slice(0, tableIndex);
  const providerLines = [...prefix.matchAll(/^model_provider\s*=.*$/gm)];
  if (providerLines.length > 1) throw new Error('Multiple root model_provider settings');
  const previous = providerLines[0]?.[0] ?? '';
  const encoded = Buffer.from(previous, 'utf8').toString('base64');
  const managed = [start, `# previous-provider-base64: ${encoded}`, `model_provider = "${providerName}"`, end].join(newline);
  let changedPrefix;
  if (previous) changedPrefix = replaceOnce(prefix, previous, managed);
  else changedPrefix = prefix + (prefix && !prefix.endsWith(newline) ? newline : '') + managed + newline;
  const provider = [providerStart, `[model_providers.${providerName}]`, 'name = "Codex Model Advisor Router"',
    `base_url = "${baseUrl}"`, 'wire_api = "responses"', 'requires_openai_auth = true',
    'supports_websockets = false', providerEnd].join(newline);
  const rest = original.slice(tableIndex);
  const updated = changedPrefix + rest + (rest && !rest.endsWith(newline) ? newline : '') + provider + newline;
  mkdirSync(dirname(path), { recursive: true });
  if (backupDir && existsSync(path)) {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(path, join(backupDir, `config-${new Date().toISOString().replace(/[:.]/g, '-')}.toml`));
  }
  writeIfUnchanged(path, original, updated);
  return { previousProvider: previous, changed: true };
}

export function disableConfig(path) {
  if (!existsSync(path)) return { changed: false };
  const original = readFileSync(path, 'utf8');
  if (!original.includes(start) && !original.includes(providerStart)) return { changed: false };
  const managedPattern = new RegExp(`^${start.replaceAll('-', '\\-')}\\r?\\n# previous-provider-base64: ([A-Za-z0-9+/=]*)\\r?\\nmodel_provider = "${providerName}"\\r?\\n${end.replaceAll('-', '\\-')}\\r?\\n?`, 'm');
  const match = managedPattern.exec(original);
  if (!match) throw new Error('Router model_provider block changed; refusing to alter config');
  const previous = Buffer.from(match[1], 'base64').toString('utf8');
  const providerPattern = new RegExp(`^${providerStart.replaceAll('-', '\\-')}\\r?\\n\\[model_providers\\.${providerName}\\]\\r?\\nname = "Codex Model Advisor Router"\\r?\\nbase_url = "[^"]+"\\r?\\nwire_api = "responses"\\r?\\nrequires_openai_auth = true\\r?\\nsupports_websockets = false\\r?\\n${providerEnd.replaceAll('-', '\\-')}\\r?\\n?`, 'm');
  if (!providerPattern.test(original)) throw new Error('Router provider block changed; refusing to alter config');
  const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
  let updated = original.replace(managedPattern, previous ? previous + newline : '');
  updated = updated.replace(providerPattern, '');
  writeIfUnchanged(path, original, updated);
  return { changed: true };
}
