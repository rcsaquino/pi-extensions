import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ExpectedError } from "../src/errors.ts";
import { toolError } from "../src/results.ts";
import { temporary } from "./helpers.ts";

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
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
  const ctx = {
    cwd: directory, hasUI: false,
    sessionManager: { getSessionDir: () => root, getSessionFile: () => sessionFile, getLeafId: () => "entry" },
  } as unknown as ExtensionContext;
  const dispatch = async (name: string, event: unknown = {}) => {
    let result: unknown;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  t.after(() => dispatch("session_shutdown"));
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await extension.tools.get(name)!.definition.execute("test", args, signal, undefined, ctx);
    const text = result.content.map((part) => part.type === "text" ? part.text : "").join("");
    return { result, details: result.details as Record<string, any>, text };
  };
  const prompt = () => ({ systemPrompt: "base prompt", systemPromptOptions: { sections: { other: "preserve me" } as Record<string, string>, forceSystemPrompt: undefined as string | undefined } });
  const section = (event: ReturnType<typeof prompt>) => (event.systemPromptOptions.sections as Record<string, string>).pi_memoria!;
  return { directory, agentDir, memoryDir, root, sessionFile, extension, dispatch, call, prompt, section };
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
  assert.match(h.section(event), /MEMORY UNAVAILABLE/u);
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

test("clipped SQLite search keeps continuation and warnings and spills the complete payload", async (t) => {
  const h = await harness(t);
  await mkdir(h.memoryDir, { recursive: true });
  await writeFile(join(h.memoryDir, "synonyms.json"), "{\"k8s\": ");
  await h.dispatch("session_start");
  for (let i = 0; i < 50; i++) {
    await h.call("memoria_add", { content: `bulk row ${String(i).padStart(2, "0")} ${"x".repeat(900)}`, tags: ["bulk", `UNIQUEMARKER${i}`] });
  }
  const page = await h.call("memoria_search", { query: "bulk", limit: 49 });
  assert.ok(Buffer.byteLength(page.text) <= 32_000, `clipped text must fit the budget (${Buffer.byteLength(page.text)})`);
  assert.equal(page.details.results.length, 49);
  assert.match(page.text, /next_offset=49/u);
  assert.match(page.text, /warning: synonyms\.json is not valid JSON/u);
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

test("registered search expands aliases and combines exact tags with pagination", async (t) => {
  const h = await harness(t);
  await mkdir(h.memoryDir, { recursive: true });
  await writeFile(join(h.memoryDir, "synonyms.json"), JSON.stringify({ k8s: ["kubernetes"], prefs: [] }));
  await h.dispatch("session_start");
  const cluster = await h.call("memoria_add", { content: "The Kubernetes cluster runs in fra1.", tags: ["infrastructure"] });
  const literal = await h.call("memoria_add", { content: "k8s runbook", tags: ["infrastructure", "ops"] });
  const disabled = await h.call("memoria_search", { query: "k8s", expand_aliases: false });
  assert.deepEqual(disabled.details.results.map((row: { id: string }) => row.id), [literal.details.memory.id]);
  const expanded = await h.call("memoria_search", { query: "k8s" });
  assert.deepEqual(expanded.details.results.map((row: { id: string }) => row.id).sort(), [cluster.details.memory.id, literal.details.memory.id].sort());
  assert.match(expanded.text, /aliases used in query: k8s -> kubernetes/u);
  const combined = await h.call("memoria_search", { query: "k8s", tags: ["ops"] });
  assert.deepEqual(combined.details.results.map((row: { id: string }) => row.id), [literal.details.memory.id]);
  assert.match(combined.text, /required tags \(exact, case-sensitive\): ops/u);
  assert.equal((await h.call("memoria_search", { query: "prefs" })).details.results.length, 0, "the user file disables the built-in prefs mapping");
  await assert.rejects(h.call("memoria_search", { id: cluster.details.memory.id, tags: ["ops"] }), /not to reading/u);
  await assert.rejects(h.call("memoria_search", { id: cluster.details.memory.id, expand_aliases: false }), /not to reading/u);
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
