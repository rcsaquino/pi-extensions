import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createActiveWorkProvider, PROVIDER_NAME, registerActiveWorkProvider, REGISTRY_KEY,
} from "../src/background-work.ts";
import type { RunMeta } from "../src/store.ts";

function meta(id: string, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    title: id,
    parentSessionId: "parent",
    childSessionId: id,
    pid: 1,
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "running",
    ...overrides,
  };
}

test("reports only running runs whose process identity is alive", () => {
  const live = new Map<string, RunMeta>([
    ["parent/a", meta("a", { pid: 11 })],
    ["parent/b", meta("b", { pid: 22, status: "done" })],
    ["parent/c", meta("c", { pid: 33 })],
  ]);
  const provider = createActiveWorkProvider(live, pid => pid === 11);
  assert.equal(provider.name, PROVIDER_NAME);
  assert.equal(provider.scope, "global");
  assert.deepEqual(provider.listActiveWork(), [{ id: "a", sessionId: "a" }]);
});

test("a dead running pid and a settled run are excluded", () => {
  const live = new Map<string, RunMeta>([
    ["parent/a", meta("a", { pid: 11 })],
    ["parent/b", meta("b", { pid: 22, status: "done" })],
  ]);
  const provider = createActiveWorkProvider(live, () => false);
  assert.deepEqual(provider.listActiveWork(), []);
});

test("registration replaces the previous provider and disposes only itself", () => {
  const root: Record<PropertyKey, unknown> = {};
  const key = Symbol.for(REGISTRY_KEY);
  const first = createActiveWorkProvider(new Map(), () => false);
  const second = createActiveWorkProvider(new Map(), () => false);
  const disposeFirst = registerActiveWorkProvider(first, root);
  const registry = root[key] as { providers: Map<string, unknown> };
  assert.equal(registry.providers.get(PROVIDER_NAME), first);
  const disposeSecond = registerActiveWorkProvider(second, root);
  disposeFirst();
  assert.equal(registry.providers.get(PROVIDER_NAME), second, "the old disposer must not remove a replacement");
  disposeSecond();
  assert.equal(registry.providers.get(PROVIDER_NAME), undefined);
  disposeSecond();
});

test("a malformed registry returns a no-op disposer", () => {
  const key = Symbol.for(REGISTRY_KEY);
  for (const registry of [
    { version: 2, providers: new Map() },
    { version: 1, providers: [] },
  ]) {
    const root: Record<PropertyKey, unknown> = { [key]: registry };
    const dispose = registerActiveWorkProvider(createActiveWorkProvider(new Map(), () => false), root);
    assert.doesNotThrow(dispose);
    assert.equal(root[key], registry, "the malformed registry must not be replaced");
  }
});
