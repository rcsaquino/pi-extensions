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
const requested = process.env.PI_HOST_PACKAGE_DIR ?? join(globalRoot, '@earendil-works/pi-coding-agent');
const host = await realpath(requested).catch(() => {
  throw new Error(`No Pi host package at ${requested}. Install one or set PI_HOST_PACKAGE_DIR.`);
});

// Resolve a peer the way the host itself would: nearest node_modules on the host's
// ancestor chain. One layout covers nested, hoisted and pnpm installs.
async function hostPeer(name) {
  for (let directory = host; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (await stat(join(candidate, 'package.json')).catch(() => false)) return realpath(candidate);
    if (dirname(directory) === directory) return undefined;
  }
}

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

const packages = [];
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(root, 'packages', entry.name);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  packages.push({ directory, peers: Object.keys(manifest.peerDependencies ?? {}), optional: manifest.peerDependenciesMeta ?? {} });
}

// Resolve once per distinct needed peer rather than once per package.
const resolved = new Map();
for (const { peers } of packages) {
  for (const name of peers) if (!resolved.has(name)) resolved.set(name, await hostPeer(name));
}

for (const { directory, peers, optional } of packages) {
  for (const name of peers) {
    const source = resolved.get(name);
    if (source) await linkMissingOrBroken(join(directory, 'node_modules', name), source);
    else if (!optional[name]?.optional) console.warn(`Missing peer ${name} for ${directory.slice(root.length + 1)}; install it in the host.`);
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
