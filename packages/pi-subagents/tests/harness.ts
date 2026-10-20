import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import subagents from '../src/index.ts';
import { makeBin, readJsonFile, scratch, waitFor, type SupervisorOptions } from './helpers.ts';

export interface Harness {
  root: string;
  agentDir: string;
  agent: string;
  sessionId: string;
  ctx: ExtensionContext;
  notices: { message: Record<string, unknown>; options: Record<string, unknown> }[];
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  emit(name: string, event: Record<string, unknown>): Promise<unknown[]>;
  dispatch(overrides?: Record<string, unknown>): Promise<{ id: string; status: string; agent: string; title: string }>;
  runDir(id: string): string;
  record(id: string): Promise<Record<string, unknown> | undefined>;
  waitForNotice(count?: number, timeoutMs?: number): Promise<{ message: Record<string, unknown>; options: Record<string, unknown> }>;
  shutdown(): Promise<void>;
  killRuns(): Promise<void>;
  restore(): void;
}

export async function createHarness(options: {
  root?: string;
  sessionId?: string;
  scenario?: Record<string, unknown>;
  agent?: string;
  ephemeral?: boolean;
  setup?: boolean;
  maxRunning?: string;
} = {}): Promise<Harness> {
  const root = options.root ?? await scratch('sub-ext-');
  const agent = options.agent ?? 'worker';
  const agentDir = join(root, 'agent');
  const definitionDir = join(agentDir, 'subagents', agent);
  if (options.setup !== false) {
    await mkdir(definitionDir, { recursive: true });
    await writeFile(join(definitionDir, 'prompt.md'), 'You are a test worker. Eve may steer; do not redo completed work.');
    await writeFile(join(root, 'scenario.json'), JSON.stringify({ recordDir: join(root, 'record'), ...options.scenario }));
  }
  const bin = await makeBin(root);
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PATH: process.env.PATH,
    PI_FAKE_SCENARIO: process.env.PI_FAKE_SCENARIO,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.PI_FAKE_SCENARIO = join(root, 'scenario.json');

  const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
  const handlers = new Map<string, ((...args: never[]) => unknown)[]>();
  const notices: Harness['notices'] = [];
  const pi = {
    registerTool: (tool: { name: string }) => { tools.set(tool.name, tool as never); },
    registerFlag: () => {},
    getFlag: (name: string) => name === 'subagents-max-running' ? options.maxRunning ?? '4' : undefined,
    getThinkingLevel: () => 'medium',
    sendMessage: (message: Record<string, unknown>, sendOptions: Record<string, unknown>) => { notices.push({ message, options: sendOptions }); },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;

  const sessionId = options.sessionId ?? 'session-a';
  const model = { id: 'test-model', provider: 'test-provider' };
  const ctx = {
    cwd: root, mode: 'rpc', hasUI: false, thinkingLevel: 'medium', model,
    modelRegistry: {
      getAll: () => [model],
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => options.ephemeral ? undefined : join(root, 'session.jsonl'),
    },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;

  subagents(pi);

  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool ${name} is not registered`);
    return (tool.execute as unknown as (id: string, args: unknown, signal: unknown, update: unknown, context: ExtensionContext) => Promise<unknown>)(
      'call-1', args, undefined, undefined, ctx,
    );
  };

  const harness: Harness = {
    root, agentDir, agent, sessionId, ctx, notices, call,
    emit: async (name, event) => Promise.all(
      (handlers.get(name) ?? []).map(handler => handler(event as never, ctx as never)),
    ),
    runDir: id => join(definitionDir, 'runs', id),
    record: id => readJsonFile<Record<string, unknown>>(join(definitionDir, 'runs', id, 'task.json')),
    dispatch: async (overrides = {}) => {
      const result = await call('subagent_dispatch', {
        agent, title: 'Test run', brief: 'Do the thing.', cwd: root,
        ...overrides,
      }) as { details: { id: string; status: string; agent: string; title: string } };
      return result.details;
    },
    waitForNotice: async (count = 1, timeoutMs = 20000) => {
      await waitFor(() => notices.length >= count ? true : undefined, timeoutMs);
      return notices[count - 1]!;
    },
    shutdown: async () => {
      for (const handler of handlers.get('session_shutdown') ?? []) await handler({} as never, ctx as never);
    },
    killRuns: async () => {
      const runs = join(agentDir, 'subagents', agent, 'runs');
      let entries: string[] = [];
      try { entries = await (await import('node:fs/promises')).readdir(runs); } catch { return; }
      for (const entry of entries) {
        try {
          const ready = JSON.parse(await readFile(join(runs, entry, 'supervisor.ready'), 'utf8')) as { supervisorPid?: number; workerPid?: number };
          if (ready.workerPid) process.kill(-ready.workerPid, 'SIGKILL');
          if (ready.supervisorPid) process.kill(ready.supervisorPid, 'SIGKILL');
        } catch {}
      }
    },
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
  return harness;
}

export async function readReport(dir: string): Promise<string | undefined> {
  try { return await readFile(join(dir, 'report.md'), 'utf8'); } catch { return undefined; }
}

export type { SupervisorOptions };
