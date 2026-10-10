import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.JITI_FS_CACHE = 'false';
process.env.JITI_TRY_NATIVE = 'false';
const root = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = process.env.IDLE_COMPACTION_TEST_RUNTIME_DIR || root;

// Test-only gate for the declared peer ranges, not a pin to the validation baseline.
const hostPeerRange = '^0.99.2 || ^1.0.0';
function isDeclaredHostVersion(version) {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!parts) return false; // Prereleases are not included by the declared ranges.
  return parts[1] === '1' || (parts[1] === '0' && parts[2] === '99' && Number(parts[3]) >= 2);
}

test('loader host gate covers the declared stable peer ranges', async () => {
  const manifest = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], hostPeerRange,
    'update the test-only gate when declared host support changes');
  for (const version of ['0.99.2', '0.99.3', '0.99.12', '1.0.0', '1.0.9', '1.1.0', '1.12.0', '1.1.0+build.1'])
    assert.equal(isDeclaredHostVersion(version), true, `declared host ${version}`);
  for (const version of ['0.98.9', '0.99.1', '0.100.0', '2.0.0', '1.1.0-rc.1', '1.01.0', '1.1', 'invalid'])
    assert.equal(isDeclaredHostVersion(version), false, `undeclared host ${version}`);
});

test('current Pi loads an isolated standalone copy with NO node_modules or subagent package', async () => {
  const sandbox = await mkdtemp(join(root, '.loader-test-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = join(sandbox, 'agent');
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw Error('Network forbidden in loader acceptance'); };
  try {
    const { DefaultResourceLoader, SettingsManager, VERSION } = await import('@earendil-works/pi-coding-agent');
    assert.ok(isDeclaredHostVersion(VERSION), `Pi ${VERSION} must satisfy the declared stable host ranges ${hostPeerRange}`);
    const agentDir = join(sandbox, 'agent'), cwd = join(sandbox, 'cwd');
    const installDir = join(agentDir, 'extensions', 'pi-idle-compaction');
    await mkdir(installDir, { recursive: true }); await mkdir(cwd);
    for (const name of ['index.ts', 'controller.mjs', 'background.mjs', 'package.json'])
      await copyFile(join(runtimeRoot, name), join(installDir, name));
    const manifest = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'pi-idle-compaction');
    assert.deepEqual(manifest.dependencies, {});
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: SettingsManager.inMemory(),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { extensions, errors, runtime } = loader.getExtensions();
    assert.deepEqual(errors, []);
    assert.equal(extensions.length, 1);
    const [extension] = extensions;
    assert.equal(extension.path, join(installDir, 'index.ts'));
    assert.deepEqual([...extension.commands.keys()], ['idle-compact']);
    assert.equal(extension.tools.size, 0);
    assert.equal(runtime.pendingProviderRegistrations.length, 0);
    const notices = [], ctx = { ui: { notify: message => notices.push(message) } };
    await extension.commands.get('idle-compact').handler('status', ctx);
    assert.match(notices.pop(), /^Enabled: 60 minutes idle, at least 100000 tokens context/);
    await extension.commands.get('idle-compact').handler('off', ctx);
    assert.match(notices.pop(), /^Disabled:/);
    for (const handler of extension.handlers.get('session_shutdown')) await handler({}, ctx);
    runtime.invalidate();
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(sandbox, { recursive: true, force: true });
  }
});
