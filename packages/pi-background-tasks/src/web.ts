import { request } from 'node:https';
import { lookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { digest, readRegular } from './files.ts';
import { plainArgs, type EffectContract } from './effects.ts';

const providers = ['brave', 'parallel', 'tavily', 'exa', 'serper'] as const;
type Provider = typeof providers[number];
const credentials: Record<Provider, [string, string]> = { brave: ['braveApiKey', 'BRAVE_API_KEY'], parallel: ['parallelApiKey', 'PARALLEL_API_KEY'], tavily: ['tavilyApiKey', 'TAVILY_API_KEY'], exa: ['exaApiKey', 'EXA_API_KEY'], serper: ['serperApiKey', 'SERPER_API_KEY'] };
export const webSearchSchema = Type.Object({ query: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })), queries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 4 })), provider: Type.Optional(Type.Union(providers.map(p => Type.Literal(p)))), numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), workflow: Type.Optional(Type.Literal('none')), includeContent: Type.Optional(Type.Literal(false)) }, { additionalProperties: false });
export const webResultSchema = Type.Object({ responseId: Type.String({ maxLength: 120 }), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000 })), findText: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false });
export function validateSearch(args: Record<string, unknown>): void {
  if (!plainArgs(args) || Object.keys(args).some(k => !['query', 'queries', 'provider', 'numResults', 'workflow', 'includeContent'].includes(k)) || (args.query === undefined) === (args.queries === undefined) || (args.workflow !== undefined && args.workflow !== 'none') || (args.includeContent !== undefined && args.includeContent !== false) || (args.provider !== undefined && !providers.includes(args.provider as Provider)) || (args.numResults !== undefined && (!Number.isInteger(args.numResults) || Number(args.numResults) < 1 || Number(args.numResults) > 20))) throw new Error('Unsupported safe web search options. Use one query or up to four queries; no auth, proxy, workflow, download, media or extraction.');
  const queries = args.query !== undefined ? [args.query] : args.queries;
  if (!Array.isArray(queries) || !queries.length || queries.length > 4 || queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 2000)) throw new Error('Invalid safe web queries.');
}
export function validateResult(args: Record<string, unknown>): void {
  if (!plainArgs(args) || Object.keys(args).some(k => !['responseId', 'offset', 'limit', 'findText'].includes(k)) || typeof args.responseId !== 'string' || !/^safe-web-[a-f0-9-]{36}-[a-f0-9-]{1,50}$/.test(args.responseId) || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)) || (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 24000)) || (args.findText !== undefined && (typeof args.findText !== 'string' || !args.findText || args.findText.length > 200))) throw new Error('Invalid safe web result arguments.');
}
export type Transport = (url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) => Promise<unknown>;
const endpoints: Record<string, string> = { 'api.search.brave.com': '/res/v1/web/search', 'api.parallel.ai': '/v1/search', 'api.tavily.com': '/search', 'api.exa.ai': '/search', 'google.serper.dev': '/search' };
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  if (!Object.hasOwn(endpoints, hostname)) { callback(new Error('Unsupported safe web host.'), '', 4); return; }
  lookup(hostname, { family: 4, all: true }, (error, addresses) => {
    if (error || !addresses.length || addresses.some(a => !publicIPv4(a.address))) { callback(new Error('Safe web DNS resolution is unavailable or non-public.'), '', 4); return; }
    callback(null, options.all ? addresses : addresses[0]!.address, 4);
  });
};
/** Direct Node HTTPS only, independent of pi-web-access/global fetch proxy patching.
 * Fixed provider endpoints, no redirects, processes, temp files, cookies or credential commands.
 */
export const httpsTransport: Transport = (url, headers, body, signal) => new Promise((resolve, reject) => {
  let target: URL;
  try { target = new URL(url); if (target.protocol !== 'https:' || target.username || target.password || target.port || !Object.hasOwn(endpoints, target.hostname) || target.pathname !== endpoints[target.hostname] || target.hash) throw new Error(); }
  catch { reject(new Error('Unsupported safe web HTTPS endpoint.')); return; }
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  const req = request(url, { method: body === undefined ? 'GET' : 'POST', headers, signal: combined, agent: false, rejectUnauthorized: true, family: 4, lookup: publicLookup }, response => {
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); reject(new Error('Safe web provider rejected request.')); return; }
    const chunks: Buffer[] = []; let size = 0;
    response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { response.destroy(); reject(new Error('Safe web provider response exceeds limit.')); } else chunks.push(chunk); });
    response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Safe web provider returned invalid data.')); } });
    response.on('error', () => reject(new Error('Safe web response failed.')));
  });
  req.on('error', () => reject(new Error('Safe web request failed or was cancelled.')));
  if (body !== undefined) req.write(JSON.stringify(body)); req.end();
});
export function resolveSafeCredential(configured: unknown, fallback?: string, env = process.env): string {
  if (configured !== undefined && typeof configured !== 'string') throw new Error('Invalid safe web credential configuration.');
  let value = typeof configured === 'string' ? configured.trim() : '';
  if (value.startsWith('!')) throw new Error('Command credentials are unsupported by safe web search. Original tools remain unchanged.');
  if (value.startsWith('$$') || value.startsWith('$!')) value = value.slice(1);
  else if (value.startsWith('$')) { const match = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(value); if (!match) throw new Error('Invalid safe web environment credential.'); value = env[match[1] ?? match[2]!] ?? ''; }
  else value = fallback?.trim() || value;
  if (!value || value.length > 16384 || /[\0-\x1f\x7f]/.test(value)) throw new Error('Safe web provider credential is missing or invalid.');
  return value;
}
async function config(): Promise<Record<string, unknown>> {
  const paths = process.env.PI_CODING_AGENT_DIR ? [join(process.env.PI_CODING_AGENT_DIR, 'web-search.json')]
    : process.env.XDG_CONFIG_HOME ? [join(process.env.XDG_CONFIG_HOME, 'pi', 'web-search.json'), join(homedir(), '.pi', 'web-search.json')]
    : [join(homedir(), '.pi', 'agent', 'web-search.json'), join(homedir(), '.pi', 'web-search.json')];
  for (const path of paths) {
    const data = await readRegular(path, 1024 * 1024).catch(e => { if (e.code === 'ENOENT') return null; throw new Error('Safe web configuration path is unsafe or unreadable.'); });
    if (data) { let value: unknown; try { value = JSON.parse(data.toString()); } catch { throw new Error('Invalid safe web configuration JSON.'); } if (!plainArgs(value)) throw new Error('Invalid safe web configuration.'); return value; }
  }
  return {};
}
export interface SafeSource { title: string; url: string; snippet: string }
function source(value: any, key: string): SafeSource | null {
  if (!value || typeof value.url !== 'string') return null;
  let url: URL; try { url = new URL(value.url); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  if ([...url.searchParams.keys()].some(k => /^(?:api[_-]?key|access[_-]?token|token|password|secret|authorization|signature)$/i.test(k))) return null;
  const clean = (text: unknown, limit: number) => [key, encodeURIComponent(key)].reduce((value, secret) => value.split(secret).join('[redacted]'), typeof text === 'string' ? text : '').slice(0, limit);
  return { title: clean(value.title, 400), url: clean(url.toString(), 2000), snippet: clean(value.description ?? value.text ?? value.content ?? value.snippet ?? value.excerpts?.join('\n'), 12000) };
}
async function providerSearch(provider: Provider, query: string, count: number, key: string, transport: Transport, signal?: AbortSignal): Promise<SafeSource[]> {
  let url: string, body: unknown, header: Record<string, string> = { 'Content-Type': 'application/json' }, select: (data: any) => unknown;
  switch (provider) {
    case 'brave': url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`; header['X-Subscription-Token'] = key; select = d => d.web?.results; break;
    case 'parallel': url = 'https://api.parallel.ai/v1/search'; header['x-api-key'] = key; body = { objective: query, search_queries: [query], advanced_settings: { max_results: count } }; select = d => d.results; break;
    case 'tavily': url = 'https://api.tavily.com/search'; header.Authorization = `Bearer ${key}`; body = { query, max_results: count, include_answer: false, include_raw_content: false }; select = d => d.results; break;
    case 'exa': url = 'https://api.exa.ai/search'; header['x-api-key'] = key; body = { query, numResults: count, contents: { text: { maxCharacters: 12000 } } }; select = d => d.results; break;
    case 'serper': url = 'https://google.serper.dev/search'; header['X-API-KEY'] = key; body = { q: query, num: count }; select = d => d.organic?.map((v: any) => ({ ...v, url: v.link })); break;
  }
  try { const results = select(await transport(url, header, body, signal)); if (!Array.isArray(results)) throw new Error(); return results.slice(0, count).map(r => source(r, key)).filter((r): r is SafeSource => !!r); }
  catch { throw new Error('Safe web provider request failed, was cancelled or returned unsupported data. No raw provider diagnostics retained.'); }
}
/** Private per-session MEMORY cache. No persistent cache, aliases, chmod, pruning,
 * files or detached fetch exist. Thus filesystem alias attacks cannot reach a cache
 * entry. IDs are namespace-owned and collisions never overwrite another response.
 * Reload intentionally loses results. It does not certify live provider acceptance.
 */
export class SafeWeb {
  readonly namespace = randomUUID();
  private sequence = 0;
  private ownership = new AbortController();
  private rows = new Map<string, { session: string; text: string }>();
  private cache = new Map<string, { session: string; rows: SafeSource[][] }>();
  private pending = new Map<string, Promise<SafeSource[][]>>();
  readonly transport: Transport;
  readonly loadConfig: typeof config;
  readonly identifier: () => string;
  constructor(transport: Transport = httpsTransport, loadConfig = config, identifier: () => string = randomUUID) { this.transport = transport; this.loadConfig = loadConfig; this.identifier = identifier; }
  async search(args: Record<string, unknown>, session: string, signal?: AbortSignal) {
    validateSearch(args); signal = signal ? AbortSignal.any([signal, this.ownership.signal]) : this.ownership.signal;
    signal.throwIfAborted(); const settings = await this.loadConfig(); signal.throwIfAborted();
    if (settings.proxy) throw new Error('Configured proxies are unsupported by safe web search; no global settings were changed.');
    const selected = args.provider ?? settings.searchProvider ?? settings.provider ?? 'auto';
    if (selected !== 'auto' && !providers.includes(selected as Provider)) throw new Error('Configured provider is not supported by this narrow safe adapter. Use the original tool conservatively or explicitly select a supported provider.');
    const provider = (selected === 'auto' ? providers.find(p => settings[credentials[p][0]] || process.env[credentials[p][1]]) : selected) as Provider | undefined;
    if (!provider) throw new Error('No supported safe web provider is configured.');
    const [field, environment] = credentials[provider]; const key = resolveSafeCredential(settings[field], process.env[environment]);
    if (settings[`${provider}BaseUrl`] || settings[`${provider}ApiBaseUrl`]) throw new Error('Custom endpoints require a separately reviewed adapter.');
    const queries = (args.query !== undefined ? [args.query] : args.queries) as string[];
    const count = Number(args.numResults ?? 5), cacheKey = digest(JSON.stringify([session, provider, queries, count, key]));
    let rows = this.cache.get(cacheKey)?.rows;
    if (!rows) {
      let pending = this.pending.get(cacheKey);
      if (!pending) {
        if (this.pending.size >= 8) throw new Error('Safe web request capacity reached; no request started.');
        // At most two query requests per call, all awaited. No detached work.
        pending = (async () => { const results: SafeSource[][] = []; for (let i = 0; i < queries.length; i += 2) { const batch = await Promise.allSettled(queries.slice(i, i + 2).map(q => providerSearch(provider, q, count, key, this.transport, signal))); if (batch.some(r => r.status === 'rejected')) throw new Error('Safe web query batch failed. All sibling requests settled.'); results.push(...batch.map(r => (r as PromiseFulfilledResult<SafeSource[]>).value)); } return results; })();
        this.pending.set(cacheKey, pending); void pending.finally(() => { if (this.pending.get(cacheKey) === pending) this.pending.delete(cacheKey); }).catch(() => {});
      }
      rows = await pending; signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(rows)) > 1024 * 1024) throw new Error('Safe web cached-source byte limit exceeded.');
      this.cache.set(cacheKey, { session, rows });
      while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
    }
    signal?.throwIfAborted();
    const responseId = `safe-web-${this.namespace}-${this.identifier().slice(0, 36)}-${(++this.sequence).toString(16)}`;
    const result = { responseId, provider, queries: queries.map((query, i) => ({ query: query.split(key).join('[redacted]'), results: rows![i] })), cache: 'private session memory only; not durable' };
    const text = JSON.stringify(result); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Safe web result size limit exceeded.');
    this.rows.set(responseId, { session, text }); while (this.rows.size > 32) this.rows.delete(this.rows.keys().next().value!);
    const inline = { ...result, queries: result.queries.map(q => ({ query: q.query.slice(0, 400), results: [] as SafeSource[] })), truncated: false };
    const budget = Math.max(0, Math.floor((24000 - Buffer.byteLength(JSON.stringify(inline))) / queries.length));
    for (const [index, query] of result.queries.entries()) {
      let used = 0; if (query.query.length > 400) inline.truncated = true;
      for (const row of query.results ?? []) {
        const source = { ...row, snippet: row.snippet.slice(0, 800) }; const bytes = Buffer.byteLength(JSON.stringify(source)) + 2;
        if (used + bytes > budget) { inline.truncated = true; break; }
        inline.queries[index]!.results.push(source); used += bytes; if (source.snippet.length !== row.snippet.length) inline.truncated = true;
      }
    }
    return inline;
  }
  retrieve(args: Record<string, unknown>, session: string) {
    validateResult(args); const row = this.rows.get(args.responseId as string);
    if (!row || row.session !== session) throw new Error('Safe web result is unknown, expired or belongs to a different session.');
    const limit = Number(args.limit ?? 12000); let offset = Number(args.offset ?? 0);
    if (args.findText) { const found = row.text.toLowerCase().indexOf(String(args.findText).toLowerCase()); if (found < 0) return { responseId: args.responseId, found: false }; offset = Math.max(0, found - 200); }
    return { responseId: args.responseId, content: row.text.slice(offset, offset + limit), nextOffset: row.text.length > offset + limit ? offset + limit : null, totalCharacters: row.text.length };
  }
  clear(): void { this.ownership.abort(); this.ownership = new AbortController(); this.pending.clear(); this.rows.clear(); this.cache.clear(); }
}
export function webContracts(sources: string[]): EffectContract[] {
  return sources.flatMap(source => [
    { name: 'background_web_search', source, readCandidate: true, classify: (args: Record<string, unknown>) => { validateSearch(args); return { kind: 'network-read' as const }; } },
    { name: 'background_web_result', source, readCandidate: true, classify: (args: Record<string, unknown>) => { validateResult(args); return { kind: 'network-read' as const }; } },
  ]);
}
export function registerWeb(pi: ExtensionAPI, web = new SafeWeb(), scope = (_id: string, ctx: ExtensionToolContext) => ctx.sessionManager.getSessionId()): void {
  pi.registerTool({ name: 'background_web_search', label: 'Safe web lookup', description: 'Narrow reviewed HTTPS web search during unrelated background work. Uses existing literal/environment credentials and configured Brave, Parallel, Tavily, Exa or Serper provider; no command credentials, proxy, auth cookies, downloads, media, extraction, curator or model workflows. Results use private bounded session memory, not disk or original web response IDs. Default configured provider is preserved; unsupported providers fail clearly.', parameters: webSearchSchema, annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false }, execute: async (_id, args, signal, _update, ctx) => { const result = await web.search(args, scope(_id, ctx), signal); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; } });
  pi.registerTool({ name: 'background_web_result', label: 'Safe web result', description: 'Retrieve/paginate/search an owned background_web_search result from private session memory. Never reads original pi-web-access caches or response IDs; reload loses these results.', parameters: webResultSchema, annotations: { readOnlyHint: true, destructiveHint: false }, execute: async (_id, args, _signal, _update, ctx) => { const result = web.retrieve(args, scope(_id, ctx)); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; } });
  pi.on('session_shutdown', () => web.clear());
}
