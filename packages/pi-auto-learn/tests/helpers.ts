import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import type { Host, Profile, ProposedFile } from '../src/types.ts';
import { Store } from '../src/state.ts';
import { Writer } from '../src/safe-writer.ts';
import { Learner } from '../src/learner.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { atomicWrite, secureDirectory } from '../src/filesystem.ts';

export async function fixture(t: TestContext, cleanup = true) {
  const tmp = resolve(import.meta.dirname, '../.test-tmp');
  await fs.mkdir(tmp, { recursive: true });
  const base = await fs.mkdtemp(join(tmp, 'case-'));
  const root = join(base, 'agent', 'skills', 'auto-learn');
  const other = join(base, 'agent', 'skills', 'unmanaged');
  const state = join(base, 'agent', 'auto-learn');
  await secureDirectory(root); await secureDirectory(other);
  const store = new Store(state); await store.init(root);
  const writer = new Writer(root, store); const learner = new Learner(store, writer);
  if (cleanup) t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  return { base, root, other, state, store, writer, learner };
}
export function markdown(name = 'release-checklist', body = 'Run the checks. Verify the result.'): string {
  return `---\nname: ${name}\ndescription: A reusable ${name} workflow. Use when performing this task.\n---\n\n# Workflow\n\n${body}\n`;
}
export function proposed(name = 'release-checklist', body?: string): ProposedFile[] { return [{ path: 'SKILL.md', content: markdown(name, body) }]; }
export async function addSkill(root: string, id: string, body?: string, name = id.split('/').at(-1)!): Promise<void> {
  await atomicWrite(join(root, id, 'SKILL.md'), markdown(name, body));
}
export const fakeProfile: Profile = {
  selected: 'test/same', selectedLevel: 'off', level: 'off', fingerprint: 'same-profile',
  model: { id: 'same', name: 'Same test model', provider: 'test', api: 'openai-responses', baseUrl: 'http://127.0.0.1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384 },
  options: { transport: 'sse' },
};
export function fakeHost(replies: unknown[], evidenceIds = ['entry-1']): Host & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    sessionId: 'test-session', branchIds: new Set(evidenceIds), mode: 'tui', external: [], calls,
    isIdle: () => true, hasPending: () => false, profile: () => fakeProfile,
    complete: async (system, input, profile, signal) => {
      signal.throwIfAborted(); calls.push({ system, input, profile });
      const value = replies.shift();
      if (value instanceof Error) throw value;
      return { text: JSON.stringify(value), tokens: 100, cost: 0.01 };
    },
  };
}
export async function generousConfig(store: Store): Promise<void> {
  await atomicWrite(join(store.root, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, hourlyTokens: 1_000_000 }));
}
export async function evidence(learner: Learner, user = 'Create a reusable skill for this release checklist workflow.', used: string[] = []): Promise<void> {
  await learner.observe('test-session', 'entry-1', { id: 'obs-1', sessionId: 'test-session', entryId: 'entry-1', timestamp: Date.now(), user, assistant: 'Completed and verified the workflow.', used, failures: [] }, used);
}
