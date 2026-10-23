import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fail } from "./errors.ts";

/**
 * Normalize PI_CODING_AGENT_DIR like the sibling packages: expand `~` and use
 * the host default for an empty value. A relative override is a configuration
 * error rather than a path relative to the process working directory.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME && isAbsolute(env.HOME) ? resolve(env.HOME) : homedir();
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return resolve(home, ".pi", "agent");
  const expanded = configured === "~" ? home
    : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  if (!expanded || !isAbsolute(expanded)) {
    fail("PI_CODING_AGENT_DIR must be an absolute path (or start with ~/).");
  }
  return resolve(expanded);
}

/** Default managed and state locations derive from the host agent directory. */
export function defaultPaths(env: NodeJS.ProcessEnv = process.env): WorkshopPaths {
  const agent = agentDir(env);
  return { root: join(agent, "skills", "skill-workshop"), state: join(agent, "skill-workshop") };
}

export interface WorkshopPaths {
  root: string;
  state: string;
}

/** True when child is parent itself or lives below it. Both paths must be absolute. */
export function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Reject a configured root that is a symlink or a non-directory. */
export function assertDirectoryNotSymlink(path: string, label: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    fail(`cannot inspect ${label} ${path}: ${(error as Error).message}`);
  }
  if (info.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${path}`);
  if (!info.isDirectory()) fail(`${label} must be a directory: ${path}`);
}

/**
 * Canonicalize as far as the path exists. Existing symlinks anywhere in the
 * configured chain are followed only to decide containment; the final component
 * of each configured root is separately refused when it is a symlink.
 */
export function canonicalPath(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(`cannot resolve ${path}: ${(error as Error).message}`);
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve the managed and state roots. State must stay outside the managed
 * root, both lexically and after canonicalization, so archived copies are
 * never discovered as live skills through a symlinked configuration.
 */
export function workshopPaths(env: NodeJS.ProcessEnv = process.env): WorkshopPaths {
  const defaults = defaultPaths(env);
  const root = resolve(env.PI_SKILL_WORKSHOP_ROOT || defaults.root);
  const state = resolve(env.PI_SKILL_WORKSHOP_STATE || defaults.state);
  if (isInside(root, state) || isInside(state, root)) {
    fail("PI_SKILL_WORKSHOP_STATE must be outside PI_SKILL_WORKSHOP_ROOT");
  }
  assertDirectoryNotSymlink(root, "PI_SKILL_WORKSHOP_ROOT");
  assertDirectoryNotSymlink(state, "PI_SKILL_WORKSHOP_STATE");
  const canonicalRoot = canonicalPath(root);
  const canonicalState = canonicalPath(state);
  if (isInside(canonicalRoot, canonicalState) || isInside(canonicalState, canonicalRoot)) {
    fail("PI_SKILL_WORKSHOP_STATE must stay outside PI_SKILL_WORKSHOP_ROOT after resolving symlinks");
  }
  return { root, state };
}
