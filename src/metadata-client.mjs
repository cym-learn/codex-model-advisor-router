import { Worker } from 'node:worker_threads';

export function metadataClient(home) {
  let cache = { state: 'loading', historyState: 'loading', threads: {}, turns: {} };
  let worker, inFlight = false, closed = false, lastAt = 0, signature = '', sequence = 0;
  function fail() { cache = { state: 'unavailable', historyState: 'unavailable', threads: {}, turns: {} }; inFlight = false; }
  return {
    snapshot(targets) {
      if (closed || !home) return cache;
      const key = JSON.stringify(targets);
      if (inFlight || (key === signature && Date.now() - lastAt < 1000)) return cache;
      if (!worker) {
        worker = new Worker(new URL('./metadata-worker.mjs', import.meta.url), { workerData: { home } });
        worker.on('message', (message) => { cache = { ...message.data, updatedAt: new Date().toISOString() }; inFlight = false; lastAt = Date.now(); });
        worker.on('error', fail);
        worker.on('exit', () => { worker = null; fail(); });
        worker.unref();
      }
      signature = key; inFlight = true;
      worker.postMessage({ sequence: ++sequence, targets });
      return cache;
    },
    close() { closed = true; return worker?.terminate(); },
  };
}
