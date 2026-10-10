import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { open, mkdir, lstat, unlink, rename, opendir, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import type { DeliveryRecord } from "./delivery-ledger.ts";

export const LEDGER_SLOTS = 2048;
export const LEDGER_RECORD_BYTES = 1024;
export const LEDGER_BYTES = LEDGER_SLOTS * LEDGER_RECORD_BYTES;
export const LEDGER_RETENTION_MS = 7 * 86400_000;
const ACTIVE = "events.jsonl", LOCK = "writer.lock", TEMP = "compact.tmp";
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const uid = () => process.getuid?.();
type Codec = (value: unknown) => DeliveryRecord;
const legacyName = (name: string) => /^\d{4}\.json$/.test(name) && Number(name.slice(0, 4)) < LEDGER_SLOTS;
function directorySafe(stat: Stats, privateDir: boolean): void {
  const owner = uid();
  if (!stat.isDirectory() || owner === undefined || (stat.uid !== owner && stat.uid !== 0) ||
    (privateDir ? stat.uid !== owner || (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000)))) throw new Error();
}
function fileSafe(stat: Stats, cap: number): void {
  if (!stat.isFile() || stat.uid !== uid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > cap) throw new Error();
}
const same = (a: Stats, b: Stats) => a.ino === b.ino && a.dev === b.dev;
const unchanged = (a: Stats, b: Stats) => same(a, b) && a.size === b.size && a.ctimeMs === b.ctimeMs;

/** All operations stay anchored to validated descriptors. Never chmod or follow an alias. */
class PrivateDirectory {
  private constructor(readonly path: string, readonly handle: FileHandle) {}
  static async open(path: string, create: boolean): Promise<PrivateDirectory> {
    if (process.platform !== "linux" || !constants.O_NOFOLLOW) throw new Error();
    const absolute = resolve(path), parts = absolute.split("/").filter(Boolean);
    if (!parts.length) throw new Error();
    let held = await open("/", flags);
    try {
      directorySafe(await held.stat(), false);
      for (let index = 0; index < parts.length; index++) {
        const entry = `/proc/self/fd/${held.fd}/${parts[index]}`;
        if (create) await mkdir(entry, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
        const next = await open(entry, flags);
        await held.close(); held = next;
        directorySafe(await held.stat(), index === parts.length - 1);
      }
      return new PrivateDirectory(absolute, held);
    } catch (e) { await held.close().catch(() => {}); throw e; }
  }
  entry(name: string): string { return `/proc/self/fd/${this.handle.fd}/${name}`; }
  async check(): Promise<void> {
    const check = await PrivateDirectory.open(this.path, false);
    try {
      const a = await this.handle.stat(), b = await check.handle.stat();
      directorySafe(a, true); if (!same(a, b)) throw new Error();
    } finally { await check.handle.close(); }
  }
  async stat(name: string, cap: number): Promise<Stats | undefined> {
    try { const s = await lstat(this.entry(name)); fileSafe(s, cap); return s; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  }
  async inventory(): Promise<string[]> {
    const names: string[] = [];
    const stream = await opendir(this.entry("."));
    for await (const node of stream) {
      if (names.length >= LEDGER_SLOTS + 3 || (!legacyName(node.name) && ![ACTIVE, LOCK, TEMP].includes(node.name))) throw new Error();
      names.push(node.name);
    }
    // Readers inspect but never lock, repair, migrate or remove the temporary namespace.
    await this.stat(LOCK, 0); await this.stat(TEMP, LEDGER_BYTES);
    return names;
  }
  async file(name: string, cap: number, create = false): Promise<FileHandle | undefined> {
    const named = await this.stat(name, cap);
    let file: FileHandle;
    try {
      file = await open(this.entry(name), fileFlags | (create ? constants.O_RDWR | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY), 0o600);
    } catch (e) { if (!create && (e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    try {
      const held = await file.stat(); fileSafe(held, cap);
      const current = await this.stat(name, cap);
      if (!current || !same(current, held) || (!create && (!named || !same(named, held)))) throw new Error();
      await this.check(); return file;
    } catch (e) { await file.close(); throw e; }
  }
  async bytes(name: string, cap: number, growing = false): Promise<{ data: Buffer; stat: Stats } | undefined> {
    const file = await this.file(name, cap);
    if (!file) return;
    try {
      const before = await file.stat(); fileSafe(before, cap);
      const data = Buffer.alloc(before.size);
      let count = 0;
      while (count < data.length) {
        const result = await file.read(data, count, data.length - count, count);
        if (!result.bytesRead) throw new Error(); count += result.bytesRead;
      }
      const after = await file.stat(), named = await this.stat(name, cap); fileSafe(after, cap);
      if (!named || !same(named, after) || (!growing && !unchanged(before, after)) || (growing && after.size < before.size)) throw new Error();
      return { data, stat: after };
    } finally { await file.close(); }
  }
  async remove(name: string, expected: Stats, cap: number): Promise<void> {
    await this.check(); const current = await this.stat(name, cap);
    if (!current || !unchanged(expected, current)) throw new Error();
    await unlink(this.entry(name));
  }
}

export function orderRecords(a: DeliveryRecord, b: DeliveryRecord): number {
  return a.at - b.at || (a.writer === b.writer ? (a.sequence || 0) - (b.sequence || 0) : a.event.localeCompare(b.event)) || a.event.localeCompare(b.event);
}
function retain(records: DeliveryRecord[], now: number): DeliveryRecord[] {
  const unique = new Map<string, DeliveryRecord>();
  for (const item of records) if (item.at >= now - LEDGER_RETENTION_MS && item.at <= now + 60_000 && !unique.has(item.event)) unique.set(item.event, item);
  return [...unique.values()].sort(orderRecords).slice(-LEDGER_SLOTS);
}
function encode(item: DeliveryRecord): Buffer {
  const data = Buffer.from(JSON.stringify(item) + "\n");
  if (data.length > LEDGER_RECORD_BYTES) throw new Error(); return data;
}
function decode(data: Buffer, codec: Codec): DeliveryRecord {
  return codec(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)));
}
function parseLines(data: Buffer, codec: Codec): { records: DeliveryRecord[]; skipped: number } {
  const records: DeliveryRecord[] = []; let skipped = 0, start = 0;
  while (start < data.length) {
    const end = data.indexOf(10, start);
    if (end < 0) { skipped++; break; } // Never interpret or append onto an unfinished tail.
    try {
      if (end - start + 1 > LEDGER_RECORD_BYTES) throw new Error();
      const item = decode(data.subarray(start, end), codec); encode(item); records.push(item);
    } catch { skipped++; }
    start = end + 1;
  }
  return { records, skipped };
}

async function checkLock(dir: PrivateDirectory, file: FileHandle): Promise<void> {
  await dir.check(); const held = await file.stat(), named = await dir.stat(LOCK, 0); fileSafe(held, 0);
  if (!named || !same(held, named)) throw new Error();
}

/** Fixed executable, numeric inherited FD, no shell/PATH/credentials. Kernel flock is OFD-scoped. */
async function acquire(dir: PrivateDirectory): Promise<FileHandle> {
  let file: FileHandle | undefined;
  try {
    // Never replace/remove the permanent lock inode, including after a crash.
    try { file = await dir.file(LOCK, 0, true); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; file = await dir.file(LOCK, 0); }
    if (!file) throw new Error();
    // flock accepts read-only descriptors; its child shares the parent's open file description.
    // After helper exit the parent FD retains the lock until close/SIGKILL. No PID stale-lock logic.
    await new Promise<void>((done, reject) => {
      const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"], {
        stdio: ["ignore", "ignore", "ignore", file!.fd], env: {}, windowsHide: true,
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("error", () => { clearTimeout(timer); reject(new Error()); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? done() : reject(new Error()); });
    });
    await checkLock(dir, file); return file;
  } catch (e) { await file?.close().catch(() => {}); throw e; }
}
async function replace(dir: PrivateDirectory, items: DeliveryRecord[], expected: Stats | undefined, lock: FileHandle): Promise<void> {
  // Only invoked with the permanent lock held. A safe crash temp can be discarded: old active
  // remains authoritative until atomic rename. No archive and no automatic legacy cleanup.
  await checkLock(dir, lock);
  const stale = await dir.stat(TEMP, LEDGER_BYTES);
  if (stale) await dir.remove(TEMP, stale, LEDGER_BYTES);
  await checkLock(dir, lock);
  const file = await dir.file(TEMP, LEDGER_BYTES, true);
  if (!file) throw new Error();
  try {
    const data = Buffer.concat(items.map(encode)); if (data.length > LEDGER_BYTES) throw new Error();
    await file.writeFile(data); await file.sync();
    const held = await file.stat(), temp = await dir.stat(TEMP, LEDGER_BYTES); fileSafe(held, LEDGER_BYTES);
    if (!temp || !unchanged(held, temp)) throw new Error();
    await checkLock(dir, lock); const active = await dir.stat(ACTIVE, LEDGER_BYTES);
    if (expected ? !active || !unchanged(expected, active) : active !== undefined) throw new Error();
    await rename(dir.entry(TEMP), dir.entry(ACTIVE)); await dir.handle.sync();
  } finally { await file.close(); }
}

export async function persistRecords(path: string, batch: DeliveryRecord[], codec: Codec): Promise<void> {
  if (!batch.length || batch.length > 256) throw new Error();
  const data = Buffer.concat(batch.map(encode)), dir = await PrivateDirectory.open(path, true);
  let lock: FileHandle | undefined;
  try {
    const names = await dir.inventory();
    // Refuse coexistence with a slot writer. Conversion is explicit, offline and separately approved.
    if (names.some(legacyName)) throw new Error();
    lock = await acquire(dir);
    if ((await dir.inventory()).some(legacyName)) throw new Error();
    const snapshot = await dir.bytes(ACTIVE, LEDGER_BYTES), now = Date.now();
    const parsed = snapshot ? parseLines(snapshot.data, codec) : { records: [], skipped: 0 };
    const items = retain(parsed.records, now);
    await checkLock(dir, lock);
    const stale = await dir.stat(TEMP, LEDGER_BYTES);
    if (stale) await dir.remove(TEMP, stale, LEDGER_BYTES);
    const capacity = items.length + batch.length > LEDGER_SLOTS || (snapshot?.data.length || 0) + data.length > LEDGER_BYTES;
    if (parsed.skipped || items.length !== parsed.records.length || capacity) {
      // Reserve headroom when full, so steady-state activity does NOT rewrite on every event.
      const kept = retain([...items, ...batch], now);
      await replace(dir, capacity ? kept.slice(-(LEDGER_SLOTS - 256)) : kept, snapshot?.stat, lock); return;
    }
    if (!snapshot) { await replace(dir, batch, undefined, lock); return; }
    // Append only under the same lock as compaction. Open active AFTER acquiring it, not before.
    const file = await open(dir.entry(ACTIVE), constants.O_WRONLY | constants.O_APPEND | fileFlags);
    try {
      const before = await file.stat(); fileSafe(before, LEDGER_BYTES);
      if (!unchanged(before, snapshot.stat)) throw new Error(); await checkLock(dir, lock);
      const result = await file.write(data);
      if (result.bytesWritten !== data.length) throw new Error(); // Next writer repairs a partial tail.
      await file.sync(); const after = await file.stat(), named = await dir.stat(ACTIVE, LEDGER_BYTES); fileSafe(after, LEDGER_BYTES);
      if (!named || !same(named, after) || after.size !== before.size + data.length) throw new Error();
      await checkLock(dir, lock); await dir.handle.sync();
    } finally { await file.close(); }
  } finally { await lock?.close(); await dir.handle.close(); }
}

export async function readRecords(path: string, codec: Codec, now: number): Promise<{ records: DeliveryRecord[]; skipped: number; truncated: boolean }> {
  const dir = await PrivateDirectory.open(path, false);
  try {
    const names = await dir.inventory(); let skipped = 0;
    const active = await dir.bytes(ACTIVE, LEDGER_BYTES, true);
    const parsed = active ? parseLines(active.data, codec) : { records: [], skipped: 0 };
    const records = parsed.records; skipped += parsed.skipped;
    // Transition-only read ceiling: <=2 MiB JSONL + <=2 MiB slots. Output is still <=2048 records.
    for (const name of names.filter(legacyName).sort()) {
      try { const bytes = await dir.bytes(name, LEDGER_RECORD_BYTES); if (bytes) records.push(decode(bytes.data, codec)); }
      catch { skipped++; }
    }
    await dir.check();
    const retained = retain(records, now);
    const validUnique = new Set(records.filter(r => r.at >= now - LEDGER_RETENTION_MS && r.at <= now + 60_000).map(r => r.event)).size;
    return { records: retained, skipped, truncated: validUnique > LEDGER_SLOTS };
  } finally { await dir.handle.close(); }
}

/** Operator-only offline conversion. Caller must stop ALL old and new diagnostic writers first.
 * No runtime/tool invokes this. It refuses unsafe/corrupt legacy entries rather than erasing them.
 * Rerunning after interruption deduplicates event UUIDs and safely finishes exact-slot cleanup.
 */
export async function migrateRecords(path: string, codec: Codec, options: { writersStopped: true; now?: number }): Promise<{ retained: number; removed: number }> {
  if (options.writersStopped !== true) throw new Error();
  const dir = await PrivateDirectory.open(path, false); let lock: FileHandle | undefined;
  try {
    const names = await dir.inventory();
    // Preflight every slot BEFORE publishing anything or creating a coordination file.
    const slots: { name: string; stat: Stats; item: DeliveryRecord }[] = [];
    for (const name of names.filter(legacyName).sort()) {
      const bytes = await dir.bytes(name, LEDGER_RECORD_BYTES); if (!bytes) throw new Error();
      const item = decode(bytes.data, codec); encode(item); slots.push({ name, stat: bytes.stat, item });
    }
    lock = await acquire(dir);
    const active = await dir.bytes(ACTIVE, LEDGER_BYTES);
    const parsed = active ? parseLines(active.data, codec) : { records: [], skipped: 0 };
    if (parsed.skipped) throw new Error();
    const combined = [...parsed.records, ...slots.map(s => s.item)], identities = new Map<string, Buffer>();
    for (const item of combined) {
      encode(item);
      const bytes = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))))), prior = identities.get(item.event);
      // Key order is not data; conflicting duplicate IDs cannot overwrite an observation.
      if (prior && !prior.equals(bytes)) throw new Error(); identities.set(item.event, bytes);
    }
    const now = options.now ?? Date.now(), items = retain(combined, now);
    for (const slot of slots) {
      const current = await dir.stat(slot.name, LEDGER_RECORD_BYTES);
      if (!current || !unchanged(current, slot.stat)) throw new Error();
    }
    await replace(dir, items, active?.stat, lock);
    const published = await dir.bytes(ACTIVE, LEDGER_BYTES);
    if (!published || !published.data.equals(Buffer.concat(items.map(encode)))) throw new Error();
    let removed = 0;
    for (const slot of slots) { await checkLock(dir, lock); await dir.remove(slot.name, slot.stat, LEDGER_RECORD_BYTES); removed++; }
    await dir.handle.sync(); return { retained: items.length, removed };
  } finally { await lock?.close(); await dir.handle.close(); }
}
