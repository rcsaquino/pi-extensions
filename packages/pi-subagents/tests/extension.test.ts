import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, readReport } from './harness.ts';
import { cleanup, waitFor, waitForFile, writeJsonFile } from './helpers.ts';

async function harness(t: test.TestContext, options: Parameters<typeof createHarness>[0] = {}) {
  const h = await createHarness(options);
  t.after(async () => {
    await h.shutdown();
    await h.killRuns();
    await cleanup(h.root);
    h.restore();
  });
  return h;
}

test('dispatch writes the run record, brief and argv, then reports ready', async t => {
  const h = await harness(t, { scenario: { text: 'finished' } });
  const run = await h.dispatch({ title: 'Check the build' });
  assert.match(run.id, /^\d{8}-\d{6}-[0-9a-f]{6}$/);
  assert.equal(run.status, 'running');

  const dir = h.runDir(run.id);
  const record = await h.record(run.id);
  assert.equal(record?.agent, 'worker');
  assert.equal(record?.title, 'Check the build');
  assert.equal(record?.sessionId, 'session-a');
  assert.equal(record?.provider, 'test-provider');
  assert.equal(record?.model, 'test-model');
  assert.equal(record?.thinking, 'medium');
  assert.equal(typeof record?.pid, 'number');

  const brief = await readFile(join(dir, 'brief.md'), 'utf8');
  assert.match(brief, /^# Brief\n/);
  assert.match(brief, /From: Eve/);
  assert.match(brief, /Do the thing\./);

  const argv = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[];
  assert.deepEqual(argv.slice(0, 4), ['pi', '--mode', 'rpc', '-ne']);
  assert.ok(argv.includes('--append-system-prompt'));
  assert.ok(argv.includes('--provider') && argv.includes('test-provider'));
  assert.ok(argv.includes('--model') && argv.includes('test-model'));
  assert.ok(argv.includes('--thinking') && argv.includes('medium'));
  assert.equal(argv[argv.length - 1], join(dir, 'session'));
});

test('settlement injects one hidden follow-up notice with the report', async t => {
  const h = await harness(t, { scenario: { text: 'all tests pass' } });
  const run = await h.dispatch();
  const { message, options } = await h.waitForNotice();
  assert.equal(message.customType, 'subagent-notice');
  assert.equal((message as { display: boolean }).display, false);
  assert.equal(options.triggerTurn, true);
  assert.equal(options.deliverAs, 'followUp');
  assert.match(String(message.content), /Status: done/);
  assert.match(String(message.content), /all tests pass/);
  assert.match(String(message.content), /untrusted worker output/);

  const record = await h.record(run.id);
  assert.equal(record?.status, 'done');
  assert.equal(record?.notice, 'sent');
  assert.equal(record?.reportBytes, Buffer.byteLength('all tests pass'));

  await h.call('subagent_tasks', { action: 'list' });
  assert.equal(h.notices.length, 1, 'a repeat reconcile must not duplicate the notice');
});

test('denied dialogs are counted in the run record and the notice', async t => {
  const h = await harness(t, { scenario: { text: 'ok', dialogMethods: ['confirm'] } });
  const run = await h.dispatch();
  const { message } = await h.waitForNotice();
  const record = await h.record(run.id);
  assert.equal(record?.deniedDialogs, 1);
  assert.match(String(message.content), /Denied dialogs: 1/);
});

test('tasks exposes status and paginated results', async t => {
  const long = 'x'.repeat(13000);
  const h = await harness(t, { scenario: { text: long } });
  const run = await h.dispatch();
  await h.waitForNotice();
  const report = await readReport(h.runDir(run.id));
  assert.equal(report, long);

  const first = await h.call('subagent_tasks', { action: 'result', id: run.id }) as { details: { text: string; totalChars: number; nextOffset?: number } };
  assert.equal(first.details.text.length, 12000);
  assert.equal(first.details.totalChars, 13000);
  assert.equal(first.details.nextOffset, 12000);

  const second = await h.call('subagent_tasks', { action: 'result', id: run.id, offset: 12000 }) as { details: { text: string; nextOffset?: number } };
  assert.equal(second.details.text.length, 1000);
  assert.equal(second.details.nextOffset, undefined);

  const status = await h.call('subagent_tasks', { action: 'status', id: run.id }) as { details: Record<string, unknown> };
  assert.equal(status.details.id, run.id);
  assert.equal(status.details.status, 'done');
});

test('steering is accepted mid-run and rejected after settlement', async t => {
  const h = await harness(t, { scenario: { text: 'done', settleDelayMs: 1500 } });
  const run = await h.dispatch();
  await waitForFile(join(h.root, 'record', 'started-1.json'), () => true, 5000);
  const steer = await h.call('subagent_steer', { id: run.id, message: 'Also run the linter' }) as { details: { disposition: string } };
  assert.equal(steer.details.disposition, 'queued');
  await h.waitForNotice();
  await assert.rejects(h.call('subagent_steer', { id: run.id, message: 'too late' }), /already settled/);
});

test('cancel aborts a running worker and records a cancellation', async t => {
  const h = await harness(t, { scenario: { text: 'never used', settleDelayMs: 20000 } });
  const run = await h.dispatch();
  await waitForFile(join(h.root, 'record', 'started-1.json'), () => true, 5000);
  await h.call('subagent_tasks', { action: 'cancel', id: run.id });
  const record = await waitFor(async () => {
    const current = await h.record(run.id);
    return current?.status !== 'running' ? current : undefined;
  }, 20000);
  assert.equal(record?.status, 'cancelled');
  assert.equal(record?.reason, 'cancelled');
  await h.waitForNotice();
});

test('list paginates 20 records per page', async t => {
  const h = await harness(t);
  const runs = join(h.agentDir, 'subagents', h.agent, 'runs');
  const base = {
    schemaVersion: 1, id: '', agent: 'worker', title: 't', cwd: h.root,
    sessionId: 'session-a', sessionFile: '/tmp/s', status: 'done',
    createdAt: new Date().toISOString(), provider: 'p', model: 'm', thinking: 'off',
    timeoutSeconds: 60, maxTurns: 5,
    steerCount: 0, deniedDialogs: 0, notice: 'sent',
  };
  for (let index = 0; index < 21; index += 1) {
    const id = `20261001-0000${String(index).padStart(2, '0')}-abcdef`;
    await mkdir(join(runs, id), { recursive: true });
    await writeJsonFile(join(runs, id, 'task.json'), {
      ...base, id, createdAt: new Date(Date.now() - index * 1000).toISOString(),
    });
  }
  const first = await h.call('subagent_tasks', { action: 'list', page: 1 }) as { details: { runs: unknown[] } };
  assert.equal(first.details.runs.length, 20);
  const second = await h.call('subagent_tasks', { action: 'list', page: 2 }) as { details: { runs: unknown[] } };
  assert.equal(second.details.runs.length, 1);
});

test('another session cannot inspect or steer an owned run', async t => {
  const a = await createHarness({ scenario: { text: 'x', settleDelayMs: 5000 } });
  t.after(async () => { await a.shutdown(); await a.killRuns(); await cleanup(a.root); a.restore(); });
  const run = await a.dispatch();
  const b = await createHarness({ root: a.root, sessionId: 'session-b', setup: false });
  t.after(async () => { await b.shutdown(); b.restore(); });
  await assert.rejects(b.call('subagent_tasks', { action: 'status', id: run.id }), /not found in this session/);
  await assert.rejects(b.call('subagent_tasks', { action: 'cancel', id: run.id }), /not found in this session/);
});

test('steering rejects blank and oversized messages', async t => {
  const h = await harness(t, { scenario: { text: 'x', settleDelayMs: 5000 } });
  const run = await h.dispatch();
  await assert.rejects(h.call('subagent_steer', { id: run.id, message: '   ' }), /empty/);
  await assert.rejects(h.call('subagent_steer', { id: run.id, message: 'x'.repeat(8001) }), /8000/);
});

test('the running limit rejects a second dispatch', async t => {
  const h = await harness(t, { maxRunning: '1', scenario: { text: 'x', settleDelayMs: 4000 } });
  await h.dispatch({ title: 'first' });
  await assert.rejects(h.dispatch({ title: 'second' }), /At most 1 subagents? may run at once/);
});

test('an invalid agent.json blocks only that agent', async t => {
  const h = await harness(t);
  const broken = join(h.agentDir, 'subagents', 'broken');
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, 'prompt.md'), 'broken definition');
  await writeFile(join(broken, 'agent.json'), JSON.stringify({ tools: ['read'] }));
  await assert.rejects(h.dispatch({ agent: 'broken' }), /unknown key "tools"/);
  const run = await h.dispatch({ agent: 'worker' });
  assert.equal(run.agent, 'worker');
});

test('titles collapse newlines before they reach records and notices', async t => {
  const h = await harness(t, { scenario: { text: 'ok' } });
  const run = await h.dispatch({ title: 'two\nlines' });
  const record = await h.record(run.id);
  assert.equal(record?.title, 'two lines');
  const { message } = await h.waitForNotice();
  assert.match(String(message.content), /Title: two lines/);
});

test('a running run reports status without a report', async t => {
  const h = await harness(t, { scenario: { text: 'later', settleDelayMs: 5000 } });
  const run = await h.dispatch();
  const page = await h.call('subagent_tasks', { action: 'result', id: run.id }) as { details: { status: string; text: string } };
  assert.equal(page.details.status, 'running');
  assert.match(page.details.text, /still running/);
});

test('unknown agents list the available definitions', async t => {
  const h = await harness(t);
  await assert.rejects(h.dispatch({ agent: 'missing' }), /Unknown subagent "missing". Available: worker/);
});

test('dispatch rejects an empty root, a bad cwd and an ephemeral session', async t => {
  const empty = await harness(t);
  await assert.rejects(empty.dispatch({ agent: 'nobody' }), /Unknown subagent/);

  const bad = await harness(t);
  await assert.rejects(bad.dispatch({ cwd: join(bad.root, 'absent') }), /cwd does not exist/);
  await assert.rejects(bad.dispatch({ cwd: 'relative/path' }), /absolute path/);

  const ephemeral = await harness(t, { ephemeral: true });
  await assert.rejects(ephemeral.dispatch(), /requires a saved session/);
});

test('a subagent cannot dispatch another subagent', async t => {
  const h = await harness(t);
  const previous = process.env.PI_SUBAGENTS_WORKER;
  process.env.PI_SUBAGENTS_WORKER = '1';
  t.after(() => { if (previous === undefined) delete process.env.PI_SUBAGENTS_WORKER; else process.env.PI_SUBAGENTS_WORKER = previous; });
  await assert.rejects(h.dispatch(), /cannot dispatch other subagents/);
});

test('runs are visible only to the dispatching session and pending notices wait', async t => {
  const a = await createHarness({ scenario: { text: 'for A', settleDelayMs: 0 } });
  t.after(async () => { await a.shutdown(); await a.killRuns(); await cleanup(a.root); a.restore(); });
  const run = await a.dispatch();
  await a.shutdown();
  await waitForFile(join(a.runDir(run.id), 'exit.code'), () => true, 15000);

  const b = await createHarness({ root: a.root, sessionId: 'session-b', setup: false });
  const other = await b.call('subagent_tasks', { action: 'list' }) as { details: { runs: unknown[] } };
  assert.equal(other.details.runs.length, 0);
  await b.shutdown(); b.restore();

  const reopened = await createHarness({ root: a.root, sessionId: 'session-a', setup: false });
  t.after(async () => { await reopened.shutdown(); await cleanup(a.root); reopened.restore(); });
  const listed = await reopened.call('subagent_tasks', { action: 'list' }) as { details: { runs: { status: string }[] } };
  assert.equal(listed.details.runs.length, 1);
  const notice = await reopened.waitForNotice();
  assert.match(String(notice.message.content), /for A/);
});

test('an unsupported schema version is listed as incompatible and not acted on', async t => {
  const h = await harness(t);
  const runs = join(h.agentDir, 'subagents', h.agent, 'runs');
  await mkdir(join(runs, '20261020-000000-abcdef'), { recursive: true });
  await writeJsonFile(join(runs, '20261020-000000-abcdef', 'task.json'), {
    schemaVersion: 99, id: '20261020-000000-abcdef', sessionId: 'session-a', agent: 'worker',
  });
  const listed = await h.call('subagent_tasks', { action: 'list' }) as { details: { runs: { status: string }[] } };
  assert.equal(listed.details.runs[0]?.status, 'incompatible');
  const status = await h.call('subagent_tasks', { action: 'status', id: '20261020-000000-abcdef' }) as { details: { status: string } };
  assert.equal(status.details.status, 'incompatible');
});

test('retention removes old runs, task-less debris, and keeps pending notices', async t => {
  const h = await harness(t);
  const runs = join(h.agentDir, 'subagents', h.agent, 'runs');
  const base = {
    schemaVersion: 1, id: '', agent: 'worker', title: 't', cwd: h.root,
    sessionId: 'session-a', sessionFile: '/tmp/s', status: 'done',
    createdAt: new Date().toISOString(), provider: 'p', model: 'm', thinking: 'off',
    timeoutSeconds: 60, maxTurns: 5,
    steerCount: 0, deniedDialogs: 0, notice: 'sent',
  };
  for (let index = 0; index < 102; index += 1) {
    const id = `20261001-0000${String(index).padStart(2, '0')}-abcdef`;
    await mkdir(join(runs, id), { recursive: true });
    await writeJsonFile(join(runs, id, 'task.json'), { ...base, id });
  }
  const old = '20260901-000000-000001';
  await mkdir(join(runs, old), { recursive: true });
  await writeJsonFile(join(runs, old, 'task.json'), {
    ...base, id: old, createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const pending = '20260901-000000-000002';
  await mkdir(join(runs, pending), { recursive: true });
  await writeJsonFile(join(runs, pending, 'task.json'), {
    ...base, id: pending, notice: 'pending', createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const foreign = '20260901-000000-000004';
  await mkdir(join(runs, foreign), { recursive: true });
  await writeJsonFile(join(runs, foreign, 'task.json'), {
    ...base, id: foreign, sessionId: 'session-other',
    createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const debris = join(runs, '20260101-000000-000003');
  await mkdir(join(debris, 'session'), { recursive: true });
  const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  await utimes(debris, oldTime, oldTime);

  await h.call('subagent_tasks', { action: 'list' });
  assert.equal(h.notices.length, 1, 'the pending notice is delivered before pruning');
  const remaining = await readdir(runs);
  assert.equal(remaining.length, 101, `unexpected survivors: ${remaining.length}`);
  assert.ok(!existsSync(join(runs, old)), 'old run should be pruned');
  assert.ok(!existsSync(debris), 'debris should be pruned');
  assert.ok(!existsSync(join(runs, pending)), 'a delivered pending run may then age out');
  assert.ok(existsSync(join(runs, foreign)), 'another session is never touched');
  assert.equal((await readdir(runs)).filter(name => /^20261001-/.test(name)).length, 100);
});

test('a spawn failure is reported synchronously without a notice', async t => {
  const h = await harness(t);
  const previous = process.env.PATH;
  process.env.PATH = '/nonexistent-bin';
  t.after(() => { process.env.PATH = previous; });
  await assert.rejects(h.dispatch(), /did not start|supervisor/i);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(h.notices.length, 0);
});


test('before_agent_start lists only subagents that have a description.md', async t => {
  const h = await harness(t, { setup: false });
  const make = async (name: string, description?: string) => {
    const dir = join(h.agentDir, 'subagents', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'prompt.md'), 'prompt');
    if (description !== undefined) await writeFile(join(dir, 'description.md'), description);
  };
  await make('listed', 'Writes short poems about cats.');
  await make('unlisted');

  const event = {
    type: 'before_agent_start', messageType: 'user', prompt: 'hi', systemPrompt: '',
    systemPromptOptions: { sections: {} as Record<string, string> },
  };
  await h.emit('before_agent_start', event);
  assert.equal(event.systemPromptOptions.sections.subagents, '- listed: Writes short poems about cats.');
});

test('before_agent_start adds no section when no subagent is described', async t => {
  const h = await harness(t, { setup: false });
  const dir = join(h.agentDir, 'subagents', 'silent');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'prompt.md'), 'prompt');

  const event = {
    type: 'before_agent_start', messageType: 'user', prompt: 'hi', systemPrompt: '',
    systemPromptOptions: { sections: {} as Record<string, string> },
  };
  await h.emit('before_agent_start', event);
  assert.equal(event.systemPromptOptions.sections.subagents, undefined);
});
