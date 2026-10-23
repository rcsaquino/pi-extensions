import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentDir, discover, parseConfig } from '../src/registry.ts';
import { renderSubagentsSection } from '../src/context.ts';
import { scratch, cleanup } from './helpers.ts';

test('absent agent.json yields the documented minimal defaults', () => {
  assert.deepEqual(parseConfig(undefined), {
    extensions: [], skills: [], excludeTools: [], timeoutSeconds: 14400, maxTurns: 300,
  });
});

test('unknown keys are hard errors, not ignored', () => {
  assert.throws(() => parseConfig({ tools: ['read'] }), /unknown key "tools"/);
});

test('extensions accept existing absolute paths and builtin names only', async t => {
  const root = await scratch('sub-ext-');
  t.after(() => cleanup(root));
  const extension = join(root, 'ext.ts');
  await writeFile(extension, 'export default () => {};\n');
  assert.deepEqual(parseConfig({ extensions: [extension, 'builtin:mcp'] }).extensions, [extension, 'builtin:mcp']);
  assert.throws(() => parseConfig({ extensions: ['relative.ts'] }), /absolute path or builtin/);
  assert.throws(() => parseConfig({ extensions: [join(root, 'absent.ts')] }), /does not exist/);
  assert.throws(() => parseConfig({ extensions: 'mcp' }), /must be an array/);
});

test('skills must be existing absolute directories and excludeTools is limited to builtins', async t => {
  const root = await scratch('sub-skill-');
  t.after(() => cleanup(root));
  await mkdir(join(root, 'skills'), { recursive: true });
  assert.deepEqual(parseConfig({ skills: [join(root, 'skills')] }).skills, [join(root, 'skills')]);
  assert.throws(() => parseConfig({ skills: ['skills'] }), /absolute path/);
  assert.throws(() => parseConfig({ skills: [join(root, 'absent')] }), /does not exist/);
  assert.deepEqual(parseConfig({ excludeTools: ['bash', 'write'] }).excludeTools, ['bash', 'write']);
  assert.throws(() => parseConfig({ excludeTools: ['web_search'] }), /read, bash, edit, write/);
});

test('model overrides reject patterns and :thinking suffixes', () => {
  assert.equal(parseConfig({ model: 'openai/gpt-5' }).model, 'openai/gpt-5');
  assert.throws(() => parseConfig({ model: 'openai/*' }), /without patterns/);
  assert.throws(() => parseConfig({ model: 'openai/gpt-5:high' }), /:thinking suffix/);
  assert.throws(() => parseConfig({ model: '' }), /non-empty/);
});

test('thinking and numeric bounds are validated', () => {
  assert.equal(parseConfig({ thinking: 'xhigh' }).thinking, 'xhigh');
  assert.throws(() => parseConfig({ thinking: 'extreme' }), /must be one of/);
  assert.equal(parseConfig({ timeoutSeconds: 60, maxTurns: 1 }).timeoutSeconds, 60);
  assert.throws(() => parseConfig({ timeoutSeconds: 59 }), /60 to 604800/);
  assert.throws(() => parseConfig({ maxTurns: 1001 }), /1 to 1000/);
  assert.throws(() => parseConfig({ maxTurns: 1.5 }), /integer/);
});

test('discovery lists only directories with a regular prompt.md and warns otherwise', async t => {
  const root = await scratch('sub-registry-');
  t.after(() => cleanup(root));
  const make = async (name: string, prompt?: string) => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    if (prompt !== undefined) await writeFile(join(dir, 'prompt.md'), prompt);
  };
  await make('alpha', 'prompt');
  await make('beta_2', 'prompt');
  await make('missing');
  await make('BadName', 'prompt');
  await make('.hidden', 'prompt');
  await make('runs', 'prompt');

  const result = discover(root);
  assert.deepEqual(result.definitions.map(definition => definition.name), ['alpha', 'beta_2']);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some(warning => warning.startsWith('missing:')));
  assert.ok(result.warnings.some(warning => warning.startsWith('BadName:')));
});

test('an empty or absent root is valid', async t => {
  const root = await scratch('sub-empty-');
  t.after(() => cleanup(root));
  assert.deepEqual(discover(join(root, 'absent')), { definitions: [], warnings: [] });
  await mkdir(root, { recursive: true });
  assert.deepEqual(discover(root), { definitions: [], warnings: [] });
});

test('oversized prompt.md is not a definition', async t => {
  const root = await scratch('sub-big-');
  t.after(() => cleanup(root));
  await mkdir(join(root, 'big'), { recursive: true });
  await writeFile(join(root, 'big', 'prompt.md'), 'x'.repeat(16 * 1024 + 1));
  assert.equal(discover(root).definitions.length, 0);
  assert.match(discover(root).warnings[0]!, /1 byte to 16 KiB/);
});

test('description.md supplies a one-line summary and stays optional', async t => {
  const root = await scratch('sub-desc-');
  t.after(() => cleanup(root));
  const make = async (name: string, description?: string) => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'prompt.md'), 'prompt');
    if (description !== undefined) await writeFile(join(dir, 'description.md'), description);
  };
  await make('alpha', 'First line.\nSecond   line.');
  await make('beta');
  await make('gamma', '   \n ');

  const { definitions } = discover(root);
  assert.deepEqual(definitions.map(definition => definition.name), ['alpha', 'beta', 'gamma']);
  assert.equal(definitions[0]?.description, 'First line. Second line.');
  assert.equal(definitions[1]?.description, undefined);
  assert.equal(definitions[2]?.description, undefined);
  assert.equal(renderSubagentsSection(definitions), '- alpha: First line. Second line.');
});

test('agent directory normalizes ~ and rejects relative PI_CODING_AGENT_DIR values', () => {
  assert.equal(agentDir({}), join(homedir(), '.pi', 'agent'));
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: '~/custom-agent' }), join(homedir(), 'custom-agent'));
  assert.throws(() => agentDir({ PI_CODING_AGENT_DIR: 'relative/agent' }), /absolute path/);
});

test('long descriptions are capped inside the 400-code-point budget', async t => {
  const root = await scratch('sub-desc-long-');
  t.after(() => cleanup(root));
  const dir = join(root, 'wordy');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'prompt.md'), 'prompt');
  await writeFile(join(dir, 'description.md'), 'word '.repeat(200));
  const description = discover(root).definitions[0]?.description ?? '';
  assert.ok(description.length <= 400);
  assert.ok(description.endsWith('…'));
  assert.doesNotMatch(description, /wor…$/);
});

test('renderSubagentsSection lists described definitions in order', () => {
  const body = renderSubagentsSection([
    { name: 'one', dir: '/a', promptPath: '/a/p', description: 'First.' },
    { name: 'two', dir: '/b', promptPath: '/b/p' },
    { name: 'three', dir: '/c', promptPath: '/c/p', description: 'Third.' },
  ]);
  assert.equal(body, '- one: First.\n- three: Third.');
});
