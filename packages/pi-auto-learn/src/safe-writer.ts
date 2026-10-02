import * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Change, Revision, SkillFile, Transaction } from './types.ts';
import { CORE } from './types.ts';
import { atomicWrite, exists, hash, noLinks, normalizedFiles, readFileSafe, removeOwnedTree, secureDirectory, syncDirectory, targetPath, tree, treeHash, writeTree } from './filesystem.ts';
import { withLock } from './lock.ts';
import { Store } from './state.ts';
import { composedFiles, parseProposal, validateChange } from './validation.ts';
import { inventory, frontmatter } from './skill-library.ts';
import { seedFiles } from './bootstrap.ts';

export class Writer {
  readonly root: string;
  readonly store: Store;
  readonly rename: (source: string, destination: string) => Promise<void>;
  constructor(root: string, store: Store, options: { rename?: (source: string, destination: string) => Promise<void> } = {}) { this.root = resolve(root); this.store = store; this.rename = options.rename ?? fs.rename; }
  private async journal(t: Transaction): Promise<void> {
    await atomicWrite(join(this.store.root, 'transactions', `${t.revision.id}.json`), JSON.stringify(t, null, 2) + '\n');
  }
  private async checkRoot(): Promise<void> {
    await secureDirectory(this.root);
    if (await exists(join(this.root, 'SKILL.md'))) throw new Error('Managed container cannot itself be a skill');
  }
  async ensureCore(session: string): Promise<boolean> {
    const [state, config] = await Promise.all([this.store.read(), this.store.config()]);
    if (state.paused || !config.enabled) return false;
    return withLock(this.store.root, 'writer', async () => {
      await this.store.guard(session);
      await this.checkRoot();
      const path = targetPath(this.root, CORE);
      let valid = false;
      if (await exists(path)) {
        try {
          const markdown = (await readFileSafe(join(path, 'SKILL.md'), 131_072)).toString();
          frontmatter(markdown);
          for (const match of markdown.matchAll(/\((references\/[^)\s]+)\)/g)) await readFileSafe(targetPath(path, match[1]), 65_536);
          valid = true;
        } catch { /* fallback is deterministic */ }
      }
      if (valid) return false;
      if (await exists(path)) {
        const files = await tree(path); // Unsafe symlinks require manual recovery, not destructive quarantine.
        // Preserve old references/scripts; a valid baseline replaces only policy documents.
        const seeded = new Map(files.map(f => [f.path, f]));
        for (const f of seedFiles()) seeded.set(f.path, f);
        await this.replace(CORE, files, [...seeded.values()], 'bootstrap', 'Recovered invalid learning policy from emergency seed', [], session);
      } else {
        await this.replace(CORE, undefined, seedFiles(), 'bootstrap', 'Created fresh learning policy from emergency seed', [], session);
      }
      return true;
    });
  }
  private revision(skillId: string, operation: Revision['operation'], reason: string, beforeHash: string | null, afterHash: string | null, evidenceIds: string[], profile?: string): Revision {
    return { id: randomUUID(), skillId, operation, timestamp: Date.now(), reason, beforeHash, afterHash, evidenceIds, profile, status: 'committed' };
  }
  private async replace(skillId: string, before: SkillFile[] | undefined, next: SkillFile[], operation: Revision['operation'], reason: string, evidenceIds: string[], session: string, profile?: string, automatic = true, commitGuard?: () => void): Promise<Revision> {
    const target = targetPath(this.root, skillId);
    const beforeHash = before ? treeHash(before) : null;
    const afterHash = treeHash(next);
    const r = this.revision(skillId, operation, reason, beforeHash, afterHash, evidenceIds, profile);
    const stage = join(this.root, `.auto-learn-stage-${r.id}`);
    await noLinks(target, true);
    const nextMarkdown = next.find(f => f.path === 'SKILL.md');
    if (!nextMarkdown) throw new Error('Replacement requires SKILL.md');
    await writeTree(stage, next);
    if (before) {
      r.archive = `backups/${r.id}/skill`;
      await writeTree(join(this.store.root, r.archive), before);
      await fs.chmod(join(this.store.root, r.archive), (await fs.stat(target)).mode & 0o777);
    }
    const t: Transaction = { version: 1, revision: r, operation, skillId, beforeHash, afterHash, activeMarkdownHash: hash(nextMarkdown.content), phase: 'prepared', staging: stage };
    await this.journal(t);
    try {
      const publish = async () => {
      if (automatic) await this.store.guard(session);
      commitGuard?.();
      await noLinks(target, true);
      if (before) {
        if (treeHash(await tree(target)) !== beforeHash) throw new Error('Target changed before commit');
        const oldMap = new Map(before.map(f => [f.path, f]));
        for (const file of normalizedFiles(next)) {
          if (file.path === 'SKILL.md') continue;
          if (file.directory) { await secureDirectory(targetPath(target, file.path)); continue; }
          const existing = oldMap.get(file.path);
          if (existing && existing.content.equals(file.content)) continue;
          if (existing && operation !== 'bootstrap' && operation !== 'rollback') throw new Error('Reference rewrites require a new filename');
          await atomicWrite(targetPath(target, file.path), file.content, file.mode);
        }
        if (automatic) await this.store.guard(session);
        // Every file, including scripts/assets, participates in the final optimistic guard.
        const oldMarkdown = before.find(f => f.path === 'SKILL.md');
        const beforeFinal = next.filter(f => f.path !== 'SKILL.md');
        if (oldMarkdown) beforeFinal.push(oldMarkdown);
        if (treeHash(await tree(target)) !== treeHash(beforeFinal)) throw new Error('Manual edit before final commit');
        commitGuard?.();
        await atomicWrite(join(target, 'SKILL.md'), nextMarkdown.content, nextMarkdown.mode);
      } else {
        if (await exists(target)) throw new Error('Creation target appeared during inference');
        await secureDirectory(dirname(target));
        commitGuard?.();
        await this.rename(stage, target);
        await syncDirectory(dirname(target));
      }
      if (treeHash(await tree(target)) !== afterHash) throw new Error('Committed tree differs from proposed revision');
      };
      if (automatic) await this.store.commit(session, publish); else await publish();
      t.phase = 'committed';
      await this.journal(t);
      await this.store.revision(r);
      await this.pruneBackups(skillId);
      return r;
    } finally {
      if (await exists(stage)) await removeOwnedTree(this.root, stage);
    }
  }
  async apply(change: Change, evidenceIds: string[], session: string, profile?: string, externalNames = new Set<string>(), commitGuard?: () => void): Promise<Revision> {
    return withLock(this.store.root, 'writer', async () => {
      await this.store.guard(session);
      await this.checkRoot();
      const state = await this.store.read();
      if (state.pins.includes(change.skillId)) throw new Error('Target is pinned');
      const records = await inventory(this.root);
      const old = records.find(r => r.id === change.skillId);
      const config = await this.store.config();
      parseProposal(JSON.stringify({ protocolVersion: 1, decision: 'change', evidenceIds, changes: [change] }), config);
      const problem = validateChange(change, records, state, config, Date.now(), externalNames);
      if (problem) throw new Error(problem);
      commitGuard?.();
      if (change.operation === 'create') {
        if (old || await exists(targetPath(this.root, change.skillId))) throw new Error('Target already exists');
        const result = await this.replace(change.skillId, undefined, composedFiles(undefined, change), 'create', change.reason, evidenceIds, session, profile, true, commitGuard);
        if (change.reopens) await this.store.change(s => { s.tombstones = s.tombstones.filter(t => t.skillId !== change.reopens); });
        return result;
      }
      if (!old || old.hash !== change.baseHash || !old.hash) throw new Error('Target changed since proposal');
      if (change.operation === 'delete') return this.retire(change, old.files, old.name, old.description, evidenceIds, session, profile, commitGuard);
      return this.replace(change.skillId, old.files, composedFiles(old, change), 'update', change.reason, evidenceIds, session, profile, true, commitGuard);
    });
  }
  private async retire(change: Extract<Change, { operation: 'delete' }>, files: SkillFile[], name: string, workflow: string, evidenceIds: string[], session: string, profile?: string, commitGuard?: () => void): Promise<Revision> {
    if (change.skillId === CORE || files.some(f => f.path !== 'SKILL.md' && /(^|\/)SKILL\.md$/.test(f.path))) throw new Error('Protected or nested skill cannot be retired');
    const target = targetPath(this.root, change.skillId);
    const beforeHash = treeHash(files);
    const r = this.revision(change.skillId, 'delete', change.reason, beforeHash, null, evidenceIds, profile);
    r.archive = `retired/${r.id}/skill`;
    const archive = join(this.store.root, r.archive);
    const stage = join(this.root, `.auto-learn-retire-${r.id}`);
    await secureDirectory(dirname(archive));
    const t: Transaction = { version: 1, revision: r, operation: 'delete', skillId: change.skillId, beforeHash, afterHash: null, phase: 'prepared', staging: stage };
    await this.journal(t);
    await this.store.guard(session);
    if (treeHash(await tree(target)) !== beforeHash) throw new Error('Manual edit prevents deletion');
    await noLinks(dirname(target));
    commitGuard?.();
    try { await this.store.commit(session, async () => { commitGuard?.(); await this.rename(target, archive); }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await writeTree(archive, files);
      await this.store.guard(session);
      if (treeHash(await tree(target)) !== beforeHash) throw new Error('Source changed during archive copy');
      commitGuard?.();
      await this.store.commit(session, async () => {
        commitGuard?.();
        await this.rename(target, stage);
        if (treeHash(await tree(stage)) !== beforeHash) {
          if (!await exists(target)) await fs.rename(stage, target);
          throw new Error('Concurrent edit prevents deletion');
        }
        await removeOwnedTree(this.root, stage);
      });
    }
    if (treeHash(await tree(archive)) !== beforeHash) {
      if (!await exists(target)) await fs.rename(archive, target);
      throw new Error('Archive integrity check failed');
    }
    await syncDirectory(dirname(target));
    await syncDirectory(dirname(archive));
    t.phase = 'committed';
    await this.journal(t);
    await this.store.revision(r);
    await this.store.change(s => {
      s.tombstones.push({ skillId: change.skillId, name, workflow: workflow || name, reason: change.reason, hash: beforeHash, timestamp: Date.now() });
      delete s.skills[change.skillId];
    });
    return r;
  }
  async recover(): Promise<void> {
    return withLock(this.store.root, 'writer', async () => {
      const files = await fs.readdir(join(this.store.root, 'transactions'));
      for (const file of files.filter(f => /^[a-f0-9-]+\.json$/.test(f))) {
        const t = JSON.parse((await readFileSafe(join(this.store.root, 'transactions', file), 64_000)).toString()) as Transaction;
        if (t.version !== 1 || t.phase === 'aborted') continue;
        const state = await this.store.read();
        if (t.phase === 'committed' && state.history.some(r => r.id === t.revision.id) && (t.operation !== 'delete' || state.tombstones.some(x => x.skillId === t.skillId))) continue;
        const target = targetPath(this.root, t.skillId);
        if (t.operation === 'delete') {
          const archive = t.revision.archive && targetPath(this.store.root, t.revision.archive);
          if (!await exists(target) && archive && await exists(archive) && treeHash(await tree(archive)) === t.beforeHash) {
            t.phase = 'committed';
            await this.store.revision(t.revision);
            let meta = { name: t.skillId.split('/').at(-1)!, description: t.skillId };
            try { meta = frontmatter((await readFileSafe(join(archive, 'SKILL.md'), 131_072)).toString()); } catch { /* invalid retired skills still recover */ }
            await this.store.change(s => {
              if (!s.tombstones.some(x => x.hash === t.beforeHash && x.skillId === t.skillId)) s.tombstones.push({ skillId: t.skillId, name: meta.name, workflow: meta.description, reason: t.revision.reason, hash: t.beforeHash!, timestamp: t.revision.timestamp });
              delete s.skills[t.skillId];
            });
          } else if (t.staging && await exists(t.staging)) {
            // Only a generated, local retirement staging path can be recovered.
            if (t.staging !== join(this.root, `.auto-learn-retire-${t.revision.id}`)) throw new Error('Invalid recovery staging path');
            if (!await exists(target)) await this.store.commit('recovery', () => fs.rename(t.staging!, target));
            t.phase = 'aborted';
          } else t.phase = 'aborted';
        } else if (await exists(target) && treeHash(await tree(target)) === t.afterHash) {
          t.phase = 'committed'; await this.store.revision(t.revision);
        } else {
          // An old active policy plus orphaned versioned references is safe. Do not overwrite manual edits.
          t.phase = 'aborted';
        }
        await this.journal(t);
        if (t.staging === join(this.root, `.auto-learn-stage-${t.revision.id}`) && await exists(t.staging)) await removeOwnedTree(this.root, t.staging);
      }
    });
  }
  async restore(revisionId: string, session: string): Promise<Revision> {
    if (!/^[a-f0-9-]{36}$/.test(revisionId)) throw new Error('Invalid retirement identifier');
    return withLock(this.store.root, 'writer', async () => {
      await this.checkRoot();
      const r = JSON.parse((await readFileSafe(join(this.store.root, 'history', `${revisionId}.json`), 64_000)).toString()) as Revision;
      if (r.operation !== 'delete' || !r.archive) throw new Error('Not a deleted-skill archive');
      const files = await tree(targetPath(this.store.root, r.archive));
      if (treeHash(files) !== r.beforeHash) throw new Error('Archive has changed');
      const result = await this.replace(r.skillId, undefined, files, 'restore', `Restored retirement ${revisionId}`, [], session, undefined, false);
      await this.store.change(s => { s.tombstones = s.tombstones.filter(t => t.skillId !== r.skillId); delete s.skills[r.skillId]; });
      return result;
    });
  }
  async rollback(skillId: string, revisionId: string | undefined, session: string): Promise<Revision> {
    return withLock(this.store.root, 'writer', async () => {
      await this.checkRoot();
      const state = await this.store.read();
      const r = state.history.filter(r => r.skillId === skillId && r.archive && r.operation !== 'delete' && (!revisionId || r.id === revisionId)).at(-1);
      if (!r?.archive) throw new Error('No recorded rollback snapshot');
      const files = await tree(targetPath(this.store.root, r.archive));
      if (treeHash(files) !== r.beforeHash) throw new Error('Rollback snapshot has changed');
      const current = await tree(targetPath(this.root, skillId));
      // Preserve current unused reference versions while restoring the old active instructions.
      const merged = new Map(current.map(f => [f.path, f]));
      for (const f of files) if (f.path === 'SKILL.md' || /^references\/.*\.(md|txt)$/.test(f.path)) merged.set(f.path, f);
      return this.replace(skillId, current, [...merged.values()], 'rollback', `Rolled back to snapshot of ${r.id}`, [], session, undefined, false);
    });
  }
  private async pruneBackups(skillId: string): Promise<void> {
    const keep = (await this.store.config()).backupRevisions;
    const entries = (await this.store.read()).history.filter(r => r.skillId === skillId && r.status === 'committed' && r.archive?.startsWith('backups/'));
    for (const old of entries.slice(0, Math.max(0, entries.length - keep))) {
      const p = targetPath(this.store.root, old.archive!);
      if (await exists(p)) {
        if (treeHash(await tree(p)) !== old.beforeHash) continue;
        await removeOwnedTree(this.store.root, p);
      }
      const updated = { ...old, archive: undefined };
      await atomicWrite(join(this.store.root, 'history', `${old.id}.json`), JSON.stringify(updated, null, 2) + '\n');
      await this.store.change(s => { const entry = s.history.find(r => r.id === old.id); if (entry) delete entry.archive; });
    }
  }
  async purge(revisionId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(revisionId)) throw new Error('Invalid archive identifier');
    await withLock(this.store.root, 'writer', async () => {
      const r = JSON.parse((await readFileSafe(join(this.store.root, 'history', `${revisionId}.json`), 64_000)).toString()) as Revision;
      if (r.operation !== 'delete' || r.archive !== `retired/${r.id}/skill`) throw new Error('Not a retirement archive');
      const path = targetPath(this.store.root, r.archive);
      if (treeHash(await tree(path)) !== r.beforeHash) throw new Error('Archive has changed');
      await removeOwnedTree(this.store.root, path);
    });
  }
}
