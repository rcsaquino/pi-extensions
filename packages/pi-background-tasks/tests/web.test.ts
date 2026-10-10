import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { SafeWeb, httpsTransport, resolveSafeCredential, validateSearch, validateResult, webContracts, publicIPv4, publicLookup } from '../src/web.ts';
import { EffectRegistry } from '../src/effects.ts';
import { guardTool } from '../src/policy.ts';
import { emptyUsage } from '../src/types.ts';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import { scratch } from './helpers.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const KEY = 'SYNTHETIC_SAFE_WEB_KEY';
function syntheticProvider(t: test.TestContext) {
  const previous = process.env.PARALLEL_API_KEY; process.env.PARALLEL_API_KEY = KEY;
  t.after(() => { if (previous === undefined) delete process.env.PARALLEL_API_KEY; else process.env.PARALLEL_API_KEY = previous; });
}
const configuration = async () => ({ provider: 'parallel', parallelApiKey: '$SAFE_WEB_FIXTURE_KEY' });
const result = { results: [{ title: 'Synthetic source', url: 'https://example.com/source', excerpts: ['Source-linked synthetic result'] }] };

test('actual read-worker adapter cached/uncached lookup and retrieval preserve source-bound guards', async t => {
  const root = await scratch('web-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = process.env.SAFE_WEB_FIXTURE_KEY; process.env.SAFE_WEB_FIXTURE_KEY = KEY; t.after(() => { if (old === undefined) delete process.env.SAFE_WEB_FIXTURE_KEY; else process.env.SAFE_WEB_FIXTURE_KEY = old; });
  let calls = 0; const web = new SafeWeb(async (_url, headers) => { calls++; assert.equal(headers['x-api-key'], KEY); await new Promise(r => setImmediate(r)); return result; }, configuration, () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const registry = new EffectRegistry(webContracts(['reviewed-source']));
  const info = (name: string) => ({ name, exposure: 'direct', sourceInfo: { path: 'reviewed-source' } }) as ToolInfo;
  const own = { version: 1 as const, id: 'bg-aaaaaaaaaaaa', title: 'Synthetic writer', sessionId: 'test', cwd: root, provider: 'fixture', model: 'fixture', thinking: 'off' as const, status: 'running' as const, access: 'read' as const, startedAt: 1, etaSeconds: 100, etaMaxSeconds: 100, estimateReason: 'fixture', lastActivityAt: 1, toolCalls: 0, turns: 0, usage: emptyUsage(), usageReported: false, notification: 'read' as const, overrunNotified: false };
  assert.equal(guardTool('background_web_search', { query: 'synthetic' }, root, own, info('background_web_search'), registry), undefined);
  const rows = await Promise.all(Array.from({ length: 20 }, () => web.search({ query: 'synthetic' }, 'test')));
  assert.equal(calls, 1); assert.equal(new Set(rows.map(r => r.responseId)).size, 20, 'intentional generator ID collisions cannot overwrite ownership');
  await web.search({ query: 'uncached' }, 'test'); assert.equal(calls, 2);
  const page = web.retrieve({ responseId: rows[0]!.responseId, findText: 'source-linked' }, 'test'); assert.match(JSON.stringify(page), /Source-linked/);
  assert.throws(() => web.retrieve({ responseId: rows[0]!.responseId }, 'other'), /different session/);
  assert.equal(guardTool('background_web_result', { responseId: rows[0]!.responseId }, root, own, info('background_web_result'), registry), undefined);
  assert.match(guardTool('background_web_search', { query: 'safe' }, root, own, { ...info('background_web_search'), sourceInfo: { path: 'spoof' } } as ToolInfo, registry)!, /Read-only/);
  // No disk cache exists to alias, chmod, prune or evict. Synthetic malicious cache
  // files are untouched, rather than passed through the installed unsafe storage.
  const outside = join(root, 'outside'); await fs.writeFile(outside, 'synthetic outside', { mode: 0o644 }); await fs.link(outside, join(root, 'collision.json')); await fs.symlink(root, join(root, 'ancestor'));
  await web.search({ query: 'cache aliases are inert' }, 'test'); assert.equal((await fs.stat(outside)).mode & 0o777, 0o644); assert.equal(await fs.readFile(outside, 'utf8'), 'synthetic outside');
  assert.equal((await fs.readdir(root)).length, 3); assert.doesNotMatch(JSON.stringify(rows) + JSON.stringify(page), new RegExp(KEY));
});
test('unsupported credential, proxy, auth/media/download/workflow variants fail before any request; no raw errors leak', async t => {
  syntheticProvider(t);
  let calls = 0; const web = new SafeWeb(async () => { calls++; throw new Error(KEY + ' request body clinical sentinel'); }, async () => ({ provider: 'parallel', parallelApiKey: KEY }));
  for (const args of [{ query: 'q', proxy: '' }, { query: 'q', includeContent: true }, { query: 'q', auth: true }, { query: 'q', frames: 1 }, { query: 'q', download: true }, { query: 'q', workflow: 'auto-summary' }, { query: 'q', provider: 'openai' }, { query: 'q', queries: ['q'] }, { query: 'q', command: 'touch evil' }]) await assert.rejects(web.search(args, 'test'));
  assert.equal(calls, 0); await assert.rejects(web.search({ query: 'q' }, 'test'), error => !String(error).includes(KEY) && !String(error).includes('clinical sentinel'));
  assert.throws(() => resolveSafeCredential('!touch evil', KEY), /Command credentials/); assert.throws(() => resolveSafeCredential('$MALFORMED space', KEY));
  assert.equal(resolveSafeCredential('${SAFE}', undefined, { SAFE: KEY }), KEY); assert.equal(resolveSafeCredential('literal', 'env'), 'env');
  for (const settings of [{ provider: 'parallel', parallelApiKey: '!command' }, { provider: 'parallel', parallelApiKey: KEY, proxy: 'https://unsafe' }, { provider: 'unknown', parallelApiKey: KEY }]) await assert.rejects(new SafeWeb(async () => { calls++; return result; }, async () => settings).search({ query: 'q' }, 'test'));
  assert.equal(calls, 1);
  const getter = Object.defineProperty({}, 'query', { get() { throw new Error(KEY); } }); assert.throws(() => validateSearch(getter), /Unsupported/);
  assert.throws(() => validateResult({ responseId: '../escape' }));
});
test('bounded memory eviction, private namespaces and result redaction do not expose credentials or original cache IDs', async t => {
  syntheticProvider(t);
  const web = new SafeWeb(async () => ({ results: [{ title: KEY, url: 'https://example.com', excerpts: [KEY] }, { title: 'bad', url: 'https://user:pass@example.com', excerpts: ['discard'] }] }), async () => ({ provider: 'parallel', parallelApiKey: KEY }));
  const first = await web.search({ query: 'q' }, 'session'); assert.doesNotMatch(JSON.stringify(first), new RegExp(KEY)); assert.equal(first.queries[0]!.results.length, 1);
  for (let i = 0; i < 33; i++) await web.search({ query: String(i) }, 'session'); assert.throws(() => web.retrieve({ responseId: first.responseId }, 'session'), /expired/);
  const other = new SafeWeb(); assert.throws(() => other.retrieve({ responseId: first.responseId }, 'session'), /unknown/);
  web.clear(); assert.throws(() => web.retrieve({ responseId: first.responseId }, 'session'));
});
test('real direct HTTPS transport exercises offline provider wire format, cancellation, failures and bounded responses', async t => {
  syntheticProvider(t);
  const root = await scratch('web-tls-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const certPath = join(root, 'cert.pem'), keyPath = join(root, 'key.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { cwd: root });
  const cert = await fs.readFile(certPath), privateKey = await fs.readFile(keyPath); let requests = 0;
  const server = https.createServer({ key: privateKey, cert }, (req, res) => {
    requests++; let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      assert.equal(req.headers['x-api-key'], KEY); const parsed = JSON.parse(body); assert.deepEqual(parsed.search_queries, ['wire fixture']);
      if (req.url === '/failure') { res.writeHead(401); res.end(KEY); }
      else if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1/forbidden' }); res.end(); }
      else if (req.url === '/slow') { const timer = setTimeout(() => res.end(JSON.stringify(result)), 100); res.on('close', () => clearTimeout(timer)); }
      else if (req.url === '/large') res.end('x'.repeat(1024 * 1024 + 1));
      else res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
  const oldRequest = https.request;
  let mode = '/search';
  https.request = ((url: string, options: any, callback: any) => { assert.equal(new URL(url).host, 'api.parallel.ai'); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true); assert.equal(typeof options.lookup, 'function'); return oldRequest(`https://localhost:${port}${mode}`, { ...options, ca: cert, lookup: undefined, family: 4 }, callback); }) as typeof https.request; syncBuiltinESMExports();
  t.after(async () => { https.request = oldRequest; syncBuiltinESMExports(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const web = new SafeWeb(httpsTransport, async () => ({ provider: 'parallel', parallelApiKey: KEY })); const row = await web.search({ query: 'wire fixture' }, 'session'); assert.equal(row.queries[0]!.results.length, 1); assert.equal(requests, 1);
  mode = '/failure'; await assert.rejects(new SafeWeb(httpsTransport, async () => ({ provider: 'parallel', parallelApiKey: KEY })).search({ query: 'wire fixture' }, 'session'), e => !String(e).includes(KEY));
  mode = '/large'; await assert.rejects(new SafeWeb(httpsTransport, async () => ({ provider: 'parallel', parallelApiKey: KEY })).search({ query: 'wire fixture' }, 'session'));
  await assert.rejects(web.search({ query: 'abort' }, 'session', AbortSignal.abort()));
  mode = '/redirect'; const beforeRedirect = requests; await assert.rejects(new SafeWeb(httpsTransport, async () => ({ provider: 'parallel', parallelApiKey: KEY })).search({ query: 'wire fixture' }, 'session')); assert.equal(requests, beforeRedirect + 1, 'redirect location was never requested');
  mode = '/slow'; const controller = new AbortController(); const pending = new SafeWeb(httpsTransport, async () => ({ provider: 'parallel', parallelApiKey: KEY })).search({ query: 'wire fixture' }, 'session', controller.signal); setTimeout(() => controller.abort(), 10); await assert.rejects(pending);
});

test('actual configuration reads reject ancestor symlinks, hardlinks and command credentials without chmod, proxy subprocess or requests', async t => {
  syntheticProvider(t); const root = await scratch('web-config-'); const dir = join(root, 'config'); await fs.mkdir(dir);
  const oldDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => { if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; await fs.rm(root, { recursive: true, force: true }); });
  let requests = 0; const web = new SafeWeb(async () => { requests++; return result; });
  const config = join(dir, 'web-search.json'); await fs.writeFile(config, JSON.stringify({ provider: 'parallel', parallelApiKey: '!touch forbidden' }), { mode: 0o644 }); await assert.rejects(web.search({ query: 'q' }, 's'), /Command credentials/);
  await fs.unlink(config); const outside = join(root, 'outside.json'); await fs.writeFile(outside, JSON.stringify({ provider: 'parallel', parallelApiKey: KEY }), { mode: 0o644 }); await fs.link(outside, config);
  await assert.rejects(web.search({ query: 'q' }, 's'), /unsafe/); assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
  await fs.unlink(config); await fs.writeFile(config, JSON.stringify({ provider: 'parallel', parallelApiKey: KEY })); await fs.symlink(dir, join(root, 'alias')); process.env.PI_CODING_AGENT_DIR = join(root, 'alias');
  await assert.rejects(web.search({ query: 'q' }, 's'), /unsafe/); assert.equal(requests, 0);
});

test('fixed HTTPS endpoints and public-only IPv4 DNS block URL, proxy and rebinding-style SSRF without any live request', async t => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1']) assert.equal(publicIPv4(address), false);
  assert.equal(publicIPv4('8.8.8.8'), true);
  let requests = 0; const oldRequest = https.request;
  https.request = (() => { requests++; throw new Error('Live request forbidden'); }) as typeof https.request; syncBuiltinESMExports();
  t.after(() => { https.request = oldRequest; syncBuiltinESMExports(); });
  for (const url of ['http://api.parallel.ai/v1/search', 'https://127.0.0.1/v1/search', 'https://api.parallel.ai.evil.example/v1/search', 'https://user:pass@api.parallel.ai/v1/search', 'https://api.parallel.ai:444/v1/search', 'https://api.parallel.ai/v1/extract', 'https://api.parallel.ai/v1/search#fragment']) await assert.rejects(httpsTransport(url, {}, undefined), /endpoint/);
  assert.equal(requests, 0);
  const oldLookup = dns.lookup; let addresses = [{ address: '127.0.0.1', family: 4 }];
  dns.lookup = ((_hostname: string, _options: unknown, callback: Function) => callback(null, addresses)) as typeof dns.lookup; syncBuiltinESMExports();
  t.after(() => { dns.lookup = oldLookup; syncBuiltinESMExports(); });
  const resolve = () => new Promise((ok, fail) => publicLookup('api.parallel.ai', { all: true }, (error, result) => error ? fail(error) : ok(result)));
  await assert.rejects(resolve(), /non-public/); addresses = [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]; await assert.rejects(resolve(), /non-public/);
  addresses = [{ address: '8.8.8.8', family: 4 }]; assert.deepEqual(await resolve(), addresses);
});

test('all five supported adapters use only their bounded fixed search wire formats and project safe source links', async t => {
  const previous = process.env.SAFE_WEB_ADAPTER_KEY; process.env.SAFE_WEB_ADAPTER_KEY = KEY;
  t.after(() => { if (previous === undefined) delete process.env.SAFE_WEB_ADAPTER_KEY; else process.env.SAFE_WEB_ADAPTER_KEY = previous; });
  const fields = { brave: 'braveApiKey', parallel: 'parallelApiKey', tavily: 'tavilyApiKey', exa: 'exaApiKey', serper: 'serperApiKey' };
  for (const [provider, field] of Object.entries(fields)) {
    let calls = 0;
    const web = new SafeWeb(async (url, headers, body) => {
      calls++; assert.match(url, /^https:/); assert.ok(Object.values(headers).some(v => v === KEY || v === `Bearer ${KEY}`));
      if (provider === 'brave') { assert.equal(new URL(url).searchParams.get('count'), '3'); assert.equal(body, undefined); return { web: { results: [{ title: 'Brave', url: 'https://example.com', description: 'Synthetic' }] } }; }
      if (provider === 'serper') { assert.equal((body as { num: number }).num, 3); return { organic: [{ title: 'Serper', link: 'https://example.com', snippet: 'Synthetic' }] }; }
      if (provider === 'parallel') assert.equal((body as { advanced_settings: { max_results: number } }).advanced_settings.max_results, 3);
      if (provider === 'tavily') assert.equal((body as { max_results: number }).max_results, 3);
      if (provider === 'exa') assert.equal((body as { numResults: number }).numResults, 3);
      return { results: [{ title: provider, url: 'https://example.com', text: 'Synthetic' }, { title: 'Credential-bearing URL excluded', url: 'https://example.com?access_token=secret' }] };
    }, async () => ({ searchProvider: provider, [field]: '$SAFE_WEB_ADAPTER_KEY' }));
    const page = await web.search({ query: 'Synthetic', numResults: 3 }, 'session'); assert.equal(calls, 1); assert.equal(page.provider, provider); assert.equal(page.queries[0]!.results.length, 1); assert.doesNotMatch(JSON.stringify(page), new RegExp(KEY));
  }
});
