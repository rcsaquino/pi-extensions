import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelection } from '../src/model.ts';
import { parseConfig } from '../src/registry.ts';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

const models = [
  { id: 'main', provider: 'p1' },
  { id: 'other', provider: 'p1' },
  { id: 'shared', provider: 'p1' },
  { id: 'shared', provider: 'p2' },
  { id: 'qualified', provider: 'p2' },
];

function registry(options: { authenticated?: string[] } = {}): ModelRegistry {
  const authenticated = new Set(options.authenticated ?? ['p1', 'p2']);
  return {
    getAll: () => models,
    find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
    hasConfiguredAuth: (model: { provider: string }) => authenticated.has(model.provider),
  } as unknown as ModelRegistry;
}

const defaults = parseConfig(undefined);

test('the main model and thinking level are inherited by default', () => {
  const selection = resolveSelection(registry(), { id: 'main', provider: 'p1' }, 'high', defaults);
  assert.deepEqual(selection, { provider: 'p1', model: 'main', thinking: 'high', providerFlag: 'p1' });
});

test('a qualified override is passed without --provider', () => {
  const selection = resolveSelection(registry(), { id: 'main', provider: 'p1' }, 'low',
    parseConfig({ model: 'p2/qualified' }));
  assert.deepEqual(selection, { provider: 'p2', model: 'qualified', thinking: 'low' });
});

test('a unique bare override keeps its provider flag', () => {
  const selection = resolveSelection(registry(), { id: 'main', provider: 'p1' }, 'off',
    parseConfig({ model: 'other' }));
  assert.equal(selection.provider, 'p1');
  assert.equal(selection.providerFlag, 'p1');
});

test('an ambiguous bare id is a validation error', () => {
  assert.throws(() => resolveSelection(registry(), { id: 'main', provider: 'p1' }, 'off',
    parseConfig({ model: 'shared' })), /Ambiguous model/);
});

test('a unique bare id outside the main provider still resolves', () => {
  const selection = resolveSelection(registry(), { id: 'main', provider: 'p1' }, 'off',
    parseConfig({ model: 'qualified' }));
  assert.equal(selection.provider, 'p2');
});

test('unknown models and unauthenticated providers are rejected before dispatch', () => {
  assert.throws(() => resolveSelection(registry(), { id: 'main', provider: 'p1' }, 'off',
    parseConfig({ model: 'missing' })), /Unknown model/);
  assert.throws(() => resolveSelection(registry({ authenticated: ['p2'] }), { id: 'main', provider: 'p1' }, 'off',
    defaults), /No credentials configured/);
});

test('thinking comes from agent.json before the session level', () => {
  const selection = resolveSelection(registry(), { id: 'main', provider: 'p1' }, 'high',
    parseConfig({ thinking: 'max' }));
  assert.equal(selection.thinking, 'max');
});
