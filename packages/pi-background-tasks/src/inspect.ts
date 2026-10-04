import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { plainArgs } from './effects.ts';
import { Directory } from './files.ts';

export const inspectionSchema = Type.Object({
  action: Type.Union([Type.Literal('ls'), Type.Literal('find'), Type.Literal('grep')]),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  name_contains: Type.Optional(Type.String({ maxLength: 200, description: 'Literal filename substring, not a glob or shell expression.' })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Required for grep. Literal substring only.' })),
  max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 12 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
}, { additionalProperties: false });
export function validateInspection(args: Record<string, unknown>): void {
  if (!plainArgs(args) || Object.keys(args).some(k => !['action', 'path', 'name_contains', 'text', 'max_depth', 'limit'].includes(k)) ||
    !['ls', 'find', 'grep'].includes(args.action as string) || typeof args.path !== 'string' || !args.path.trim() ||
    args.path.length > 4096 || args.path.includes('\0') ||
    (args.name_contains !== undefined && (typeof args.name_contains !== 'string' || args.name_contains.length > 200)) ||
    (args.text !== undefined && (typeof args.text !== 'string' || !args.text.length || args.text.length > 200)) ||
    (args.action === 'grep' && !args.text) ||
    (args.max_depth !== undefined && (!Number.isInteger(args.max_depth) || Number(args.max_depth) < 0 || Number(args.max_depth) > 12)) ||
    (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 500))) throw new Error('Invalid filesystem inspection arguments.');
}
/** Bounded Node filesystem reads only. No shell, executable acquisition, regex or output file. */
export async function inspectFilesystem(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  validateInspection(args); signal?.throwIfAborted();
  const root = resolve(cwd, args.path as string);
  const anchor = await Directory.open(dirname(root));
  const rootName = root === '/' ? '.' : basename(root);
  const limit = Number(args.limit ?? 100), depthLimit = args.action === 'ls' ? 0 : Number(args.max_depth ?? 4);
  const results: { path: string; kind: string; line?: number; text?: string }[] = [];
  let visited = 0, skipped = 0, clipped = false, bytes = 0;
  const add = (item: typeof results[number]) => {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (results.length >= limit || bytes + size > 24000) { clipped = true; return; }
    bytes += size; results.push(item);
  };
  const walk = async (parent: Directory, name: string, path: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (clipped || ++visited > 10000) { clipped = true; return; }
    await parent.check();
    const stat = name === '.' ? await parent.handle.stat() : await lstat(parent.entry(name)).catch(() => undefined);
    if (path === root && stat?.isSymbolicLink()) throw new Error('Filesystem inspection does not follow symlinks.');
    if (!stat || stat.isSymbolicLink()) { skipped++; return; }
    const matches = !args.name_contains || basename(path).includes(args.name_contains as string);
    if (stat.isDirectory()) {
      if (path !== root && matches && args.action !== 'grep') add({ path, kind: 'directory' });
      if (depth > depthLimit) return;
      const directory = await parent.child(name);
      try {
        const current = await directory.handle.stat(); if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('Inspection directory identity changed.');
        const dir = await opendir(`/proc/self/fd/${directory.handle.fd}/.`);
        for await (const entry of dir) { if (clipped) break; await walk(directory, entry.name, join(path, entry.name), depth + 1); }
        await directory.check();
      } finally { await directory.close(); }
    } else if (stat.isFile() && matches) {
      if (args.action !== 'grep') { add({ path, kind: 'file' }); return; }
      const entry = await parent.readEntry(name, 1024 * 1024).catch(() => null);
      if (!entry || entry.stat.ino !== stat.ino || entry.stat.dev !== stat.dev || entry.data.includes(0)) { skipped++; return; }
      for (const [i, text] of entry.data.toString('utf8').split('\n').entries()) {
        signal?.throwIfAborted(); if (clipped) break;
        if (text.includes(args.text as string)) add({ path, kind: 'match', line: i + 1, text: text.slice(0, 400) });
      }
    } else skipped++;
  };
  try { await walk(anchor, rootName, root, 0); } finally { await anchor.close(); }
  return { results, truncated: clipped, visited, skipped, limits: { entries: 10000, outputBytes: 24000, fileBytes: 1024 * 1024 } };
}
export function registerInspection(pi: ExtensionAPI): void {
  pi.registerTool({ name: 'background_fs_inspect', label: 'Filesystem inspection',
    description: 'Read-only ls/find/grep equivalents without a shell. Uses literal filename/content substrings; never executes commands, follows symlinks, installs helpers or writes output files. Bounded, not a full recursive index. Paths are literal and relative to the host cwd. Subject to ordinary permission hooks.',
    parameters: inspectionSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    execute: async (_id, args, signal, _update, ctx) => {
      const result = await inspectFilesystem(args, ctx.cwd, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
