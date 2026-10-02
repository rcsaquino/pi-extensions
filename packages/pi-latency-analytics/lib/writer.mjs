import { parentPort, workerData } from 'node:worker_threads';
import { AnalyticsDatabase } from './database.mjs';

let db;
try {
  db = new AnalyticsDatabase(workerData.path, workerData.instanceId, workerData.pid);
  parentPort.postMessage({ type: 'ready' });
} catch {
  parentPort.postMessage({ type: 'failed', code: 'database_initialization_failed' });
  parentPort.close();
}

// Queue retries here, off the agent thread; preserve write/query ordering.
const queue = [];
let busy = false;
function pump() {
  if (busy || !queue.length || !db) return;
  busy = true;
  const message = queue[0];
  try {
    if (message.type === 'batch') {
      db.batch(message.records);
      if (message.loss?.count) db.loss(message.loss.count, message.loss.traceIds);
      parentPort.postMessage({ type: 'ack', id: message.id });
    } else if (message.type === 'query') {
      parentPort.postMessage({ type: 'result', id: message.id, value: db.query(message.query) });
    } else if (message.type === 'close') {
      db.close();
      parentPort.postMessage({ type: 'result', id: message.id, value: true });
      db = null;
      parentPort.close();
    }
    queue.shift();
    busy = false;
    pump();
  } catch (error) {
    if ((error.errcode === 5 || error.errcode === 6 || /busy|locked/i.test(error.message || '')) && (message.retries || 0) < 4) {
      message.retries = (message.retries || 0) + 1;
      setTimeout(() => { busy = false; pump(); }, 50 * message.retries);
      return;
    }
    // Do not forward database messages, paths, SQL, or record contents into chat.
    parentPort.postMessage({ type: message.type === 'batch' ? 'batch_failed' : 'request_failed', id: message.id, code: 'database_operation_failed' });
    queue.shift();
    busy = false;
    pump();
  }
}
if (db) parentPort.on('message', message => { queue.push(message); pump(); });
