// Offline publication regressions. No installs, packing, credentials, or registry calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'git+https://github.com/rcsaquino/pi-extensions.git';
const identities = new Map([
  ['pi-auto-learn', 'pi-auto-learn'],
  ['pi-background-tasks', '@rcsaquino/pi-background-tasks'],
  ['pi-idle-compaction', 'pi-idle-compaction'],
  ['pi-latency-analytics', 'pi-latency-analytics'],
  ['pi-memoria', 'pi-memoria'],
  ['pi-telegram', '@rcsaquino/pi-telegram'],
]);
const read = path => readFileSync(path, 'utf8');
const manifest = path => JSON.parse(read(path));
const packages = [...identities].map(([directory, name]) => ({
  directory, name, root: join(root, 'packages', directory),
  data: manifest(join(root, 'packages', directory, 'package.json')),
}));
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
function includedFiles(pkg) {
  const files = new Set(['package.json']);
  for (const entry of pkg.data.files) {
    const path = join(pkg.root, entry);
    assert.ok(existsSync(path), `${pkg.name}: missing files entry ${entry}`);
    for (const file of walkIfDirectory(path)) files.add(relative(pkg.root, file).split('\\').join('/'));
  }
  return files;
}
function walkIfDirectory(path) {
  const parent = dirname(path);
  const entry = readdirSync(parent, { withFileTypes: true }).find(item => join(parent, item.name) === path);
  assert.ok(entry, `Missing distributable: ${path}`);
  assert.ok(!entry.isSymbolicLink(), `Distributable root must not be a symlink: ${path}`);
  return entry.isDirectory() ? walk(path) : [path];
}
function links(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)].map(match => match[1])
    .filter(target => !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) && !target.startsWith('//'));
}
function headingIds(text) {
  const ids = new Set([...text.matchAll(/<a[^>]*\bid=["']([^"']+)/g)].map(match => match[1]));
  const counts = new Map();
  // Ignore fenced code blocks when deriving GitHub heading anchors.
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '');
  for (const match of prose.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1].toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    ids.add(count ? `${base}-${count}` : base);
  }
  return ids;
}

test('root stays private and publication checks join shared verification', () => {
  const data = manifest(join(root, 'package.json'));
  assert.equal(data.private, true);
  assert.equal(data.engines.node, '>=26.10.0 <27');
  for (const command of ['check', 'test', 'verify']) assert.match(data.scripts[command], /check:publication/);
  assert.equal(data.scripts['check:publication'], 'node --test scripts/publication.test.mjs');
});

test('six independent identities use the scoped names only where needed', () => {
  const directories = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(directories, [...identities.keys()].sort());
  for (const pkg of packages) {
    assert.equal(pkg.data.name, pkg.name);
    assert.match(pkg.data.version, /^\d+\.\d+\.\d+$/);
    assert.ok(pkg.data.keywords.includes('pi-package'));
  }
});

test('memoria advances the public 0.3.1 baseline and auto-learn accepts Pi 1.x', () => {
  const memory = packages.find(pkg => pkg.directory === 'pi-memoria').data;
  const [major, minor, patch] = memory.version.split('.').map(Number);
  assert.ok(major > 0 || minor > 3 || (minor === 3 && patch > 1), 'Do not regress the public memoria release');
  const learner = packages.find(pkg => pkg.directory === 'pi-auto-learn').data;
  assert.equal(learner.peerDependencies['@earendil-works/pi-coding-agent'], '^0.99.2 || ^1.0.0');
});

test('packages are public, MIT-licensed and point to the correct monorepo directory', () => {
  for (const pkg of packages) {
    assert.notEqual(pkg.data.private, true, pkg.name);
    assert.equal(pkg.data.license, 'MIT', pkg.name);
    assert.equal(pkg.data.publishConfig.access, 'public', pkg.name);
    assert.equal(pkg.data.repository.type, 'git');
    assert.equal(pkg.data.repository.url, repository);
    assert.equal(pkg.data.repository.directory, `packages/${pkg.directory}`);
    assert.equal(pkg.data.bugs.url, 'https://github.com/rcsaquino/pi-extensions/issues');
    assert.equal(pkg.data.homepage, `https://github.com/rcsaquino/pi-extensions/tree/main/packages/${pkg.directory}#readme`);
    for (const dependency of Object.keys(pkg.data.dependencies ?? {})) {
      assert.ok(!dependency.startsWith('@earendil-works/pi-') && dependency !== 'typebox', 'Do not bundle host packages');
    }
  }
});

test('all declared distributables exist and include entry points, agent docs and licenses', () => {
  for (const pkg of packages) {
    assert.deepEqual(pkg.data.pi.extensions, ['./index.ts']);
    const files = includedFiles(pkg);
    for (const name of ['index.ts', 'README.md', 'AGENTS.md', 'LICENSE']) assert.ok(files.has(name), `${pkg.name}: ${name}`);
  }
});

test('relative runtime imports remain inside the distributable closure', () => {
  for (const pkg of packages) {
    const files = includedFiles(pkg);
    for (const file of files) {
      if (!/\.(?:ts|mjs|js)$/.test(file)) continue;
      const imports = read(join(pkg.root, file)).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+)["']/g);
      for (const match of imports) {
        const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
        assert.ok(files.has(target), `${pkg.name}: ${file} imports excluded ${target}`);
      }
    }
  }
});

test('source documentation links and local heading anchors resolve', () => {
  const docs = [join(root, 'README.md'), join(root, 'AGENTS.md'), join(root, 'RELEASING.md'),
    ...packages.flatMap(pkg => [...includedFiles(pkg)].filter(file => file.endsWith('.md')).map(file => join(pkg.root, file)))];
  for (const doc of docs) {
    for (const link of links(read(doc))) {
      const [path, anchor] = link.split('#', 2);
      const target = path ? resolve(dirname(doc), decodeURIComponent(path)) : doc;
      assert.ok(existsSync(target), `${relative(root, doc)}: missing ${link}`);
      if (anchor && target.endsWith('.md')) assert.ok(headingIds(read(target)).has(anchor), `${relative(root, doc)}: missing anchor ${link}`);
    }
  }
});

test('package documentation local links also resolve without the monorepo', () => {
  for (const pkg of packages) {
    const files = includedFiles(pkg);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      for (const link of links(read(join(pkg.root, file)))) {
        const target = link.split('#', 1)[0];
        if (!target) continue;
        const path = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(target)));
        assert.ok(files.has(path), `${pkg.name}: ${file} links to excluded ${path}`);
      }
    }
  }
});

test('environment example is inert and interrupted test scratch stays ignored', () => {
  const example = read(join(root, 'packages/pi-telegram/.env.example'));
  const fields = Object.fromEntries(example.split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => line.split('=')));
  assert.deepEqual(fields, { TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_ID: '', GROQ_API_KEY: '',
    ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '', ELEVENLABS_MODEL_ID: 'eleven_v4' });
  const ignore = read(join(root, '.gitignore')).split('\n');
  for (const pattern of ['node_modules/', '.env', '.env.*', '!.env.example', '.test-tmp/', '.tmp/',
    '.loader-test-*/', '.adapter-test-*/', '.guard-test-*/', 'temp_files/', '*.jsonl', '*.sqlite*']) {
    assert.ok(ignore.includes(pattern), `Missing ignore: ${pattern}`);
  }
});
