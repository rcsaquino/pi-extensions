import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { skillText } from "./helpers.ts";

test("Pi loads the package, registers one tool and works end to end against isolated roots", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "psw-loader-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "skills");
  const state = join(base, "state");
  const agentDir = join(base, "agent");
  await mkdir(agentDir);

  const previousRoot = process.env.PI_SKILL_WORKSHOP_ROOT;
  const previousState = process.env.PI_SKILL_WORKSHOP_STATE;
  process.env.PI_SKILL_WORKSHOP_ROOT = root;
  process.env.PI_SKILL_WORKSHOP_STATE = state;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PI_SKILL_WORKSHOP_ROOT;
    else process.env.PI_SKILL_WORKSHOP_ROOT = previousRoot;
    if (previousState === undefined) delete process.env.PI_SKILL_WORKSHOP_STATE;
    else process.env.PI_SKILL_WORKSHOP_STATE = previousState;
  });

  const loader = new DefaultResourceLoader({
    cwd: base,
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")],
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((candidate) => candidate.path.endsWith("index.ts"));
  assert.ok(extension, "the package entry must load");
  assert.deepEqual([...extension.tools.keys()], ["skill_workshop"]);
  await assert.rejects(access(root), { code: "ENOENT" }, "loading the factory must not create the skill root");
  await assert.rejects(access(state), { code: "ENOENT" }, "loading the factory must not create state");

  const definition = extension.tools.get("skill_workshop")!.definition;
  const schema = JSON.stringify(definition.parameters);
  for (const action of ["list", "view", "create", "patch", "write_file", "remove_file", "archive", "restore", "undo", "changes", "cleanup"]) {
    assert.match(schema, new RegExp(`"${action}"`), `missing action ${action}`);
  }
  const guidelines = (definition as { promptGuidelines?: string[] }).promptGuidelines ?? [];
  assert.ok(guidelines.some((line) => line.includes("durable lessons")), "purpose guideline is missing");
  assert.ok(guidelines.some((line) => line.includes("at most one skill")), "one-change guideline is missing");
  assert.ok(guidelines.some((line) => line.includes("self-contained")), "self-containment guideline is missing");
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const result = await definition.execute("test-call", args as never, undefined, undefined, undefined as never);
    return result.content.map((part) => part.type === "text" ? part.text : "").join("");
  };

  const original = skillText();
  assert.equal(await call({ action: "create", name: "alpha", content: original, reason: "loader test" }), "created alpha");
  assert.match(await call({ action: "list" }), /alpha/);
  assert.equal(await call({ action: "view", name: "alpha" }), original);
  assert.match(await call({ action: "patch", name: "alpha", old: "Body.", new: "Changed." }), /patched alpha\/SKILL\.md/);
  assert.match(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), /Changed\./);
  assert.match(await call({ action: "undo" }), /undid patch of alpha/);
  assert.equal(await readFile(join(root, "alpha", "SKILL.md"), "utf8"), original);
  assert.match(await call({ action: "write_file", name: "alpha", path: "references/note.txt", content: "note" }), /wrote alpha\/references\/note\.txt/);
  assert.equal(await readFile(join(root, "alpha", "references", "note.txt"), "utf8"), "note");
  const feed = await call({ action: "changes", limit: 5 });
  assert.match(feed.split("\n")[0] ?? "", /write_file/);
  await assert.rejects(() => call({ action: "restore", name: "alpha" }), /already live/);
});
