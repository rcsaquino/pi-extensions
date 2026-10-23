/** Neutral, process-local contract consumed by pi-idle-compaction. */
export const BACKGROUND_WORK_PROVIDER = 'pi-subagents';
export const BACKGROUND_WORK_REGISTRY_KEY = 'idle-compaction.background-work.v1';

export interface BackgroundWorkItem {
  id: string;
  sessionId: string;
}

interface BackgroundWorkProvider {
  name: string;
  listActiveWork(context: { sessionId?: unknown }): BackgroundWorkItem[];
}

interface BackgroundWorkRegistry {
  version: 1;
  providers: Map<string, BackgroundWorkProvider>;
}

/**
 * Register a synchronous provider. The caller supplies a snapshot of active
 * runs for the requested session; no promises, timers, or foreign state files
 * are involved. Registration is replacement-safe: an old disposer cannot
 * remove a newer provider with the same name.
 */
export function registerSubagentsBackgroundWork(
  list: (sessionId: string) => BackgroundWorkItem[],
): () => void {
  const key = Symbol.for(BACKGROUND_WORK_REGISTRY_KEY);
  const holder = globalThis as unknown as Record<symbol, unknown>;
  let registry = holder[key] as BackgroundWorkRegistry | undefined;
  if (registry === undefined) {
    registry = { version: 1, providers: new Map() };
    holder[key] = registry;
  }
  if (!registry || registry.version !== 1 || !(registry.providers instanceof Map)) {
    throw new Error('Background-work registry is unavailable or unsupported');
  }
  const provider: BackgroundWorkProvider = {
    name: BACKGROUND_WORK_PROVIDER,
    listActiveWork: context => {
      const sessionId = typeof context?.sessionId === 'string' ? context.sessionId : '';
      return sessionId ? list(sessionId) : [];
    },
  };
  registry.providers.set(provider.name, provider);
  return () => {
    if (registry!.providers.get(provider.name) === provider) registry!.providers.delete(provider.name);
  };
}
