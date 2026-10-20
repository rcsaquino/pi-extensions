import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { cleanup, scratch } from './helpers.ts';

test('the distributable entry loads without starting runtime resources', async t => {
  const root = await scratch('sub-loader-');
  t.after(() => cleanup(root));
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, '../index.ts')],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const loaded = result.extensions.find(extension => extension.path.endsWith('index.ts'));
  assert.ok(loaded);
  assert.ok(loaded.tools.has('subagent_dispatch'));
  assert.ok(loaded.tools.has('subagent_steer'));
  assert.ok(loaded.tools.has('subagent_tasks'));
  await assert.rejects(stat(join(root, 'temp_files')), { code: 'ENOENT' });
});
