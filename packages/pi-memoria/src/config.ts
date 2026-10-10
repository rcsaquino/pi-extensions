import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";

export function absolutePath(value: string, name: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!expanded || !isAbsolute(expanded)) throw new Error(`${name} must be an absolute path (or start with ~/).`);
  return resolve(expanded);
}

/** Pi's managed binary belongs to the agent directory, not the memory store. */
export function managedRipgrepPath(agentDir: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix;
  return paths.join(agentDir, "bin", platform === "win32" ? "rg.exe" : "rg");
}

export function configuration(agentDir: string, env: NodeJS.ProcessEnv = process.env) {
  agentDir = absolutePath(agentDir, "Pi agent directory");
  const directory = env.PI_MEMORIA_DIR ? absolutePath(env.PI_MEMORIA_DIR, "PI_MEMORIA_DIR") : join(agentDir, "memoria");
  let additionalRoots: string[] = [];
  if (env.PI_MEMORIA_SESSION_DIRS) {
    const value: unknown = JSON.parse(env.PI_MEMORIA_SESSION_DIRS);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error("PI_MEMORIA_SESSION_DIRS must be a JSON array of absolute directory paths.");
    }
    additionalRoots = value.map((root: string) => absolutePath(root, "PI_MEMORIA_SESSION_DIRS entry"));
  }
  return {
    directory,
    ripgrepPath: managedRipgrepPath(agentDir),
    hotPath: join(directory, "MEMORY.md"),
    databasePath: join(directory, "memoria.sqlite"),
    sessionRoots: [join(agentDir, "sessions"), ...additionalRoots],
  };
}
