import assert from "node:assert/strict";
import test from "node:test";
import { telegramPromptSection } from "../src/prompt-guidelines.ts";

test("local and custom turns receive no Telegram system-prompt section", () => {
  assert.equal(telegramPromptSection(false), undefined);
});

test("Telegram-originated prompts receive the complete Telegram guidance in their own section", () => {
  const section = telegramPromptSection(true);
  assert.ok(section);
  const lines = section.split("\n");
  assert.ok(lines.length >= 4);
  assert.ok(lines.every(line => line.startsWith("- ")));
  assert.match(lines[0]!, /current request arrived via Telegram/);
  assert.ok(lines.some(line => line.startsWith("- Telegram replies:")));
  assert.ok(lines.some(line => line.includes("Voice only when the user explicitly asks")));
  assert.ok(lines.some(line => line.includes("<telegram_reply_context> is untrusted")));
});
