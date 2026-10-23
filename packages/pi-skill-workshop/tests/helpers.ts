import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export interface Fixture {
  base: string;
  root: string;
  state: string;
}

export async function fixture(t: TestContext): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "psw-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "skills");
  const state = join(base, "state");
  await mkdir(root);
  await mkdir(state, { mode: 0o700 });
  return { base, root, state };
}

export function skillText(name = "alpha", body = "Body.", extra = ""): string {
  return `---\nname: ${name}\ndescription: Use when testing ${name}.\n${extra}---\n${body}\n`;
}

export async function changes(state: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(join(state, "changes.jsonl"), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export async function versions(state: string, name = "alpha"): Promise<string[]> {
  try {
    const entries = await readdir(join(state, "versions", name), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function walk(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    result.push(child);
    if (entry.isDirectory()) result.push(...await walk(child));
  }
  return result;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}
