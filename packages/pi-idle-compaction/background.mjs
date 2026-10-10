// Optional same-process contracts, not imports or npm dependencies. The legacy
// key permits safe coexistence with pi-subagents while it is still installed.
export const REGISTRY_KEY = 'idle-compaction.background-work.v1';
export const LEGACY_REGISTRY_KEY = 'pi-subagents.background-work.v1';
const LIMITS = { providers: 100, items: 10000 };
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && !value.includes('\0');
const syncResult = value => {
  if (value && typeof value.then === 'function') {
    // Reject asynchronous providers without an unhandled rejection.
    Promise.resolve(value).catch(() => {});
    throw Error('Background provider must report synchronously');
  }
  return value;
};

export function registerBackgroundWorkProvider(provider) {
  validateProvider(provider.name, provider);
  const key = Symbol.for(REGISTRY_KEY);
  const registry = globalThis[key] ??= { version: 1, providers: new Map() };
  validateRegistry(registry);
  if (!registry.providers.has(provider.name) && registry.providers.size >= LIMITS.providers)
    throw Error('Background provider limit reached');
  registry.providers.set(provider.name, provider);
  return () => { if (registry.providers.get(provider.name) === provider) registry.providers.delete(provider.name); };
}
function validateRegistry(registry) {
  if (!fields(registry, ['version', 'providers']) || registry.version !== 1
    || !(registry.providers instanceof Map) || registry.providers.size > LIMITS.providers)
    throw Error('Background registry is unavailable or unsupported');
}
function validateProvider(name, provider) {
  if (!fields(provider, ['name', 'listActiveWork', 'reconcile', 'wakeChannels'])
    || !text(name, 128) || provider.name !== name || typeof provider.listActiveWork !== 'function'
    || (provider.reconcile !== undefined && typeof provider.reconcile !== 'function'))
    throw Error('Background provider is unavailable or unsupported');
  if (provider.wakeChannels !== undefined && (!Array.isArray(provider.wakeChannels)
    || provider.wakeChannels.length > 1000
    || provider.wakeChannels.some(channel => !text(channel, 256))
    || new Set(provider.wakeChannels).size !== provider.wakeChannels.length))
    throw Error('Background provider channels are invalid');
}
export function registeredWorkIdle(sessionIds, scope = globalThis, nowMs = Date.now()) {
  if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.some(id => !text(id, 4096)))
    throw Error('Invalid background session identity');
  for (const key of [REGISTRY_KEY, LEGACY_REGISTRY_KEY]) {
    const registry = scope[Symbol.for(key)];
    if (registry === undefined) continue; // No registered provider, not a missing required host.
    validateRegistry(registry);
    // Snapshot bounded entries so mutation during a provider callback cannot
    // extend Map iteration indefinitely. Recheck after asynchronous RPC admission.
    for (const [name, provider] of [...registry.providers]) {
      validateProvider(name, provider);
      const context = { sessionId: sessionIds[0], nowMs };
      syncResult(provider.reconcile?.(context));
      const items = syncResult(provider.listActiveWork(context));
      if (!Array.isArray(items) || items.length > LIMITS.items) throw Error('Invalid background work snapshot');
      const seen = new Set();
      let active = false;
      for (const item of items) {
        if (!fields(item, ['id', 'sessionId']) || !text(item.id, 256) || !text(item.sessionId, 4096))
          throw Error('Invalid background work item');
        const identity = `${item.sessionId}\0${item.id}`;
        if (seen.has(identity)) throw Error('Duplicate background work item');
        seen.add(identity);
        if (sessionIds.includes(item.sessionId)) active = true;
      }
      if (active) return false;
    }
  }
  return true;
}

const SUBAGENT_TOOLS = new Set(['subagent', 'subagents_enable', 'subagent_supervisor', 'bg_wait']);
export function createBackgroundGuard({ getTools, rpc, scope = globalThis }) {
  return async ctx => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionIds = [...new Set([sessionFile, sessionId].filter(Boolean))];
    const tools = getTools();
    if (!Array.isArray(tools) || tools.some(tool => !text(tool?.name, 256)))
      throw Error('Background capability inventory unavailable');
    if (!registeredWorkIdle(sessionIds, scope)) return null;
    // Only a PRESENT subagent runner requires its RPC owner. Absent package is
    // a supported standalone mode; present-but-broken remains fail-closed.
    if (tools.some(tool => SUBAGENT_TOOLS.has(tool.name))) {
      const ping = await rpc('ping');
      if ((ping?.session?.sessionFile ?? ping?.session?.sessionId) !== sessionIds[0]) return null;
      const status = await rpc('status');
      if (status?.isError || status?.fleet?.version !== 1 || status.fleet.totalActive !== 0
        || status.fleet.topLevelAsyncCapacity?.used !== 0) return null;
    }
    if (!registeredWorkIdle(sessionIds, scope)) return null;
    // Controller retains its admission-token interface. Snapshots are not an
    // exclusion lease and do not write any other extension's runtime state.
    return { release: async () => {} };
  };
}
