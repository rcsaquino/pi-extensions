import test from 'node:test';
import assert from 'node:assert/strict';
import { Admission } from '../src/admission.ts';

test('foreground start priority defers NEW worker requests, does not abort live streams, and keeps bounded backpressure', async () => {
  const admission = new Admission(1, 2, 1000);
  const release = await admission.acquire('model'); let second = false;
  admission.setForeground(true); const pending = admission.acquire('model').then(r => { second = true; return r; });
  const cancel = new AbortController(); const cancelled = admission.acquire('model', cancel.signal); await assert.rejects(admission.acquire('model'), /queue full/);
  cancel.abort(); await assert.rejects(cancelled, /cancelled/); release(); await new Promise(r => setImmediate(r)); assert.equal(second, false);
  admission.setForeground(false); const finish = await pending; assert.equal(second, true); finish(); finish(); admission.close();
});
test('queue aging admits a waiting worker without guaranteeing provider capacity or preempting foreground', async () => {
  const admission = new Admission(1, 4, 10); admission.setForeground(true); let accepted = false;
  const pending = admission.acquire('model').then(r => { accepted = true; return r; });
  await new Promise(r => setTimeout(r, 25)); const release = await pending; assert.equal(accepted, true); assert.equal(admission.foreground, true); release(); admission.close();
});
test('expensive subprocess admission is independent, bounded to one live tool and not released by cancellation of a waiter', async () => {
  const admission = new Admission(2); const model = await admission.acquire('model'), process = await admission.acquire('subprocess');
  let second = false; const next = admission.acquire('subprocess').then(r => { second = true; return r; });
  await new Promise(r => setImmediate(r)); assert.equal(second, false); model(); assert.equal(second, false); process(); const release = await next; assert.equal(second, true); release(); admission.close();
});
test('shutdown rejects waiting requests without changing already-running ownership', async () => {
  const admission = new Admission(1); const release = await admission.acquire('model'); const pending = admission.acquire('model'); admission.close(); await assert.rejects(pending, /stopped/); release();
});
