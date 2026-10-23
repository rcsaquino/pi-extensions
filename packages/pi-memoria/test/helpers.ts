import { chown, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-memoria-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Try to give a directory a genuinely different owner and report whether that
 * worked. Root runners can create the foreign-ownership fixture; unprivileged
 * runners cannot, so callers must cover both pruning branches based on the
 * observed uid rather than on the runner's privileges.
 */
export async function makeForeignOwned(path: string): Promise<boolean> {
  const owner = process.getuid?.();
  if (owner === undefined) return false;
  const other = owner === 0 ? 1 : owner === 0xffff ? owner - 1 : owner + 1;
  try { await chown(path, other, other); } catch { return false; }
  try { return (await stat(path)).uid !== owner; } catch { return false; }
}
