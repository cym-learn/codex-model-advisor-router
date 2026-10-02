import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
export function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch {} }
}
export const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
