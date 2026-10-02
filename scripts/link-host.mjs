#!/usr/bin/env node
// Development-only host linking. No dependency source files or lockfiles are edited.
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, stat, symlink, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmEnv = { ...process.env, npm_config_cache: join(root, '.npm-cache') };
// `npm --prefix <repo> run link-host` exports its local prefix to child processes.
// Do not mistake that project prefix for the real global host installation.
delete npmEnv.npm_config_prefix;
delete npmEnv.NPM_CONFIG_PREFIX;
const globalRoot = execFileSync('npm', ['root', '-g'], {
  cwd: root, encoding: 'utf8', env: npmEnv,
}).trim();
const host = await realpath(process.env.PI_HOST_PACKAGE_DIR ?? join(globalRoot, '@earendil-works/pi-coding-agent'));
const hostPackages = new Map([
  ['@earendil-works/pi-coding-agent', host],
  ['@earendil-works/pi-ai', join(host, 'node_modules/@earendil-works/pi-ai')],
  ['@earendil-works/pi-agent-core', join(host, 'node_modules/@earendil-works/pi-agent-core')],
  ['@earendil-works/pi-tui', join(host, 'node_modules/@earendil-works/pi-tui')],
  ['typebox', join(host, 'node_modules/typebox')],
]);

async function linkMissingOrBroken(target, source) {
  await stat(source); // Validate before changing any existing link.
  try {
    await stat(target);
    return; // Never replace a working dependency or executable.
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    const entry = await lstat(target);
    if (!entry.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink: ${target}`);
    await unlink(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target);
  console.log(`Linked: ${target.slice(root.length + 1)}`);
}

for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(root, 'packages', entry.name);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    const source = hostPackages.get(name);
    if (source) await linkMissingOrBroken(join(directory, 'node_modules', name), await realpath(source));
  }
  // Some existing development-only dependency trees had a compiler but no npm bin link.
  const compiler = join(directory, 'node_modules/typescript/bin/tsc');
  try {
    await stat(compiler);
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  await linkMissingOrBroken(join(directory, 'node_modules/.bin/tsc'), compiler);
}
