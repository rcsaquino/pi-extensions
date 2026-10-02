#!/usr/bin/env node
// Development-only: reuse Pi's installed public packages instead of duplicating runtimes.
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const globalRoot = execFileSync('npm', ['root', '-g'], { cwd: project, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(project, '.npm-cache') } }).trim();
const core = process.env.PI_HOST_PACKAGE_DIR || join(globalRoot, '@earendil-works', 'pi-coding-agent');
async function present(p) { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }
for (const [name, candidates] of [
  ['@earendil-works/pi-coding-agent', [core]],
  ['@earendil-works/pi-ai', [join(core, 'node_modules', '@earendil-works', 'pi-ai'), join(globalRoot, '@earendil-works', 'pi-ai')]],
  ['typebox', [join(core, 'node_modules', 'typebox'), join(globalRoot, 'typebox')]],
]) {
  const source = (await Promise.all(candidates.map(async p => await present(p) ? p : undefined))).find(Boolean);
  if (!source) throw new Error(`Host package not found: ${name}. Set PI_HOST_PACKAGE_DIR to the installed coding-agent directory.`);
  const target = join(project, 'node_modules', name);
  try { await fs.lstat(target); console.log(`Already available: ${name}`); continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.symlink(await fs.realpath(source), target, 'dir');
  console.log(`Linked host peer: ${name}`);
}
