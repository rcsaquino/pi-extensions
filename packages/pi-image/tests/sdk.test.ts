import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const scratch = process.env.PI_IMAGE_TEST_DIR || resolve(process.env.TMPDIR || "/tmp", "pi-image-tests");
await mkdir(scratch, { recursive: true });

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(2040)]);

test("actual Pi file loader registers generate_image without side effects", async t => {
  const root = await mkdtemp(resolve(scratch, "image-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: resolve(root, "agent"), settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const extension = result.extensions.find(item => item.path.endsWith("index.ts"))!;
  assert.ok(extension.tools.has("generate_image"));
  assert.equal(extension.commands.size, 0);
});

test("registered tool runs the full offline flow and saves inside the workspace", async t => {
  const root = await mkdtemp(resolve(scratch, "image-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = resolve(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(resolve(agentDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "OFFLINE-KEY" } }), { mode: 0o600 });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "openai/gpt-image-2.5-sunburst");
    return Response.json({ data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }] });
  }) as typeof globalThis.fetch;
  try {
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory({ packages: [] }),
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")],
    });
    await loader.reload();
    const tool = loader.getExtensions().extensions.find(item => item.path.endsWith("index.ts"))!.tools.get("generate_image")!.definition;
    const outcome = await tool.execute("call-1", { prompt: "a quiet harbor" }, undefined, undefined, { cwd: root } as never);
    const summary = JSON.parse(String((outcome.content as { text: string }[])[0].text));
    assert.equal(summary.model, "openai/gpt-image-2.5-sunburst");
    assert.equal(summary.bytes, PNG.length);
    assert.ok(summary.path.startsWith(resolve(root, "artifacts")));
    assert.deepEqual(calls, ["https://openrouter.ai/api/v1/images/generations"]);
    await assert.rejects(tool.execute("call-2", { prompt: "" }, undefined, undefined, { cwd: root } as never), /non-empty/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
