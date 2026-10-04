import { parentPort, workerData } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { ResourceLocks } from '../src/resources.ts';

const { root, index, rounds } = workerData as { root: string; index: number; rounds: number };
const locks = new ResourceLocks(join(root, 'locks'));
for (let i = 0; i < rounds; i++) {
  let release: (() => Promise<void>) | undefined;
  for (let retry = 0; retry < 1000 && !release; retry++) {
    release = await locks.acquire([{ path: join(root, 'counter'), mode: 'write' }, { path: join(root, `output-${index}`), mode: 'write' }]);
    if (!release) await new Promise(r => setTimeout(r, 2 + index));
  }
  if (!release) throw new Error('Synthetic race fixture exhausted retries.');
  try {
    const count = Number(await fs.readFile(join(root, 'counter'), 'utf8'));
    await new Promise(r => setImmediate(r)); await fs.writeFile(join(root, 'counter'), String(count + 1)); await fs.appendFile(join(root, `output-${index}`), 'x');
  } finally { await release(); }
}
parentPort!.postMessage({ completed: rounds });
