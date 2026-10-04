import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/** Conservative startup checks, not exclusion of uncoordinated same-user processes.
 * No chmod or SQLite open occurs until the entire existing chain and companions
 * have passed. SQLite needs named companions, so it still owns pathname I/O.
 */
export function databasePath(input: string) {
  const path = resolve(input), dir = dirname(path);
  const directories = () => {
    let current = parse(dir).root;
    for (const part of dir.slice(current.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      try { const info = lstatSync(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe database directory."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  };
  const entry = (name: string) => {
    try {
      const info = lstatSync(name);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe database or SQLite companion alias.");
      return info;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
  };
  const check = () => {
    directories(); const info = entry(path);
    for (const suffix of ["-wal", "-shm", "-journal"]) if (entry(path + suffix) && !info) throw new Error("Orphaned SQLite companion without a database.");
    return info;
  };
  check(); mkdirSync(dir, { recursive: true, mode: 0o700 }); check();
  return {
    path, check,
    inspect(work: (snapshot: string) => void) {
      // SQLite READONLY still writes WAL shared-memory read marks (and may create
      // companions). Inspect a private coherent copy instead of touching foreign
      // state. Do not copy -shm: SQLite reconstructs it ONLY in this private tree.
      const scratch = mkdtempSync(join(tmpdir(), "pi-memoria-inspection-"));
      const snapshot = join(scratch, "inspect.sqlite");
      try {
        for (let attempt = 0; ; attempt++) {
          const originals: { name: string; info: Stats }[] = [];
          const missing: string[] = [];
          let changed = false;
          for (const suffix of ["", "-wal", "-journal"]) {
            const name = path + suffix, info = entry(name);
            if (!info) { missing.push(name); continue; }
            const source = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            let target: number | undefined;
            try {
              const held = fstatSync(source);
              if (!held.isFile() || held.nlink !== 1 || held.ino !== info.ino || held.dev !== info.dev) throw new Error("Unsafe database inspection identity.");
              target = openSync(snapshot + suffix, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              const buffer = Buffer.allocUnsafe(64 * 1024);
              let offset = 0;
              while (offset < held.size) {
                const count = readSync(source, buffer, 0, Math.min(buffer.length, Number(held.size) - offset), offset);
                if (!count) { changed = true; break; }
                let written = 0;
                while (written < count) written += writeSync(target, buffer, written, count - written);
                offset += count;
              }
              originals.push({ name, info: held });
            } finally { closeSync(source); if (target !== undefined) closeSync(target); }
          }
          check();
          if (missing.some(name => entry(name))) changed = true;
          for (const { name, info } of originals) {
            const now = entry(name);
            if (!now || now.ino !== info.ino || now.dev !== info.dev || now.size !== info.size || now.mtimeMs !== info.mtimeMs || now.ctimeMs !== info.ctimeMs) changed = true;
          }
          if (!changed) { work(snapshot); return; }
          for (const suffix of ["", "-wal", "-journal", "-shm"]) rmSync(snapshot + suffix, { force: true });
          if (attempt >= 4) throw new Error("Database changed during ownership inspection.");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    },
    privateMode() {
      check();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const held = fstatSync(fd), named = check();
        if (!held.isFile() || held.nlink !== 1 || !named || named.ino !== held.ino || named.dev !== held.dev) throw new Error("Database identity changed.");
        fchmodSync(fd, 0o600);
      } finally { closeSync(fd); }
    },
  };
}
