import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { MemoryDatabase } from "../src/database.ts";
import { HotMemoryStore } from "../src/hot-memory.ts";
import { SessionSearch } from "../src/sessions.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-memoria-bench-"));
const database = new MemoryDatabase(join(directory, "memoria.sqlite"));
const memoryCount = 10_000;
const entryCount = 50_000;

async function measure(label: string, operation: () => unknown | Promise<unknown>, iterations: number) {
  for (let i = 0; i < 3; i++) await operation();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await operation();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { operation: label, runs: iterations, median_ms: Number(times[Math.floor(times.length / 2)]!.toFixed(3)), p95_ms: Number(times[Math.ceil(times.length * 0.95) - 1]!.toFixed(3)) };
}

try {
  console.log(`Preparing ${memoryCount.toLocaleString()} memories and ${entryCount.toLocaleString()} session entries in a temporary directory…`);
  for (let i = 0; i < memoryCount; i++) database.add({ content: `Memory marker${i} records the user's preferred option for task ${i}.`, tags: [`topic${i % 100}`] });
  const sessionsRoot = join(directory, "sessions");
  await mkdir(sessionsRoot);
  let corpusBytes = 0;
  for (let batch = 0; batch < 50; batch++) {
    const lines = Array.from({ length: entryCount / 50 }, (_, i) => {
      const n = batch * (entryCount / 50) + i;
      return JSON.stringify({ type: "message", id: `entry${n}`, parentId: n ? `entry${n - 1}` : null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: `Conversation marker${n} discussed option ${n}. We reviewed tradeoffs and chose a durable solution.` } });
    }).join("\n") + "\n";
    corpusBytes += Buffer.byteLength(lines);
    await writeFile(join(sessionsRoot, `${String(batch).padStart(3, "0")}.jsonl`), lines);
  }
  const hot = new HotMemoryStore(join(directory, "MEMORY.md"), () => {});
  await hot.add("Start every sentence with beep_boop.");
  const sessions = new SessionSearch(() => [sessionsRoot]);
  const results = [];
  results.push(await measure("SQLite FTS5 selective lookup", () => database.search("marker9876"), 200));
  results.push(await measure("SQLite FTS5 exact-tag filtered lookup", () => database.search("marker", "any", 20, 0, { tags: ["topic42"] }), 200));
  results.push(await measure("SQLite literal full scan", () => database.search("marker9876", "literal"), 30));
  results.push(await measure("Hot file refresh with lock", () => hot.load(), 100));
  results.push(await measure("rg session lookup near end of corpus", () => sessions.search({ query: "marker49999" }), 15));
  results.push(await measure("rg absent term, complete scan", () => sessions.search({ query: "unrecordedneedle" }), 15));
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model, memory_count: memoryCount, session_entries: entryCount, session_bytes: corpusBytes, cache: "warm after three warmup runs; timings include process startup for rg", results }, null, 2));
} finally {
  database.close();
  await rm(directory, { recursive: true, force: true });
}
