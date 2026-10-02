import { join } from "node:path";
import { MemoryDatabase } from "../../src/database.ts";

const [directory, label] = process.argv.slice(2) as [string, string];
const db = new MemoryDatabase(join(directory, "memoria.sqlite"));
try {
  const results = Array.from({ length: 20 }, (_, index) => {
    const { memory, created } = db.add({
      content: "The user likes apples.", tags: ["fruit", label], source: `session-${label}#${index}`,
    });
    return { id: memory.id, created };
  });
  console.log(JSON.stringify(results));
} finally { db.close(); }
