import { processAlive, type RunMeta } from './store.ts';

// Neutral process-local contract shared with pi-idle-compaction. The packages
// stay standalone; neither imports the other's code.
export const REGISTRY_KEY = 'idle-compaction.background-work.v1';
export const PROVIDER_NAME = 'pi-background-task';

export interface ActiveWorkProvider {
  name: string;
  scope: 'global';
  listActiveWork: () => Array<{ id: string; sessionId: string }>;
}

interface Registry {
  version: 1;
  providers: Map<string, ActiveWorkProvider>;
}

function isRegistry(value: unknown): value is Registry {
  if (!value || typeof value !== 'object') return false;
  const registry = value as Partial<Registry>;
  return registry.version === 1 && registry.providers instanceof Map;
}

export function createActiveWorkProvider(
  live: Map<string, RunMeta>,
  alive: (pid: number, marker?: string) => boolean = processAlive,
): ActiveWorkProvider {
  return {
    name: PROVIDER_NAME,
    scope: 'global',
    listActiveWork: () => [...live.values()]
      .filter(meta => meta.status === 'running' && alive(meta.pid, meta.childSessionId))
      .map(meta => ({ id: meta.id, sessionId: meta.childSessionId })),
  };
}

export function registerActiveWorkProvider(
  provider: ActiveWorkProvider,
  root: Record<PropertyKey, unknown> = globalThis,
): () => void {
  const key = Symbol.for(REGISTRY_KEY);
  let registry = root[key];
  if (registry === undefined) {
    registry = { version: 1, providers: new Map() };
    root[key] = registry;
  }
  if (!isRegistry(registry)) return () => {};
  registry.providers.set(provider.name, provider);
  return () => {
    if (registry.providers.get(provider.name) === provider) registry.providers.delete(provider.name);
  };
}
