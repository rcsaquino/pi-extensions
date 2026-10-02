import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverAndLoadExtensions, InteractiveMode } from '@earendil-works/pi-coding-agent';
import entrypoint from '../index.ts';
import implementation from '../src/index.ts';

const project = resolve(import.meta.dirname, '..');

test('package declares and ships the root entry point', async () => {
  const manifest = JSON.parse(await fs.readFile(join(project, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.pi.extensions, ['./index.ts']);
  assert.ok(manifest.files.includes('index.ts'));
  assert.ok(manifest.files.includes('src'));
});

test('root entry point forwards the implementation without duplicating it', () => {
  assert.equal(entrypoint, implementation);
});

test('Pi discovers one root entry and labels it pi-auto-learn, without session startup', async t => {
  const tmp = join(project, '.test-tmp');
  await fs.mkdir(tmp, { recursive: true });
  const base = await fs.mkdtemp(join(tmp, 'entrypoint-'));
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  const agentDir = join(base, 'agent');
  const extensionsDir = join(agentDir, 'extensions');
  await fs.mkdir(extensionsDir, { recursive: true });
  const extensionDir = join(extensionsDir, 'pi-auto-learn');
  await fs.symlink(project, extensionDir, 'dir');
  const result = await discoverAndLoadExtensions([], base, agentDir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0]!.path, join(extensionDir, 'index.ts'));
  assert.ok(result.extensions[0]!.commands.has('auto-learn'));
  assert.notEqual(result.extensions[0]!.commands.get('auto-learn')!.description, 'Auto-learn compatibility status');
  assert.ok(result.extensions[0]!.tools.has('auto_learn_status'));
  assert.ok(result.extensions[0]!.flags.has('auto-learn-disabled'));
  assert.ok(result.extensions[0]!.handlers.has('session_start'));
  assert.ok(result.extensions[0]!.handlers.has('agent_settled'));
  // Use Pi's actual compact-label routine without creating a terminal/session.
  const ui = InteractiveMode.prototype as unknown as {
    getCompactExtensionLabels(extensions: unknown[]): string[];
  };
  assert.deepEqual(ui.getCompactExtensionLabels(result.extensions), ['pi-auto-learn']);
  await assert.rejects(fs.access(join(agentDir, 'auto-learn')));
  await assert.rejects(fs.access(join(agentDir, 'skills')));
});
