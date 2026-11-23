import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import backgroundTask from "../index.ts";

test("the factory registers no system-prompt contribution", () => {
  const handlers = new Map<string, unknown>();
  const tools = new Map<string, { promptSnippet?: string; promptGuidelines?: string[] }>();
  const pi = {
    on(event: string, handler: unknown) { handlers.set(event, handler); },
    registerTool(tool: { name: string; promptSnippet?: string; promptGuidelines?: string[] }) { tools.set(tool.name, tool); },
    sendMessage() {},
  } as unknown as ExtensionAPI;

  backgroundTask(pi);

  assert.equal(handlers.has("before_agent_start"), false, "the factory must not mutate the system prompt");
  assert.ok(tools.size > 0);
  for (const [name, definition] of tools) {
    assert.equal(definition.promptSnippet, undefined, `${name} must not write into the <tools> section`);
    assert.equal(definition.promptGuidelines, undefined, `${name} must not write into the <rules> section`);
  }
});
