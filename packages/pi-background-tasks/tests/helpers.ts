import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
export async function scratch(prefix: string): Promise<string> {
  const parent = resolve(process.env.PI_BACKGROUND_TEST_ROOT ?? join(process.env.TMPDIR ?? '/tmp', 'pi-background-tests'));
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(join(parent, prefix));
}
