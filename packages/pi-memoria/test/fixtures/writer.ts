import { join } from "node:path";
import { MemoryDatabase } from "../../src/database.ts";
import { HotMemoryStore } from "../../src/hot-memory.ts";

const [directory, label] = process.argv.slice(2) as [string, string];
const db = new MemoryDatabase(join(directory, "memoria.sqlite"));
const hot = new HotMemoryStore(join(directory, "MEMORY.md"), (entries) => { db.archive(entries, "MEMORY.md"); });
try {
  for (let i = 0; i < 8; i++) {
    await hot.add(`Writer ${label} memory ${i}`);
    db.add({ content: `Writer ${label} fact ${i}` });
  }
} finally { db.close(); }
