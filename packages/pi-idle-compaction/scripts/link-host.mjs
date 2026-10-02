#!/usr/bin/env node
// Development only: use the current host peer without installing a second Pi.
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', cwd: project,
  env: { ...process.env, npm_config_cache: join(project, '.npm-cache') } }).trim();
const host = process.env.PI_HOST_PACKAGE_DIR || join(globalRoot, '@earendil-works', 'pi-coding-agent');
const source = await fs.realpath(host);
const target = join(project, 'node_modules', '@earendil-works', 'pi-coding-agent');
try {
  if (await fs.realpath(target) !== source) throw Error('Existing host peer differs; move it aside before linking');
  console.log('Current host peer already linked');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.symlink(source, target, 'dir');
  console.log('Linked current public Pi host peer');
}
