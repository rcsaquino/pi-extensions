import { join } from "node:path";
import { MemoryDatabase } from "../../src/database.ts";
import { HotMemoryStore } from "../../src/hot-memory.ts";

const [directory, content] = process.argv.slice(2) as [string, string];
const db = new MemoryDatabase(join(directory, "memoria.sqlite"));
const hot = new HotMemoryStore(join(directory, "MEMORY.md"), (entries) => { db.archive(entries, "MEMORY.md"); });
try {
  const result = await hot.add(content);
  console.log(JSON.stringify([{ id: result.memory.id, created: result.created }]));
} finally { db.close(); }
