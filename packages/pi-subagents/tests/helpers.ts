import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';

export const SUPERVISOR = resolve(import.meta.dirname, '../supervisor.mjs');
export const WORKER = resolve(import.meta.dirname, 'fixtures/fake-worker.mjs');

export async function scratch(prefix: string): Promise<string> {
  const parent = resolve(process.env.PI_SUBAGENTS_TEST_ROOT ?? join(process.env.TMPDIR ?? '/tmp', 'pi-subagents-tests'));
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

export async function makeBin(root: string): Promise<string> {
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const file = join(bin, 'pi');
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${WORKER}" "$@"\n`);
  await chmod(file, 0o755);
  return bin;
}

export interface SupervisorOptions {
  scenario?: Record<string, unknown>;
  task?: Record<string, unknown>;
  argv?: string[];
  brief?: string;
  shimParent?: boolean;
}

export interface SupervisorHandle {
  root: string;
  dir: string;
  recordDir: string;
  child?: ChildProcess;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exitCode(): Promise<number | undefined>;
  reason(): Promise<string | undefined>;
  report(): Promise<string | undefined>;
  log(): Promise<string>;
  stop(): void;
}

export async function startSupervisor(options: SupervisorOptions = {}): Promise<SupervisorHandle> {
  const root = await scratch('sub-run-');
  const dir = join(root, 'run');
  await mkdir(dir, { recursive: true });
  const recordDir = join(root, 'record');
  const scenarioPath = join(root, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify({ recordDir, ...options.scenario }));
  const bin = await makeBin(root);

  const task = {
    schemaVersion: 1, id: 'run', agent: 'test', sessionId: 'fixture',
    timeoutSeconds: 30, maxTurns: 10, cwd: dir, ...options.task,
  };
  await writeFile(join(dir, 'task.json'), JSON.stringify(task));
  await writeFile(join(dir, 'argv.json'), JSON.stringify(options.argv ?? ['pi', '--mode', 'rpc']));
  await writeFile(join(dir, 'brief.md'), options.brief ?? 'Do the thing.');

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PI_FAKE_SCENARIO: scenarioPath,
  };

  let child: ChildProcess | undefined;
  let done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  if (options.shimParent) {
    const script = `const {spawn}=require('node:child_process');`
      + `const c=spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:'ignore',env:process.env});`
      + `c.unref();process.exit(0);`;
    const shim = spawn(process.execPath, ['-e', script, SUPERVISOR, dir], { env, stdio: 'ignore' });
    done = new Promise(resolveDone => shim.once('exit', () => resolveDone({ code: null, signal: null })));
    await done;
    done = Promise.resolve({ code: null, signal: null });
  } else {
    child = spawn(process.execPath, [SUPERVISOR, dir], { env, stdio: 'ignore' });
    done = new Promise(resolveDone => child!.once('exit', (code, signal) => resolveDone({ code, signal })));
  }

  const handle: SupervisorHandle = {
    root, dir, recordDir, ...(child ? { child } : {}), done,
    exitCode: () => waitForFile<number>(join(dir, 'exit.code'), text => Number(text.trim()), 15000),
    reason: () => waitForFile<string>(join(dir, 'exit.reason'), text => text.trim(), 5000),
    report: async () => {
      try { return await readFile(join(dir, 'report.md'), 'utf8'); } catch { return undefined; }
    },
    log: async () => {
      try { return await readFile(join(dir, 'supervisor.log'), 'utf8'); } catch { return ''; }
    },
    stop: () => {
      try { child?.kill('SIGKILL'); } catch {}
      try {
        const ready = JSON.parse(readFileSyncSafe(join(dir, 'supervisor.ready')) ?? '{}') as { supervisorPid?: number; workerPid?: number };
        if (ready.workerPid) process.kill(-ready.workerPid, 'SIGKILL');
        if (ready.supervisorPid) process.kill(ready.supervisorPid, 'SIGKILL');
      } catch {}
    },
  };
  return handle;
}

function readFileSyncSafe(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

export async function waitForFile<T>(
  path: string, parse: (text: string) => T, timeoutMs = 5000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return parse(await readFile(path, 'utf8')); } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return undefined;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 15000, interval = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Timed out waiting for condition');
}

export async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return undefined; }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export { readFile, writeFile, mkdir, join };
