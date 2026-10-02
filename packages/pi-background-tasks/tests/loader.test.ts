import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { scratch } from './helpers.ts';

test('actual Pi file loader accepts the distributable entry point, without starting runtime resources', async t => {
  const root = await scratch('bg-loader-test-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent'); await fs.mkdir(agentDir);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, '../index.ts')],
  });
  await loader.reload();
  const result = loader.getExtensions(); assert.deepEqual(result.errors, []);
  const loaded = result.extensions.find(e => e.path.endsWith('index.ts'))!;
  assert.ok(loaded); assert.ok(loaded.commands.has('bg')); assert.ok(loaded.tools.has('background_dispatch')); assert.ok(loaded.tools.has('background_tasks'));
  await assert.rejects(fs.stat(join(root, 'temp_files')), { code: 'ENOENT' });
});
