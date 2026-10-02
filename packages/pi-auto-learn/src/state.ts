import { join, resolve } from 'node:path';
import type { Change, Config, Revision, State } from './types.ts';
import { atomicWrite, exists, noLinks, readFileSafe, secureDirectory, within } from './filesystem.ts';
import { withLock, alive } from './lock.ts';
import { DEFAULT_CONFIG, parseConfig } from './config.ts';

export function initialState(): State {
  return { version: 1, paused: false, excluded: [], pins: [], suppressed: [], seen: [], evidence: [], skills: {}, tombstones: [], history: [], budget: [], active: {}, lastBatches: {}, lastCleanup: 0 };
}
export class Store {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async init(managedRoot: string): Promise<void> {
    if (within(this.root, managedRoot) || within(managedRoot, this.root)) throw new Error('Skill and state directories must not overlap');
    await secureDirectory(this.root);
    for (const p of ['history', 'proposals', 'backups', 'retired', 'transactions', 'locks']) await secureDirectory(join(this.root, p));
    await withLock(this.root, 'state', async () => {
      if (!await exists(join(this.root, 'state.json'))) await this.save(initialState());
      if (!await exists(join(this.root, 'config.json'))) await atomicWrite(join(this.root, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
      await this.read();
    });
  }
  async config(): Promise<Config> {
    return parseConfig(JSON.parse((await readFileSafe(join(this.root, 'config.json'), 16_384)).toString()));
  }
  async read(): Promise<State> {
    await noLinks(this.root);
    const s = JSON.parse((await readFileSafe(join(this.root, 'state.json'), 4 * 1024 * 1024)).toString()) as State;
    if (s.version !== 1 || !Array.isArray(s.history) || !Array.isArray(s.evidence) || !s.skills || !Array.isArray(s.pins) || !Array.isArray(s.excluded) || !Array.isArray(s.budget) || !s.active) throw new Error('Unsupported or corrupt auto-learn state; refusing to reset silently');
    return s;
  }
  private async save(s: State): Promise<void> {
    await atomicWrite(join(this.root, 'state.json'), JSON.stringify(s, null, 2) + '\n');
  }
  async change<T>(update: (s: State) => T | Promise<T>): Promise<T> {
    return withLock(this.root, 'state', async () => {
      const s = await this.read();
      const result = await update(s);
      s.seen = s.seen.slice(-5000);
      s.history = s.history.slice(-2000);
      await this.save(s);
      return result;
    });
  }
  async revision(r: Revision): Promise<void> {
    // Individual records survive bounded summary-history truncation.
    await atomicWrite(join(this.root, 'history', `${r.id}.json`), JSON.stringify(r, null, 2) + '\n');
    await this.change(s => { if (!s.history.some(x => x.id === r.id)) s.history.push(r); });
  }
  async proposedRevision(r: Revision, change: Change): Promise<void> {
    r.proposal = `proposals/${r.id}.json`;
    await atomicWrite(join(this.root, r.proposal), JSON.stringify({ protocolVersion: 1, change }, null, 2) + '\n');
    await this.revision(r);
  }
  async activity(session: string, active: boolean): Promise<void> {
    const key = `${process.pid}:${session}`;
    await this.change(s => { if (active) s.active[key] = { pid: process.pid, expires: Date.now() + 120_000 }; else delete s.active[key]; });
  }
  async commit<T>(session: string, work: () => Promise<T>): Promise<T> {
    // Foreground admission uses the same lease, closing the cross-process
    // check-to-write race without holding a lease during inference.
    return withLock(this.root, 'state', async () => { await this.guard(session); return work(); });
  }
  async guard(session: string): Promise<void> {
    const [s, config] = await Promise.all([this.read(), this.config()]);
    if (!config.enabled || s.paused || s.excluded.includes(session)) throw new Error('Learning is paused or this session is excluded');
    if (Object.values(s.active).some(x => x.expires > Date.now() && alive(x.pid))) throw new Error('Foreground activity has priority');
  }
}
