import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, readJsonFile, startSupervisor, waitForFile, type SupervisorHandle } from './helpers.ts';

async function finish(handle: SupervisorHandle, timeoutMs = 20000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      handle.done,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('supervisor did not exit')), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function withRun(
  t: TestContext,
  options: Parameters<typeof startSupervisor>[0],
  run: (handle: SupervisorHandle) => Promise<void>,
): Promise<void> {
  const handle = await startSupervisor(options);
  t.after(async () => { handle.stop(); await cleanup(handle.root); });
  await run(handle);
}

test('a settled run writes the final message as the report and exits 0', async t => {
  await withRun(t, { scenario: { text: 'exact report text' } }, async handle => {
    await finish(handle);
    assert.equal(await handle.exitCode(), 0);
    assert.equal(await handle.report(), 'exact report text');
    assert.equal(await waitForFile(join(handle.dir, 'exit.reason'), text => text.trim(), 500), undefined);
    const record = await readJsonFile<Record<string, unknown>>(join(handle.dir, 'task.json'));
    assert.equal(record?.sessionId, 'fixture');
  });
});

test('an empty report exits 3 and writes no report file', async t => {
  await withRun(t, { scenario: { text: '   ' } }, async handle => {
    await finish(handle);
    assert.equal(await handle.exitCode(), 3);
    assert.equal(await handle.report(), undefined);
  });
});

test('only the final run generation supplies the report', async t => {
  await withRun(t, { scenario: { turns: 2, texts: ['first message', 'second message'] } }, async handle => {
    await finish(handle);
    assert.equal(await handle.report(), 'second message');
  });
});

test('headless dialogs are cancelled and counted', async t => {
  await withRun(t, { scenario: { dialogMethods: ['confirm', 'input'], text: 'ok' } }, async handle => {
    await finish(handle);
    assert.equal(await handle.exitCode(), 0);
    const dialogs = await readJsonFile<{ count: number }>(join(handle.dir, 'dialogs.json'));
    assert.equal(dialogs?.count, 2);
    const response = await readJsonFile<{ cancelled: boolean }>(join(handle.recordDir, 'dialog-response.json'));
    assert.equal(response?.cancelled, true);
  });
});

test('steering during a run is forwarded, acked and preserved', async t => {
  await withRun(t, { scenario: { text: 'done', settleDelayMs: 1500 } }, async handle => {
    await waitForFile(join(handle.recordDir, 'started-1.json'), () => true, 5000);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(handle.dir, 'steer'), { recursive: true });
    await writeFile(join(handle.dir, 'steer', '0001.json'), JSON.stringify({ message: 'Also check the tests', at: new Date().toISOString() }));
    const ack = await waitForFile(join(handle.dir, 'steer', '0001.ack'), text => JSON.parse(text) as { disposition: string }, 5000);
    assert.equal(ack?.disposition, 'queued');
    const steers = readFileSync(join(handle.recordDir, 'steers.txt'), 'utf8');
    assert.match(steers, /Steering from Eve/);
    assert.match(steers, /Also check the tests/);
    await finish(handle);
    assert.equal(await handle.exitCode(), 0);
  });
});

test('a steer landing during finalization revives the run as a prompt', async t => {
  await withRun(t, { scenario: { text: 'first report' } }, async handle => {
    await waitForFile(join(handle.recordDir, 'settled-1.json'), () => true, 8000);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(handle.dir, 'steer'), { recursive: true });
    await writeFile(join(handle.dir, 'steer', '0001.json'), JSON.stringify({ message: 'One more thing', at: new Date().toISOString() }));
    await waitForFile(join(handle.recordDir, 'settled-2.json'), () => true, 8000);
    const ack = await waitForFile(join(handle.dir, 'steer', '0001.ack'), text => JSON.parse(text) as { disposition: string }, 5000);
    assert.equal(ack?.disposition, 'started');
    await finish(handle);
    assert.equal(await handle.exitCode(), 0);
    assert.equal(await handle.report(), 'first report');
  });
});

test('the timeout aborts the worker and records 124 with a partial report', async t => {
  await withRun(t, { scenario: { text: 'partial', hang: true }, task: { timeoutSeconds: 1 } }, async handle => {
    await finish(handle, 15000);
    assert.equal(await handle.exitCode(), 124);
    assert.equal(await handle.report(), 'partial');
  });
});

test('the turn limit aborts with exit 5', async t => {
  await withRun(t, { scenario: { turns: 5, stepDelayMs: 5, hang: true }, task: { maxTurns: 2 } }, async handle => {
    await finish(handle, 15000);
    assert.equal(await handle.exitCode(), 5);
  });
});

test('SIGTERM runs the cancel path and exits 130', async t => {
  await withRun(t, { scenario: { text: 'cancelled', settleDelayMs: 5000 } }, async handle => {
    await waitForFile(join(handle.recordDir, 'started-1.json'), () => true, 5000);
    handle.child!.kill('SIGTERM');
    await finish(handle, 15000);
    assert.equal(await handle.exitCode(), 130);
  });
});

test('a dead parent is detected within one check and exits 131', async t => {
  const handle = await startSupervisor({ shimParent: true, scenario: { text: 'x', settleDelayMs: 5000 } });
  t.after(async () => { handle.stop(); await cleanup(handle.root); });
  const code = await waitForFile(join(handle.dir, 'exit.code'), text => Number(text.trim()), 10000);
  assert.equal(code, 131);
  assert.equal(await waitForFile(join(handle.dir, 'exit.reason'), text => text.trim(), 2000), 'parent_gone');
});

test('a brief with quotes, substitutions and newlines reaches the worker verbatim', async t => {
  const brief = 'Check "quoted" text, $(echo unsafe), `backticks`; and a newline\nsecond line.';
  await withRun(t, { brief, scenario: { text: 'ok' } }, async handle => {
    await finish(handle);
    const prompts = readFileSync(join(handle.recordDir, 'prompts.txt'), 'utf8');
    assert.ok(prompts.includes(brief));
  });
});

test('an invalid task record is refused before any worker starts', async t => {
  await withRun(t, { task: { timeoutSeconds: undefined } }, async handle => {
    await finish(handle, 5000);
    assert.equal(await handle.exitCode(), 74);
  });
});

test('a handled initial prompt exits 4 instead of waiting forever', async t => {
  await withRun(t, { scenario: { promptReply: 'handled' } }, async handle => {
    await finish(handle, 15000);
    assert.equal(await handle.exitCode(), 4);
  });
});

test('reports are capped at 2 MiB with a truncation marker', async t => {
  await withRun(t, { scenario: { text: 'y'.repeat(2200000) } }, async handle => {
    await finish(handle, 20000);
    const report = await handle.report();
    assert.ok(report);
    assert.ok(Buffer.byteLength(report!) <= 2 * 1024 * 1024 + 64, `report was ${Buffer.byteLength(report!)} bytes`);
    assert.match(report!, /\[report truncated at 2 MiB\]$/);
    assert.equal(await handle.exitCode(), 0);
  });
});

test('a vanished run directory makes the supervisor exit 6', async t => {
  const handle = await startSupervisor({ scenario: { text: 'x', settleDelayMs: 5000 } });
  t.after(async () => { await cleanup(handle.root); });
  await waitForFile(join(handle.recordDir, 'started-1.json'), () => true, 5000);
  await rm(handle.dir, { recursive: true, force: true });
  await finish(handle, 10000);
  assert.equal((await handle.done).code, 6);
});

test('invalid protocol output is a protocol failure with exit 4', async t => {
  await withRun(t, { scenario: { badJson: true } }, async handle => {
    await finish(handle, 15000);
    assert.equal(await handle.exitCode(), 4);
  });
});

test('a worker that cannot spawn exits 4 with spawn_error', async t => {
  await withRun(t, { argv: ['definitely-not-a-real-command-xyz'] }, async handle => {
    await finish(handle, 15000);
    assert.equal(await handle.exitCode(), 4);
    assert.equal(await waitForFile(join(handle.dir, 'exit.reason'), text => text.trim(), 2000), 'spawn_error');
  });
});

test('child.log is capped and keeps its tail', async t => {
  await withRun(t, { scenario: { text: 'ok', stderrBytes: 1500000 } }, async handle => {
    await finish(handle, 20000);
    const log = await readFileSync(join(handle.dir, 'child.log'));
    assert.ok(log.length < 1100 * 1024, `log was ${log.length} bytes`);
    assert.match(log.subarray(0, 64).toString('utf8'), /log truncated/);
  });
});

test('an ignored abort is killed after the grace period', async t => {
  await withRun(t, { scenario: { text: 'stuck', ignoreAbort: true, hang: true }, task: { timeoutSeconds: 1 } }, async handle => {
    await waitForFile(join(handle.recordDir, 'started-1.json'), () => true, 5000);
    const started = Date.now();
    await finish(handle, 20000);
    const code = await handle.exitCode();
    assert.ok(code === 124 || code === 4, `unexpected code ${code}`);
    assert.ok(Date.now() - started < 15000);
  });
});

