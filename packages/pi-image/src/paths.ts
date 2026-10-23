import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SafeError } from "./errors.ts";

export const OUTPUT_ESCAPE = "Output must stay inside the Pi working directory.";

/** True when `candidate` is `root` itself or a descendant of it after lexical normalization. */
export function within(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

/**
 * Refuse any existing symlink component between the canonical root and target.
 * Missing components stop the walk: those can be created by the caller and are
 * checked again after creation.
 */
export async function rejectSymlinkComponents(root: string, target: string): Promise<void> {
  const suffix = relative(root, target);
  if (!suffix) return;
  let current = root;
  for (const component of suffix.split(sep)) {
    current = join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new SafeError("Output paths could not be inspected safely.");
    }
    if (info.isSymbolicLink()) throw new SafeError("Output paths must not traverse a symbolic link.");
    if (current !== target && !info.isDirectory()) throw new SafeError("Output parent must be a directory.");
  }
}

/** Canonical working directory, failing closed when it cannot be resolved. */
export async function canonicalRoot(cwd: string): Promise<string> {
  try {
    return await realpath(resolve(cwd));
  } catch {
    throw new SafeError("The Pi working directory could not be resolved.");
  }
}
