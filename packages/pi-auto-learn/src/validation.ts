import { posix } from 'node:path';
import type { Change, Config, Proposal, Review, SkillFile, SkillRecord, State } from './types.ts';
import { CORE, DAY } from './types.ts';
import { safeRelative } from './filesystem.ts';
import { frontmatter, dependencies } from './skill-library.ts';
import { containsSecret, riskyAddition, sensitiveRecord } from './privacy.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) throw new Error('Unknown or missing protocol fields');
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || containsSecret(value) || sensitiveRecord(value)) throw new Error('Invalid or sensitive protocol text');
  return value;
}
export function parseProposal(raw: string, config: Config): Proposal {
  if (Buffer.byteLength(raw) > 512_000) throw new Error('Proposal exceeds size limit');
  const p = object(JSON.parse(raw));
  keys(p, ['protocolVersion', 'decision', 'evidenceIds', 'changes']);
  if (p.protocolVersion !== 1 || !['noop', 'change'].includes(String(p.decision))) throw new Error('Unsupported protocol');
  if (!Array.isArray(p.evidenceIds) || p.evidenceIds.length > 64) throw new Error('Invalid evidence list');
  p.evidenceIds.forEach(x => text(x, 256));
  if (!Array.isArray(p.changes) || p.changes.length > config.maxChanges || (p.decision === 'noop' ? p.changes.length !== 0 : p.changes.length === 0)) throw new Error('Invalid changes list');
  let deletions = 0;
  for (const candidate of p.changes) {
    const c = object(candidate);
    const operation = c.operation;
    if (operation === 'create') keys(c, ['operation', 'skillId', 'baseHash', 'reason', 'files', 'workflow'], ['reopens', 'resolution']);
    else if (operation === 'update') keys(c, ['operation', 'skillId', 'baseHash', 'reason', 'files']);
    else if (operation === 'delete') keys(c, ['operation', 'skillId', 'baseHash', 'reason', 'retirement']);
    else throw new Error('Unknown operation');
    safeRelative(text(c.skillId, 256));
    text(c.reason);
    if (operation === 'create') {
      if (c.baseHash !== null || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(c.skillId))) throw new Error('Creation needs a natural directory name and null baseHash');
      text(c.workflow, 1024);
      if (c.reopens !== undefined || c.resolution !== undefined) { safeRelative(text(c.reopens, 256)); if (text(c.resolution, 2048).length < 40) throw new Error('Reopening requires a concrete retirement resolution'); }
    } else if (typeof c.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.baseHash)) throw new Error('Invalid base hash');
    if (operation === 'delete') {
      deletions++;
      const r = object(c.retirement);
      keys(r, ['reasonCode'], ['replacementSkillId']);
      if (!['unused', 'stale', 'bad', 'redundant', 'superseded'].includes(String(r.reasonCode))) throw new Error('Unknown retirement reason');
      if (r.replacementSkillId !== undefined) safeRelative(text(r.replacementSkillId, 256));
    } else {
      if (!Array.isArray(c.files) || c.files.length < 1 || c.files.length > 12) throw new Error('Invalid proposed files');
      const paths = new Set();
      let bytes = 0;
      for (const f of c.files) {
        const file = object(f);
        keys(file, ['path', 'content']);
        const path = safeRelative(text(file.path, 256));
        if (path !== 'SKILL.md' && !/^references\/[a-zA-Z0-9_/-]+\.(md|txt)$/.test(path)) throw new Error('Only SKILL.md and text references can be edited');
        if (paths.has(path)) throw new Error('Duplicate proposed file');
        paths.add(path);
        text(file.content, 131_072);
        bytes += Buffer.byteLength(String(file.content));
      }
      if (bytes > 262_144 || !paths.has('SKILL.md')) throw new Error('A bounded SKILL.md update is required');
    }
  }
  if (deletions > config.maxDeletes || new Set(p.changes.map(x => object(x).skillId)).size !== p.changes.length) throw new Error('Duplicate target or deletion limit exceeded');
  return p as unknown as Proposal;
}
export function parseReview(raw: string): Review {
  if (raw.length > 16_384) throw new Error('Oversized review');
  const p = object(JSON.parse(raw));
  keys(p, ['protocolVersion', 'verdict', 'reason']);
  if (p.protocolVersion !== 1 || !['approve', 'reject', 'pending'].includes(String(p.verdict))) throw new Error('Invalid review');
  text(p.reason);
  return p as unknown as Review;
}
export function composedFiles(record: SkillRecord | undefined, change: Exclude<Change, { operation: 'delete' }>): SkillFile[] {
  const map = new Map(record?.files.map(f => [f.path, f]) ?? []);
  for (const f of change.files) map.set(f.path, { path: f.path, content: Buffer.from(f.content), mode: map.get(f.path)?.mode ?? 0o600 });
  return [...map.values()];
}
function workflowMatches(a: string, b: string): boolean {
  const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const x = tokens(a); const y = tokens(b);
  const intersection = [...x].filter(t => y.has(t)).length;
  return intersection / Math.max(1, new Set([...x, ...y]).size) >= 0.8;
}
export function eligibleUnused(stats: State['skills'][string], now: number, config: Config): boolean {
  return now - Math.max(stats.firstSeen, stats.lastActivity, stats.lastUse ?? 0) >= config.unusedDays * DAY && stats.qualifyingRuns >= config.unusedRuns;
}
export function validateChange(change: Change, records: SkillRecord[], state: State, config: Config, now: number, externalNames: Set<string>): string | undefined {
  const old = records.find(r => r.id === change.skillId);
  if (state.pins.includes(change.skillId)) return 'Skill is pinned';
  if (change.operation !== 'create' && (!old || !old.hash || old.hash !== change.baseHash)) return 'Missing, unsafe, or changed target';
  if (change.operation === 'delete') {
    if (change.skillId === CORE) return 'The learning-policy recovery slot cannot be retired';
    if (old!.files.some(f => f.path !== 'SKILL.md' && /(^|\/)SKILL\.md$/.test(f.path))) return 'Nested independent skills cannot be deleted';
    if (dependencies(records, old!).length) return 'A retained skill references this skill';
    const replacement = change.retirement.replacementSkillId;
    if (replacement && (replacement === change.skillId || !records.some(r => r.id === replacement && r.valid))) return 'Replacement is not already validated and active';
    if (['redundant', 'superseded'].includes(change.retirement.reasonCode) && !replacement) return 'Redundant skills need an explicit verified replacement';
    if (change.retirement.reasonCode === 'unused') {
      const stats = state.skills[change.skillId];
      if (!stats || !eligibleUnused(stats, now, config)) return 'Insufficient meaningful inactivity observation';
      const reviews = stats.cleanupReviews.filter(t => t <= now);
      if (reviews.length < 2 || reviews.at(-1)! - reviews[0] < config.reviewGapDays * DAY) return 'Unused deletion requires repeated separated reviews';
    }
    return undefined;
  }
  if (change.operation === 'create' && old) return 'Creation target already exists';
  const markdown = change.files.find(f => f.path === 'SKILL.md')!.content;
  let meta;
  try { meta = frontmatter(markdown); } catch { return 'Invalid proposed frontmatter'; }
  if (change.operation === 'create' && (meta.name !== change.skillId || meta.name.startsWith('auto-learn-'))) return 'Use a matching natural name without an auto-learn prefix';
  if (change.operation === 'update' && old!.valid && meta.name !== old!.name) return 'Automatic renaming of an existing skill is not allowed';
  if (records.some(r => r.id !== change.skillId && r.name === meta.name) || (change.operation === 'create' && externalNames.has(meta.name))) return 'Skill name collision';
  if (change.operation === 'create') {
    if (state.suppressed.some(w => workflowMatches(w, change.workflow) || w === change.skillId)) return 'Explicitly suppressed workflow cannot be recreated';
    const retired = state.tombstones.find(t => t.skillId === change.skillId || t.name === meta.name || workflowMatches(t.workflow, change.workflow));
    if (retired && (change.reopens !== retired.skillId || !change.resolution)) return 'Previously discarded workflow needs explicit restore, re-enrollment, or supported resolution';
    if (change.reopens && !state.tombstones.some(t => t.skillId === change.reopens)) return 'Reopening refers to an unknown retirement';
  }
  for (const f of change.files) {
    const prior = old?.files.find(x => x.path === f.path);
    if (f.path !== 'SKILL.md' && prior && prior.content.toString() !== f.content) return 'Existing references are immutable; create a versioned reference and update its link';
    if (riskyAddition(prior?.content.toString() ?? '', f.content)) return 'High-impact or dangerous instruction additions require review';
  }
  const files = composedFiles(old, change);
  for (const f of change.files) {
    for (const match of f.content.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const link = match[1].split('#')[0];
      if (!link || /^https?:\/\//i.test(link)) continue;
      if (/^[a-z]+:/i.test(link) || link.startsWith('/') || link.includes('\\')) return 'Unsafe local reference';
      const target = posix.normalize(posix.join(posix.dirname(f.path), link));
      if (target.startsWith('../') || !files.some(x => x.path === target)) return 'Local reference escapes the skill or is missing';
    }
  }
  return undefined;
}
