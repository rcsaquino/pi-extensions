import * as fs from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseDocument } from 'yaml';
import type { SkillRecord } from './types.ts';
import { exists, noLinks, readFileSafe, tree, treeHash } from './filesystem.ts';

export function frontmatter(markdown: string, fallbackName?: string): { name: string; description: string; disableModelInvocation: boolean } {
  if (Buffer.byteLength(markdown) > 131_072) throw new Error('Skill Markdown exceeds size limit');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter');
  const doc = parseDocument(match[1], { uniqueKeys: true, customTags: [] });
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid or unsupported skill frontmatter');
  const value = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Frontmatter must be a mapping');
  const name = value.name ?? fallbackName;
  const description = value.description;
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Invalid skill name');
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) throw new Error('Invalid skill description');
  if ('disable-model-invocation' in value && typeof value['disable-model-invocation'] !== 'boolean') throw new Error('Invalid invocation flag');
  return { name, description, disableModelInvocation: value['disable-model-invocation'] === true };
}
export async function inventory(root: string): Promise<SkillRecord[]> {
  if (!await exists(root)) return [];
  await noLinks(root);
  if (await exists(join(root, 'SKILL.md'))) throw new Error('The managed container must not contain SKILL.md; move it into a named subdirectory');
  const records: SkillRecord[] = [];
  async function scan(dir: string): Promise<void> {
    await noLinks(dir);
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (!entry.isDirectory()) continue; // Symlinks are never enrollment.
      const path = join(dir, entry.name);
      if (!await exists(join(path, 'SKILL.md'))) { await scan(path); continue; }
      const id = relative(root, path).split('\\').join('/');
      try {
        const files = await tree(path);
        const markdown = (await readFileSafe(join(path, 'SKILL.md'), 131_072)).toString('utf8');
        let meta;
        let issue;
        try { meta = frontmatter(markdown, entry.name); } catch (e) { issue = (e as Error).message; }
        records.push({ id, markdown, files, hash: treeHash(files), name: meta?.name ?? entry.name, description: meta?.description ?? '', disableModelInvocation: meta?.disableModelInvocation ?? false, valid: Boolean(meta), issue });
      } catch {
        records.push({ id, markdown: '', files: [], hash: '', name: entry.name, description: '', disableModelInvocation: false, valid: false, issue: 'Unsafe or oversized skill tree; requires user review' });
      }
    }
  }
  await scan(root);
  return records;
}
export function dependencies(records: SkillRecord[], target: SkillRecord): string[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = escape(target.name);
  const id = escape(target.id);
  const patterns = [
    new RegExp(`${id}/(?:SKILL\\.md|references/)`, 'i'),
    new RegExp(`/skill:${name}(?![a-z0-9-])`, 'i'),
    new RegExp('`' + name + '`'),
    new RegExp(`\\b${name}\\s+skill\\b`, 'i'),
    new RegExp(`\\b(?:use|requires?|invoke|load|depends on)\\s+(?:the\\s+)?(?:skill\\s+)?${name}(?![a-z0-9-])`, 'i'),
  ];
  return records.filter(r => r.id !== target.id && r.files.some(f => !f.directory && /\.(md|txt)$/i.test(f.path) && patterns.some(p => p.test(f.content.toString('utf8'))))).map(r => r.id);
}
