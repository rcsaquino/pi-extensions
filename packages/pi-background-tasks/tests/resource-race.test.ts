import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { ResourceLocks } from '../src/resources.ts';
import { scratch } from './helpers.ts';

test('actual four-thread atomic lock-table stress has no partial leases, lost updates or cross-owner release', async t => {
  const root = await scratch('resource-stress-'); await fs.writeFile(join(root, 'counter'), '0'); const workers: Worker[] = [];
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); await fs.rm(root, { recursive: true, force: true }); });
  const rows = await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<{ completed: number }>((resolve, reject) => {
    const worker = new Worker(new URL('./resource-worker.ts', import.meta.url), { workerData: { root, index, rounds: 20 }, execArgv: ['--experimental-strip-types'] }); workers.push(worker); worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error('Synthetic lock worker exited unsuccessfully.')); });
  })));
  assert.deepEqual(rows.map(r => r.completed), [20, 20, 20, 20]); assert.equal(Number(await fs.readFile(join(root, 'counter'), 'utf8')), 80);
  for (let i = 0; i < 4; i++) assert.equal((await fs.readFile(join(root, `output-${i}`))).length, 20);
  assert.equal(new ResourceLocks(join(root, 'locks')).conflicts([{ path: root, mode: 'write' }]), false);
});
test('a killed owner with a surviving synthetic writer cannot have its uncertain direct lease stolen', async t => {
  const root = await scratch('resource-crash-'); const writerPath = join(root, 'writer.mjs'), ownerPath = join(root, 'owner.mjs'), target = join(root, 'synthetic-output');
  await fs.writeFile(writerPath, `import {writeFileSync} from 'node:fs'; let n=0; const timer=setInterval(()=>writeFileSync(process.argv[2],String(++n)),20); process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)});`);
  const module = new URL('../src/resources.ts', import.meta.url).href;
  await fs.writeFile(ownerPath, `import {ResourceLocks} from ${JSON.stringify(module)}; import {spawn} from 'node:child_process'; const [root,target,script]=process.argv.slice(2); const locks=new ResourceLocks(root+'/locks'); const held=await locks.acquire([{path:root,mode:'write'}],true,false,false); if(!held)throw new Error('fixture failed'); const child=spawn(process.execPath,[script,target],{detached:true,stdio:'ignore'}); process.stdout.write(JSON.stringify({child:child.pid})+'\\n'); await new Promise(()=>{});`);
  const owner = spawn(process.execPath, ['--experimental-strip-types', ownerPath, root, target, writerPath], { cwd: root, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }); let child: number | undefined;
  t.after(async () => { if (child) try { process.kill(child, 'SIGTERM'); } catch { /* already stopped */ } owner.kill('SIGKILL'); await fs.rm(root, { recursive: true, force: true }); });
  const ready = await new Promise<{ child: number }>((resolve, reject) => { let output = ''; owner.stdout.on('data', data => { output += data; if (output.includes('\n')) resolve(JSON.parse(output.trim())); }); owner.once('error', reject); owner.once('exit', code => { if (!output) reject(new Error(`Synthetic owner failed before admission (${code}).`)); }); }); child = ready.child;
  for (let i = 0; i < 100 && !(await fs.stat(target).catch(() => undefined)); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(await fs.stat(target)); const exited = new Promise<void>(resolve => owner.once('exit', () => resolve())); owner.kill('SIGKILL'); await exited;
  const locks = new ResourceLocks(join(root, 'locks')); assert.equal(await locks.acquire([{ path: root, mode: 'write' }]), undefined);
  const first = await fs.readFile(target, 'utf8'); await new Promise(r => setTimeout(r, 60)); assert.notEqual(await fs.readFile(target, 'utf8'), first, 'surviving child still writes, so dead parent PID alone is insufficient');
  process.kill(child, 'SIGTERM'); await new Promise(r => setTimeout(r, 60)); const stopped = await fs.readFile(target, 'utf8'); await new Promise(r => setTimeout(r, 60)); assert.equal(await fs.readFile(target, 'utf8'), stopped);
  assert.equal(await locks.acquire([{ path: root, mode: 'write' }]), undefined, 'explicit review is still required, never automatic replay/recovery of uncertain effects');
  child = undefined;
});
