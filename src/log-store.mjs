import { appendFileSync, existsSync, copyFileSync, renameSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';

export const logLimit = 10 * 1024 * 1024;
export function logFiles(path) { return [3, 2, 1].map((n) => `${path}.${n}`).concat(path).filter(existsSync); }
export function readLogRecords(path, limit = Infinity) {
  const files = logFiles(path), pieces = [];
  let remaining = limit, totalBytes = 0;
  for (const file of [...files].reverse()) {
    const size = statSync(file).size; totalBytes += size;
    if (remaining <= 0) continue;
    const length = Math.min(size, remaining), start = size - length;
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length); readSync(fd, buffer, 0, length, start);
      const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift();
      pieces.unshift(lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }));
      remaining -= length;
    } finally { closeSync(fd); }
  }
  return { records: pieces.flat(), truncated: totalBytes > limit, totalBytes, retainedFiles: files.length };
}
export function logStore(path, active, maxBytes = logLimit) {
  let state = 'ready';
  function rotate() {
    try {
      if (active() || !existsSync(path) || statSync(path).size < maxBytes) return;
      // Preserve the original pre-rotation log once; it is not part of the rolling history.
      if (!existsSync(`${path}.pre-031`) && !existsSync(`${path}.1`)) copyFileSync(path, `${path}.pre-031`);
      if (existsSync(`${path}.3`)) unlinkSync(`${path}.3`);
      for (const n of [2, 1]) if (existsSync(`${path}.${n}`)) renameSync(`${path}.${n}`, `${path}.${n + 1}`);
      renameSync(path, `${path}.1`);
      state = 'ready';
    } catch { state = 'unavailable'; }
  }
  return { append(record) { try { appendFileSync(path, JSON.stringify(record) + '\n'); } catch { state = 'unavailable'; } },
    rotate, status() { return { state, maxBytes, archives: 3, rotationDeferred: active() > 0 }; } };
}
