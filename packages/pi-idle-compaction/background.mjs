// Optional same-process contracts, not imports or npm dependencies.
export const REGISTRY_KEY = 'idle-compaction.background-work.v1';
const LIMITS = { providers: 100, items: 10000 };
const SCOPES = ['session', 'global'];
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
  if (!fields(provider, ['name', 'listActiveWork', 'reconcile', 'wakeChannels', 'scope'])
    || !text(name, 128) || provider.name !== name || typeof provider.listActiveWork !== 'function'
    || (provider.reconcile !== undefined && typeof provider.reconcile !== 'function')
    || (provider.scope !== undefined && !SCOPES.includes(provider.scope)))
    throw Error('Background provider is unavailable or unsupported');
  if (provider.wakeChannels !== undefined && (!Array.isArray(provider.wakeChannels)
    || provider.wakeChannels.length > 1000
    || provider.wakeChannels.some(channel => !text(channel, 256))
    || new Set(provider.wakeChannels).size !== provider.wakeChannels.length))
    throw Error('Background provider channels are invalid');
}
function snapshotWork(provider, context) {
  syncResult(provider.reconcile?.(context));
  const items = syncResult(provider.listActiveWork(context));
  if (!Array.isArray(items) || items.length > LIMITS.items) throw Error('Invalid background work snapshot');
  const seen = new Set();
  for (const item of items) {
    if (!fields(item, ['id', 'sessionId']) || !text(item.id, 256) || !text(item.sessionId, 4096))
      throw Error('Invalid background work item');
    const identity = `${item.sessionId}\0${item.id}`;
    if (seen.has(identity)) throw Error('Duplicate background work item');
    seen.add(identity);
  }
  return items;
}
export function registeredWorkIdle(sessionIds, scope = globalThis, nowMs = Date.now()) {
  if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.some(id => !text(id, 4096)))
    throw Error('Invalid background session identity');
  const registry = scope[Symbol.for(REGISTRY_KEY)];
  if (registry === undefined) return true; // No registered provider, not a missing required host.
  validateRegistry(registry);
  // Snapshot bounded entries so mutation during a provider callback cannot
  // extend Map iteration indefinitely. Recheck after asynchronous provider admission.
  for (const [name, provider] of [...registry.providers]) {
    validateProvider(name, provider);
    // Global providers cover work outside this session (for example detached
    // background workers). They do not block same-session idle compaction.
    if (provider.scope === 'global') continue;
    const context = { sessionId: sessionIds[0], nowMs };
    const items = snapshotWork(provider, context);
    if (items.some(item => sessionIds.includes(item.sessionId))) return false;
  }
  return true;
}

export function registeredGlobalWorkIdle(root = globalThis, nowMs = Date.now()) {
  const registry = root[Symbol.for(REGISTRY_KEY)];
  if (registry === undefined) return true;
  validateRegistry(registry);
  for (const [name, provider] of [...registry.providers]) {
    validateProvider(name, provider);
    if (provider.scope !== 'global') continue;
    // A global provider has no single owning session; it reports only while
    // detached work in this process is alive.
    const items = snapshotWork(provider, { nowMs });
    if (items.length) return false;
  }
  return true;
}

export function createBackgroundGuard({ scope = globalThis } = {}) {
  return async ctx => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionIds = [...new Set([sessionFile, sessionId].filter(Boolean))];
    if (!registeredWorkIdle(sessionIds, scope)) return null;
    // Controller retains its admission-token interface. Snapshots are not an
    // exclusion lease and do not write any other extension's runtime state.
    return { release: async () => {} };
  };
}

export function createDailyResetGuard({ root = globalThis } = {}) {
  return async ctx => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionIds = [...new Set([sessionFile, sessionId].filter(Boolean))];
      if (!registeredWorkIdle(sessionIds, root)) return null;
      if (!registeredGlobalWorkIdle(root)) return null;
    } catch {
      // Unknown background state fails closed for a destructive session switch.
      return null;
    }
    return { release: async () => {} };
  };
}
