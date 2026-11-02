// Optional same-process contracts, not imports or npm dependencies. The legacy
// key permits safe coexistence with the retired pi-subagents package.
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

// The retired pi-subagents exposed these names and a provider, never RPC.
const CURRENT_SUBAGENT_TOOLS = new Set(['subagent_dispatch', 'subagent_steer', 'subagent_tasks']);
const SUBAGENTS_PROVIDER = 'pi-subagents';
function hasRegisteredProvider(scope, name) {
  for (const key of [REGISTRY_KEY, LEGACY_REGISTRY_KEY]) {
    const registry = scope[Symbol.for(key)];
    if (registry === undefined) continue;
    validateRegistry(registry);
    if (registry.providers.has(name)) return true;
  }
  return false;
}
export function createBackgroundGuard({ getTools, scope = globalThis }) {
  return async ctx => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionIds = [...new Set([sessionFile, sessionId].filter(Boolean))];
    const tools = getTools();
    if (!Array.isArray(tools) || tools.some(tool => !text(tool?.name, 256)))
      throw Error('Background capability inventory unavailable');
    const hasCurrentSubagents = tools.some(tool => CURRENT_SUBAGENT_TOOLS.has(tool.name));
    if (!registeredWorkIdle(sessionIds, scope)) return null;
    // The retired pi-subagents coordinated through the neutral provider, never
    // the retired RPC. With its tools present but no provider, fail closed
    // rather than assume an invisible runner is idle.
    if (hasCurrentSubagents && !hasRegisteredProvider(scope, SUBAGENTS_PROVIDER)) return null;
    if (!registeredWorkIdle(sessionIds, scope)) return null;
    // Controller retains its admission-token interface. Snapshots are not an
    // exclusion lease and do not write any other extension's runtime state.
    return { release: async () => {} };
  };
}
