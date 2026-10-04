import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Real localhost TLS transport only. No live provider or user credential is read/sent.
 * Rewrite only the fixed Parallel endpoint after asserting it, never an arbitrary URL.
 */
export async function offlineWeb(t: TestContext, root: string, agentDir: string) {
  const dir = join(root, 'tls-fixture'); await fs.mkdir(dir);
  const certPath = join(dir, 'cert.pem'), keyPath = join(dir, 'key.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { cwd: dir });
  const cert = await fs.readFile(certPath), key = await fs.readFile(keyPath); const credential = 'SDK_SYNTHETIC_WEB_CREDENTIAL';
  const oldKey = process.env.SDK_SAFE_WEB_KEY; process.env.SDK_SAFE_WEB_KEY = credential;
  await fs.writeFile(join(agentDir, 'web-search.json'), JSON.stringify({ provider: 'parallel', parallelApiKey: '$SDK_SAFE_WEB_KEY' }), { mode: 0o600 });
  let requests = 0;
  const server = https.createServer({ key, cert }, (req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
    requests++; assert.equal(req.headers['x-api-key'], credential); const request = JSON.parse(body); assert.ok(Array.isArray(request.search_queries));
    res.end(JSON.stringify({ results: [{ title: 'SDK synthetic source', url: 'https://example.com/fixture', excerpts: ['SDK source-linked lookup result, not clinical data.'] }] }));
  }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
  const oldRequest = https.request, oldFetch = globalThis.fetch;
  https.request = ((url: string, options: any, callback: any) => { assert.equal(new URL(url).origin, 'https://api.parallel.ai'); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true); assert.equal(typeof options.lookup, 'function'); return oldRequest(`https://localhost:${port}/search`, { ...options, ca: cert, lookup: undefined, family: 4 }, callback); }) as typeof https.request;
  syncBuiltinESMExports(); globalThis.fetch = (() => { throw new Error('Live network forbidden by offline SDK fixture.'); }) as typeof fetch;
  t.after(async () => { https.request = oldRequest; syncBuiltinESMExports(); globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SDK_SAFE_WEB_KEY; else process.env.SDK_SAFE_WEB_KEY = oldKey;
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { requests: () => requests };
}
