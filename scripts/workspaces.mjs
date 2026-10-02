import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'verify';
if (!['check', 'test', 'verify'].includes(mode)) {
  console.error('Usage: node scripts/workspaces.mjs [check|test|verify]');
  process.exit(2);
}

// One local scratch root keeps all generated test data out of the user's agent stores.
const scratch = resolve(process.env.PI_EXTENSIONS_TEST_ROOT ?? join(root, 'temp_files', 'tests'));
mkdirSync(scratch, { recursive: true });
const env = {
  ...process.env,
  PI_OFFLINE: '1',
  TMPDIR: scratch,
  PI_BACKGROUND_TEST_ROOT: scratch,
  TELEGRAM_TEST_DIR: scratch,
};

let failures = 0;
const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
for (const name of packages) {
  const directory = join(root, 'packages', name);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const check = manifest.scripts?.check ? 'check' : manifest.scripts?.typecheck ? 'typecheck' : undefined;
  const scripts = mode === 'check' ? [check] : mode === 'test' ? ['test'] : [check, 'test'];
  for (const script of scripts) {
    if (!script || !manifest.scripts?.[script]) {
      console.error(`Missing ${mode} script in ${name}`);
      failures++;
      continue;
    }
    console.log(`\n=== ${name}: ${script} ===`);
    const result = spawnSync('npm', ['--prefix', directory, 'run', script], {
      cwd: directory,
      env,
      stdio: 'inherit',
    });
    if (result.error) console.error(result.error.message);
    if (result.error || result.status !== 0) failures++;
  }
}
console.log(`\n${packages.length} packages checked; ${failures} failing command(s).`);
process.exitCode = failures ? 1 : 0;
