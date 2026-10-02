import { parentPort, workerData } from 'node:worker_threads';
import { readMetadata } from './metadata-store.mjs';
parentPort.on('message', ({ sequence, targets }) => {
  parentPort.postMessage({ sequence, data: readMetadata(workerData.home, targets) });
});
