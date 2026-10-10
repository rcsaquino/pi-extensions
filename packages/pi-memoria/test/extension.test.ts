import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type { TObject } from "typebox";
import { DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { ExpectedError } from "../src/errors.ts";
import { toolError } from "../src/results.ts";
import { temporary } from "./helpers.ts";

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function block(text: string, name: string): string {
  assert.equal(occurrences(text, `<${name}>`), 1);
  assert.equal(occurrences(text, `</${name}>`), 1);
  const match = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`, "u").exec(text);
  assert.ok(match, `${name} must be a separate nested block`);
  return match[1]!;
}

/** Load the real extension through Pi's loader with isolated storage. */
async function harness(t: TestContext) {
  const directory = await temporary(t);
  const agentDir = join(directory, "agent");
  const memoryDir = join(directory, "memory");
  const root = join(agentDir, "sessions");
  const sessionFile = join(root, "a.jsonl");
  await mkdir(root, { recursive: true });
  await writeFile(sessionFile, JSON.stringify({ type: "message", id: "entry", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "We discussed the fruit preference." } }) + "\n");
  const originalAgent = process.env.PI_CODING_AGENT_DIR;
  const originalMemory = process.env.PI_MEMORIA_DIR;
  const originalRoots = process.env.PI_MEMORIA_SESSION_DIRS;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_MEMORIA_DIR = memoryDir;
  delete process.env.PI_MEMORIA_SESSION_DIRS;
  t.after(() => {
    for (const [name, value] of [["PI_CODING_AGENT_DIR", originalAgent], ["PI_MEMORIA_DIR", originalMemory], ["PI_MEMORIA_SESSION_DIRS", originalRoots]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir, settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [resolve("index.ts")],
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0]!;
  const sessionManager = SessionManager.inMemory(directory);
  // Keep the original synthetic source citation without opening a real session.
  sessionManager.getSessionDir = () => root;
  sessionManager.getSessionFile = () => sessionFile;
  sessionManager.getLeafId = () => "entry";
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined, list: async () => [],
      modify: async () => { throw new Error("Credential writes are forbidden in this fixture"); },
      delete: async () => { throw new Error("Credential writes are forbidden in this fixture"); },
    },
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, directory, sessionManager, new ModelRegistry(modelRuntime));
  const ctx = runner.createContext();
  // This direct-execution fixture has no nested-tool pipeline bound. The SDK
  // advertises no callable tools and returns a structured failure, never a fake success.
  const toolContext = runner.createToolContext("fixture", undefined);
  assert.deepEqual(toolContext.tools, []);
  assert.equal((await toolContext.executeTool("unavailable_fixture_tool", {})).isError, true);
  const dispatch = async (name: string, event: unknown = {}) => {
    let result: unknown;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  t.after(() => dispatch("session_shutdown"));
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await extension.tools.get(name)!.definition.execute("test", args, signal, undefined, runner.createToolContext("test", signal));
    const text = result.content.map((part) => part.type === "text" ? part.text : "").join("");
    return { result, details: result.details as Record<string, any>, text };
  };
  const prompt = () => ({ systemPrompt: "base prompt", systemPromptOptions: { sections: { other: "preserve me" } as Record<string, string>, forceSystemPrompt: undefined as string | undefined } });
  const section = (event: ReturnType<typeof prompt>) => (event.systemPromptOptions.sections as Record<string, string>).pi_memoria!;
  const renderPrompt = async (forceSystemPrompt?: string) => {
    let rendered = "";
    const handlers = extension.handlers.get("before_agent_start")!;
    handlers.push(async (event) => { rendered = (event as BeforeAgentStartEvent).systemPrompt; });
    try {
      const result = await runner.emitBeforeAgentStart("Fixture prompt", undefined, {
        cwd: directory, appendSystemPrompt: "Eve addendum fixture.", sections: { other: "preserve me" }, forceSystemPrompt,
      });
      return { rendered, options: result.systemPromptOptions };
    } finally { handlers.pop(); }
  };
  return { directory, agentDir, memoryDir, root, sessionFile, extension, dispatch, call, prompt, section, renderPrompt };
}

test("Pi loads the package, executes all five tools, injects fresh global memory, and closes/reopens cleanly", async (t) => {
  const h = await harness(t);
  assert.deepEqual([...h.extension.tools.keys()].sort(), ["memoria_add", "memoria_delete", "memoria_edit", "memoria_search", "memoria_sessions"]);
  for (const [name, definition] of h.extension.tools) {
    assert.ok(definition.definition.promptSnippet?.trim(), `${name} must have a prompt snippet`);
  }
  await assert.rejects(stat(h.memoryDir), { code: "ENOENT" }, "loading the factory must not mutate storage");

  await h.dispatch("session_start");
  const added = await h.call("memoria_add", { store: "hot", content: "Start every sentence with beep_boop.", priority: 90, tags: ["style"], source: "explicit user instruction" });
  assert.deepEqual(added.details.ignored_fields, ["tags", "source"]);
  assert.match(added.text, /not saved/u);
  assert.equal((await h.call("memoria_search", {})).details.results.length, 0, "hot metadata must not create a SQLite copy");
  assert.match(JSON.stringify(h.extension.tools.get("memoria_search")!.definition.parameters), /SQLite m_… memory ID only/u);
  await assert.rejects(h.call("memoria_search", { id: added.details.memory.id }), (error: Error) => /\[invalid_input\]/u.test(error.message) && /injected MEMORY\.md/u.test(error.message));
  const id = added.details.memory.id;
  const event = h.prompt();
  await h.dispatch("before_agent_start", event);
  assert.match(h.section(event), /Start every sentence with beep_boop/u);
  assert.match(h.section(event), /Before saving a durable fact, search SQLite with memoria_search/u);
  assert.match(h.extension.tools.get("memoria_add")!.definition.promptGuidelines!.join(" "), /same fact is already stored, do not add it again/u);
  assert.equal(event.systemPromptOptions.sections.other, "preserve me");
  const fact = await h.call("memoria_add", { content: "The user likes apples.", tags: ["fruit"] });
  assert.equal(fact.details.created, true);
  assert.equal((await h.call("memoria_search", { query: "fruit" })).details.results[0].id, fact.details.memory.id);
  assert.ok(fact.details.memory.source.includes("#entry"));
  await h.dispatch("session_shutdown");
  await h.dispatch("session_start");
  const repeated = await h.call("memoria_add", { content: "The user likes apples.", source: "another-session#entry" });
  assert.equal(repeated.details.created, false);
  assert.deepEqual(repeated.details.memory, fact.details.memory);
  assert.match(repeated.text, /already stored/u);
  assert.equal((await h.call("memoria_search", {})).details.results.length, 1);
  await h.call("memoria_edit", { id: fact.details.memory.id, content: "The user likes pears.", expected_revision: 1 });
  assert.equal((await h.call("memoria_search", { id: fact.details.memory.id })).details.content, "The user likes pears.");
  const sessions = await h.call("memoria_sessions", { query: "fruit preference" });
  assert.equal(sessions.details.results[0].line, 1);
  assert.match(sessions.text, /a\.jsonl:1/u);
  assert.match((await h.call("memoria_sessions", { action: "read", path: h.sessionFile, line: 1 })).details.text, /We discussed/u);

  const hotEdit = await h.call("memoria_edit", { id, content: "Start every sentence with beep_boop twice.", tags: [], source: "" });
  assert.deepEqual(hotEdit.details.ignored_fields, ["tags", "source"]);
  assert.equal(occurrences(hotEdit.text, "beep_boop twice."), 1);
  await assert.rejects(h.call("memoria_edit", { id, tags: ["style"] }), /content or priority/u);
  await assert.rejects(h.call("memoria_edit", { id, content: "must not persist", expected_revision: 1 }), /expected_content/u);
  await assert.rejects(h.call("memoria_edit", { id, content: "must not persist", expected_content: "stale content" }), /changed/u);
  const changed = h.prompt();
  await h.dispatch("before_agent_start", changed);
  assert.match(h.section(changed), /beep_boop twice/u);
  const opaque = h.prompt();
  opaque.systemPromptOptions.forceSystemPrompt = "base prompt";
  const forced = await h.dispatch("before_agent_start", opaque) as { systemPrompt: string };
  assert.ok(forced.systemPrompt.startsWith("base prompt"));
  assert.match(forced.systemPrompt, /beep_boop twice/u);
  await h.dispatch("session_shutdown");
  await h.dispatch("session_shutdown");
  await h.dispatch("session_start");
  assert.equal((await h.call("memoria_search", { query: "pears" })).details.results.length, 1);
  await h.call("memoria_delete", { id: fact.details.memory.id, expected_revision: 2 });
  await h.call("memoria_delete", { id });
  assert.equal(await readFile(join(h.memoryDir, "MEMORY.md"), "utf8"), "");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.call("memoria_add", { content: "must not persist" }, controller.signal), /abort/iu);
  assert.equal((await h.call("memoria_search", {})).details.results.length, 0);
});

for (const unavailable of [false, true]) {
  test(`Pi loader uses managed-only rg with ${unavailable ? "unavailable" : "available"} SQLite`, { skip: process.platform === "win32" }, async (t) => {
    const h = await harness(t);
    if (unavailable) await mkdir(join(h.memoryDir, "memoria.sqlite"), { recursive: true });
    await h.dispatch("session_start");
    const bin = join(h.agentDir, "bin");
    await mkdir(bin);
    const entry = { type: "message", id: "managed-only", message: { role: "user", content: "fruit preference" } };
    const event = { type: "match", data: { path: { text: h.sessionFile }, line_number: 1, lines: { text: JSON.stringify(entry) + "\n" } } };
    await writeFile(join(bin, "rg"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")});\n`, { mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const page = await h.call("memoria_sessions", { query: "fruit preference" });
      assert.equal(page.details.results[0].entry_id, "managed-only");
      assert.equal(page.details.exhausted, !unavailable);
      assert.equal(page.details.warnings.some((warning: string) => warning.includes("SQLite unavailable")), unavailable);
      await assert.rejects(stat(join(h.memoryDir, "bin")), { code: "ENOENT" });
    } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
  });
}

test("structured and forced prompts separate instructions from fresh hot memory and preserve the addendum", async (t) => {
  const h = await harness(t);
  await h.dispatch("session_start");
  const empty = await h.renderPrompt();
  const emptyMemory = block(empty.rendered, "pi_memoria");
  assert.match(block(emptyMemory, "hot_memory"), /Global MEMORY\.md \(0\/5000 characters;/u);
  assert.match(block(emptyMemory, "hot_memory"), /\n\(empty\)$/u);
  assert.doesNotMatch(emptyMemory, /<status>/u);

  const manual = "- [h_fresh0000000000] [p=90] Fresh standing instruction.\n";
  await writeFile(join(h.memoryDir, "MEMORY.md"), manual);
  const fresh = await h.renderPrompt();
  assert.equal(fresh.options.appendSystemPrompt, "Eve addendum fixture.");
  assert.equal(block(fresh.rendered, "addendum"), "Eve addendum fixture.");
  assert.equal(fresh.options.sections.other, "preserve me");
  assert.equal(block(fresh.rendered, "other"), "preserve me");
  const memory = block(fresh.rendered, "pi_memoria");
  assert.equal(memory, fresh.options.sections.pi_memoria);
  const instructions = block(memory, "instructions");
  assert.match(instructions, /standing instructions.*not merely quoted reference material/u);
  assert.match(instructions, /subject to higher-priority instructions/u);
  assert.match(instructions, /Resolve conflicting memories from current user instructions and original evidence/u);
  const hot = block(memory, "hot_memory");
  assert.equal(hot, `Global MEMORY.md (${manual.length}/5000 characters; ${join(h.memoryDir, "MEMORY.md")}):\n${manual}`);
  assert.doesNotMatch(instructions, /Fresh standing instruction\./u);
  assert.doesNotMatch(hot, /Before saving a durable fact/u);
  const save = h.extension.tools.get("memoria_add")!.definition.promptGuidelines!;
  assert.equal(save.length, 1);
  assert.match(save[0]!, /^Before saving a durable fact/u);

  await writeFile(join(h.memoryDir, "MEMORY.md"), manual.replace("Fresh", "Changed"));
  const forcedBase = "Opaque prompt.\n<addendum>\nEve addendum fixture.\n</addendum>";
  const forced = await h.renderPrompt(forcedBase);
  assert.ok(forced.rendered.startsWith(`${forcedBase}\n\n<pi_memoria>`));
  assert.equal(block(forced.rendered, "pi_memoria"), forced.options.sections.pi_memoria);
  assert.match(block(forced.rendered, "hot_memory"), /Changed standing instruction/u);
  assert.doesNotMatch(forced.rendered, /Fresh standing instruction/u);
  assert.equal(block(forced.rendered, "addendum"), "Eve addendum fixture.");
});

test("failed hot loads report status without fabricating empty or valid hot memory, and recover on the next read", async (t) => {
  const h = await harness(t);
  await mkdir(join(h.memoryDir, "MEMORY.md"), { recursive: true });
  await mkdir(join(h.memoryDir, "memoria.sqlite"));
  await h.dispatch("session_start");
  const failed = await h.renderPrompt("Opaque prompt.");
  const memory = block(failed.rendered, "pi_memoria");
  block(memory, "instructions");
  const status = block(memory, "status");
  assert.match(status, /MEMORY UNAVAILABLE:.*Hot instructions were not loaded; tell the user and do not assume that memory is empty/u);
  assert.match(status, /SQLITE LONG-TERM MEMORY UNAVAILABLE/u);
  assert.match(status, /remembered custom roots may be missing/u);
  assert.doesNotMatch(memory, /<hot_memory>|\(empty\)|Hot memory above remains valid/u);

  await rm(join(h.memoryDir, "MEMORY.md"), { recursive: true });
  await writeFile(join(h.memoryDir, "MEMORY.md"), "- [h_recover00000000] [p=90] Recovered startup rule.\n");
  const recovered = await h.renderPrompt();
  assert.match(block(recovered.rendered, "hot_memory"), /Recovered startup rule/u);
  assert.doesNotMatch(block(recovered.rendered, "status"), /Hot instructions were not loaded/u);
  assert.match(block(recovered.rendered, "status"), /Any successfully loaded hot memory remains valid/u);
});

test("startup and prompt-time oversized repairs report archival counts and backups separately from hot instructions", async (t) => {
  const h = await harness(t);
  await mkdir(h.memoryDir, { recursive: true });
  const oversized = `- [h_low000000000000] [p=10] ${"L".repeat(3000)}\n- [h_high00000000000] [p=90] ${"H".repeat(3000)}\n`;
  await writeFile(join(h.memoryDir, "MEMORY.md"), oversized);
  await h.dispatch("session_start");
  for (const force of [undefined, "Opaque prompt."]) {
    if (force) await writeFile(join(h.memoryDir, "MEMORY.md"), oversized);
    const repaired = await h.renderPrompt(force);
    const status = block(repaired.rendered, "status");
    assert.match(status, /Repaired an oversized manual edit: 1 bullets archived to SQLite; original backup:/u);
    const backup = /original backup: (.+)\.$/u.exec(status)![1]!;
    assert.equal(await readFile(backup, "utf8"), oversized);
    const hot = block(repaired.rendered, "hot_memory");
    assert.match(hot, /h_high00000000000/u);
    assert.doesNotMatch(hot, /h_low000000000000|Repaired an oversized/u);
    assert.match(hot, /\(\d+\/5000 characters;/u);
    const clean = await h.renderPrompt();
    assert.doesNotMatch(clean.rendered, /<status>|Repaired an oversized manual edit/u);
  }
  const archived = await h.call("memoria_search", { tags: ["hot-archive"] });
  assert.ok(archived.details.results.length > 0);
});

test("valid hot memory loads and hot-only operations work when SQLite cannot open", async (t) => {
  const h = await harness(t);
  await mkdir(join(h.memoryDir, "memoria.sqlite"), { recursive: true });
  await writeFile(join(h.memoryDir, "MEMORY.md"), "- [h_startup00000000] [p=90] Startup rule from manual memory.\n");
  // Direct tool invocation without a preceding session_start.
  const direct = await h.call("memoria_add", { store: "hot", content: "Directly added rule." });
  assert.equal(direct.details.created, true);
  assert.equal(direct.details.store, "hot");
  const edited = await h.call("memoria_edit", { id: direct.details.memory.id, content: "Directly edited rule." });
  assert.equal(edited.details.memory.content, "Directly edited rule.");
  await h.call("memoria_delete", { id: direct.details.memory.id });

  await h.dispatch("session_start");
  const injected = h.prompt();
  await h.dispatch("before_agent_start", injected);
  assert.match(h.section(injected), /Startup rule from manual memory\./u);
  assert.match(h.section(injected), /SQLITE LONG-TERM MEMORY UNAVAILABLE/u);
  assert.doesNotMatch(h.section(injected), /Hot instructions were not loaded/u);
  const opaque = h.prompt();
  opaque.systemPromptOptions.forceSystemPrompt = "base prompt";
  const forced = await h.dispatch("before_agent_start", opaque) as { systemPrompt: string };
  assert.match(forced.systemPrompt, /Startup rule from manual memory\./u);

  await assert.rejects(h.call("memoria_add", { content: "A long-term fact." }), (error: Error) => /\[store_unavailable\]/u.test(error.message) && /memoria\.sqlite/u.test(error.message));
  const fallback = await h.call("memoria_sessions", { query: "fruit preference" });
  assert.equal(fallback.details.results.length, 1);
  assert.equal(fallback.details.exhausted, false);
  assert.ok(fallback.details.warnings.some((value: string) => value.includes("SQLite unavailable")));
  assert.match(fallback.text, /warning: SQLite unavailable/u);

  // Correct the temporary problem: a later database-dependent call recovers without reloading.
  await rm(join(h.memoryDir, "memoria.sqlite"), { recursive: true, force: true });
  const recovered = await h.call("memoria_add", { content: "A long-term fact after recovery." });
  assert.equal(recovered.details.created, true);
  assert.equal((await h.call("memoria_search", { query: "recovery" })).details.results[0].id, recovered.details.memory.id);
  const clean = h.prompt();
  await h.dispatch("before_agent_start", clean);
  assert.doesNotMatch(h.section(clean), /SQLITE LONG-TERM MEMORY UNAVAILABLE/u);
  await h.dispatch("session_shutdown");
  await h.dispatch("session_shutdown");
  await h.dispatch("session_start");
  assert.equal((await h.call("memoria_search", { query: "recovery" })).details.results[0].id, recovered.details.memory.id);
});

test("archive-requiring hot failures leave the live file byte-for-byte unchanged", async (t) => {
  const h = await harness(t);
  await mkdir(join(h.memoryDir, "memoria.sqlite"), { recursive: true });
  const low = await h.call("memoria_add", { store: "hot", content: "low ".repeat(700), priority: 10 });
  const before = await readFile(join(h.memoryDir, "MEMORY.md"), "utf8");
  await assert.rejects(h.call("memoria_add", { store: "hot", content: "high ".repeat(600), priority: 90 }), /\[store_unavailable\]/u);
  assert.equal(await readFile(join(h.memoryDir, "MEMORY.md"), "utf8"), before);

  // Oversized manual repair also fails without replacing the live file.
  const manual = `- ${"first".repeat(650)}\n- ${"second".repeat(650)}\n`;
  await writeFile(join(h.memoryDir, "MEMORY.md"), manual);
  const event = h.prompt();
  await h.dispatch("before_agent_start", event);
  assert.match(block(h.section(event), "status"), /MEMORY UNAVAILABLE/u);
  assert.doesNotMatch(h.section(event), /<hot_memory>|\(empty\)|Hot memory above remains valid/u);
  assert.equal(await readFile(join(h.memoryDir, "MEMORY.md"), "utf8"), manual);
  assert.equal(low.details.memory.priority, 10);
});

test("compact responses render changes once while details retain the full result", async (t) => {
  const h = await harness(t);
  await h.dispatch("session_start");
  const added = await h.call("memoria_add", { store: "hot", content: "A single startup rule.", priority: 60, tags: ["style"], source: "instruction" });
  assert.equal(occurrences(added.text, "A single startup rule."), 1);
  assert.equal(added.details.memory.content, "A single startup rule.");
  assert.equal(added.details.created, true);
  assert.match(added.text, /created=true/u);
  assert.match(added.text, /budget: \d+\/5000 characters used/u);
  assert.match(added.text, /ignored_fields: tags, source/u);
  const duplicate = await h.call("memoria_add", { store: "hot", content: "A single startup rule.", priority: 99 });
  assert.equal(duplicate.details.created, false);
  assert.match(duplicate.text, /created=false/u);
  assert.match(duplicate.text, /Reused existing hot memory/u);
  assert.equal(duplicate.details.memory.priority, 60);
  assert.equal(occurrences(duplicate.text, "A single startup rule."), 1);

  const low = await h.call("memoria_add", { store: "hot", content: "L".repeat(3_000), priority: 10 });
  const high = await h.call("memoria_add", { store: "hot", content: "H".repeat(3_000), priority: 90 });
  assert.deepEqual(high.details.archived.map((entry: { id: string }) => entry.id), [low.details.memory.id]);
  assert.match(high.text, /archived: h_/u);
  assert.match(high.text, /hot-archive/u);

  const removed = await h.call("memoria_delete", { id: high.details.memory.id });
  assert.match(removed.text, /memoria_delete: hot/u);
  assert.equal(occurrences(removed.text, "H".repeat(3_000)), 1);
  assert.match(removed.text, /budget: \d+\/5000/u);
});

test("clipped SQLite search keeps continuation and spills the complete payload", async (t) => {
  const h = await harness(t);
  await h.dispatch("session_start");
  for (let i = 0; i < 50; i++) {
    await h.call("memoria_add", { content: `bulk row ${String(i).padStart(2, "0")} ${"x".repeat(900)}`, tags: ["bulk", `UNIQUEMARKER${i}`] });
  }
  const page = await h.call("memoria_search", { query: "bulk", limit: 49 });
  assert.ok(Buffer.byteLength(page.text) <= 32_000, `clipped text must fit the budget (${Buffer.byteLength(page.text)})`);
  assert.equal(page.details.results.length, 49);
  assert.match(page.text, /next_offset=49/u);
  assert.match(page.text, /Response clipped/u);
  const path = /at (\/\S+\/result\.json)/u.exec(page.text)?.[1];
  assert.ok(path, "the clipped response must point to a real spill file");
  const spilled = JSON.parse(await readFile(path!, "utf8"));
  assert.deepEqual(spilled, page.details);
  assert.equal(spilled.results.length, 49);
  assert.ok(spilled.results.some((row: { tags: string[] }) => row.tags.some((tag) => tag.startsWith("UNIQUEMARKER"))), "the spilled payload must contain the complete rows");
  const omitted = spilled.results.map((row: { tags: string[] }) => row.tags.find((tag) => tag.startsWith("UNIQUEMARKER"))).filter((marker: string) => !page.text.includes(marker));
  assert.ok(omitted.length > 0, "at least one complete row must be omitted from the model-facing text");
});

test("multibyte output clips within the byte budget without replacement characters", async (t) => {
  const h = await harness(t);
  await h.dispatch("session_start");
  for (let i = 0; i < 40; i++) await h.call("memoria_add", { content: `🚀 café 東京 ${i} ${"🌍".repeat(500)}` });
  const page = await h.call("memoria_search", { query: "", limit: 50 });
  assert.ok(Buffer.byteLength(page.text) <= 32_000, `clipped text must fit the budget (${Buffer.byteLength(page.text)})`);
  assert.ok(!page.text.includes("\uFFFD"), "clipping must not introduce replacement characters");
  assert.match(page.text, /Response clipped/u);
});

test("clipped session output keeps incomplete status, citations, and continuation fields", async (t) => {
  const h = await harness(t);
  await h.dispatch("session_start");
  const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({
    type: "message", id: `long${i}`, parentId: i ? `long${i - 1}` : null, timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: `needle entry ${i} ${"y".repeat(1_200)}` },
  }));
  await writeFile(h.sessionFile, ['{"type":"message","broken":"needle"', ...lines].join("\n") + "\n");
  const page = await h.call("memoria_sessions", { query: "needle", limit: 50 });
  assert.ok(Buffer.byteLength(page.text) <= 32_000, `clipped text must fit the budget (${Buffer.byteLength(page.text)})`);
  assert.match(page.text, /exhausted=(true|false)/u);
  assert.match(page.text, /next_offset=/u);
  assert.match(page.text, /warning: .*malformed/u);
  assert.match(page.text, /a\.jsonl:\d+/u);
  assert.equal(typeof page.details.exhausted, "boolean");
});

test("public hot capacity failures and unexpected errors remain failed executions", async (t) => {
  const h = await harness(t);
  await h.dispatch("session_start");
  await h.call("memoria_add", { store: "hot", content: "kept rule" });
  await assert.rejects(h.call("memoria_add", { store: "hot", content: "x".repeat(6_000) }), (error: Error) => /\[hot_capacity\]/u.test(error.message) && /live file was not changed/u.test(error.message));
  assert.equal((await h.call("memoria_add", { store: "hot", content: "kept rule" })).details.created, false);
  await writeFile(join(h.directory, "outside.jsonl"), "{}\n");
  await assert.rejects(h.call("memoria_sessions", { action: "read", path: join(h.directory, "outside.jsonl") }), /inside a configured/u);
});

test("oversized error details stay within the byte budget and spill a readable file", async () => {
  const failure = await toolError(new ExpectedError("invalid_input", "oversized details", { payload: "e".repeat(40_000) })).catch((error): Error => error as Error);
  assert.ok(Buffer.byteLength(failure.message) <= 32_000, `error text must fit the budget (${Buffer.byteLength(failure.message)})`);
  assert.match(failure.message, /invalid_input/u);
  const path = /at (\S+\/result\.json)/u.exec(failure.message)?.[1];
  assert.ok(path, "the clipped error must point to a real spill file");
  assert.match(await readFile(path!, "utf8"), /eeee/u);
});

test("registered search exposes ordinary query options and combines exact tags with pagination", async (t) => {
  const h = await harness(t);
  const search = h.extension.tools.get("memoria_search")!.definition;
  assert.deepEqual(Object.keys((search.parameters as TObject).properties).sort(), ["query", "id", "mode", "limit", "offset", "text_offset", "tags"].sort());
  await h.dispatch("session_start");
  const cluster = await h.call("memoria_add", { content: "The Kubernetes cluster runs in fra1.", tags: ["infrastructure"] });
  const literal = await h.call("memoria_add", { content: "k8s runbook", tags: ["infrastructure", "ops"] });
  const page = await h.call("memoria_search", { query: "k8s" });
  assert.deepEqual(page.details.results.map((row: { id: string }) => row.id), [literal.details.memory.id]);
  assert.deepEqual(Object.keys(page.details).sort(), ["mode", "query", "tags", "results", "next_offset", "elapsed_ms", "hint"].sort());
  const combined = await h.call("memoria_search", { query: "k8s", tags: ["ops"] });
  assert.deepEqual(combined.details.results.map((row: { id: string }) => row.id), [literal.details.memory.id]);
  assert.match(combined.text, /required tags \(exact, case-sensitive\): ops/u);
  await assert.rejects(h.call("memoria_search", { id: cluster.details.memory.id, tags: ["ops"] }), /not to reading/u);
  const expected = [literal.details.memory.id];
  for (let i = 0; i < 4; i++) {
    const row = await h.call("memoria_add", { content: `k8s runbook ${i}`, tags: ["ops"] });
    expected.push(row.details.memory.id);
  }
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await h.call("memoria_search", { query: "k8s", tags: ["ops"], limit: 2, offset });
    seen.push(...result.details.results.map((row: { id: string }) => row.id));
    offset = result.details.next_offset;
  }
  assert.deepEqual(seen.sort(), expected.sort());
});

test("retired terminology configuration is ignored and shorthand survives as ordinary saved memory", async (t) => {
  const h = await harness(t);
  await mkdir(h.memoryDir, { recursive: true });
  // Historical configuration only: no loader or search behavior may depend on it.
  const retiredPath = join(h.memoryDir, "synonyms.json");
  const retiredContents = '{"k8s": ["kubernetes"], "piem": ["monorepo"]}';
  await writeFile(retiredPath, retiredContents);
  await h.dispatch("session_start");
  await h.call("memoria_add", { content: "Kubernetes cluster configuration.", tags: ["projects"] });
  await h.call("memoria_add", { content: "The pi-extensions monorepo has four packages.", tags: ["projects"] });
  const shorthand = await h.call("memoria_add", { content: "The user's shorthand piem refers to the pi-extensions monorepo.", tags: ["projects", "terminology"] });
  assert.equal((await h.call("memoria_search", { query: "k8s" })).details.results.length, 0);
  const page = await h.call("memoria_search", { query: "piem" });
  assert.deepEqual(page.details.results.map((row: { id: string }) => row.id), [shorthand.details.memory.id]);
  assert.doesNotMatch(page.text, /warning:/u);
  await writeFile(retiredPath, "{not valid JSON");
  await h.dispatch("session_shutdown");
  await h.dispatch("session_start");
  const reopened = await h.call("memoria_search", { query: "piem", tags: ["terminology"] });
  assert.deepEqual(reopened.details.results.map((row: { id: string }) => row.id), [shorthand.details.memory.id]);
  assert.deepEqual((await h.call("memoria_search", { id: shorthand.details.memory.id })).details, {
    ...shorthand.details.memory, next_text_offset: null, total_characters: shorthand.details.memory.content.length,
  });
  assert.doesNotMatch(reopened.text, /warning:/u);
  assert.equal(await readFile(retiredPath, "utf8"), "{not valid JSON", "retired files are neither managed nor modified");
  const prompt = h.prompt();
  await h.dispatch("before_agent_start", prompt);
  assert.match(h.section(prompt), /Save personal shorthand as ordinary SQLite facts/u);
});

test("full records remain reconstructable through text offsets after clipping", async (t) => {
  const h = await harness(t);
  await h.dispatch("session_start");
  const content = "reconstruct ".repeat(1_200) + "TAIL";
  const added = await h.call("memoria_add", { content });
  let offset: number | null = 0;
  let rebuilt = "";
  while (offset !== null) {
    const part = await h.call("memoria_search", { id: added.details.memory.id, text_offset: offset });
    rebuilt += part.details.content;
    offset = part.details.next_text_offset;
  }
  assert.equal(rebuilt, content);

  const long = `session body ${"z".repeat(9_000)} end of entry`;
  await writeFile(h.sessionFile, JSON.stringify({ type: "message", id: "long-read", message: { role: "user", content: long } }) + "\n");
  let sessionOffset: number | null = 0;
  let sessionText = "";
  while (sessionOffset !== null) {
    const part = await h.call("memoria_sessions", { action: "read", path: h.sessionFile, line: 1, text_offset: sessionOffset });
    sessionText += part.details.text;
    sessionOffset = part.details.next_text_offset;
  }
  assert.ok(sessionText.includes(long));
});
