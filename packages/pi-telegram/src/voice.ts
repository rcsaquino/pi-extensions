import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SafeError } from "./config.ts";
import { telegramFormat } from "./format.ts";

/** Bracketed v4 performance directions are atomic, not words to split between requests. */
export function speechChunks(text: string, modelId: string, limit = 1800): string[] {
  text = telegramFormat(text.replace(/<break\b[^>]*\/?\s*>/gi, "[pause]")).text.trim();
  if (!text) throw new SafeError("Speech text cannot be empty.");
  if (/^eleven_v4(?:_turbo)?$/.test(modelId) && !/\[(?!REDACTED\]|Attachment\/s\]|Transcription\])[^\]\n]{1,100}\]/.test(text)) {
    text = `[warm, composed voice] ${text}`;
  }
  const prefix = text.match(/^(?:\[[^\]\n]+\]\s*)+/)?.[0] || "";
  if (prefix.length >= limit / 2) throw new SafeError("Speech opening tags are too long.");
  const chunks: string[] = [];
  while (text) {
    const lead = chunks.length ? prefix : "";
    const budget = limit - lead.length;
    let end = Math.min(budget, text.length);
    if (end < text.length) {
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const paragraph = text.lastIndexOf("\n\n", end);
      const word = Math.max(text.lastIndexOf(" ", end), text.lastIndexOf("\n", end));
      if (paragraph > budget / 2) end = paragraph;
      else if (word > budget / 2) end = word;
      // Back up if a cut landed inside a tag, including a whitespace-based boundary.
      for (const match of text.matchAll(/\[[^\]\n]*\]/g)) {
        if (match.index! < end && match.index! + match[0].length > end) { end = match.index!; break; }
      }
      if (end <= 0) throw new SafeError("An audio tag exceeds the speech chunk limit.");
    }
    const part = text.slice(0, end).trim();
    if (part) chunks.push(lead + part);
    text = text.slice(end).trimStart();
  }
  return chunks;
}

export function isOpus(data: Buffer): boolean {
  return data.subarray(0, 4).toString() === "OggS" && data.subarray(0, 1024).includes(Buffer.from("OpusHead"));
}

/** Remux/re-encode long generations into one Telegram voice message, never a chain of replies. */
export async function joinSpeech(parts: Buffer[], tmpDir: string, signal: AbortSignal): Promise<Buffer> {
  if (parts.length === 1) return parts[0];
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(resolve(tmpDir, "speech-"));
  try {
    await Promise.all(parts.map((data, index) => writeFile(resolve(dir, `part-${index}.ogg`), data, { mode: 0o600 })));
    await writeFile(resolve(dir, "parts.txt"), parts.map((_, index) => `file 'part-${index}.ogg'`).join("\n"), { mode: 0o600 });
    await new Promise<void>((done, reject) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "1", "-i", "parts.txt", "-vn", "-c:a", "libopus", "-ar", "48000", "-b:a", "64k", "reply.ogg"], {
        cwd: dir, stdio: "ignore", signal, timeout: 120_000,
      });
      child.once("error", () => reject(new SafeError(signal.aborted ? "Speech generation cancelled." : "Combining long voice messages requires ffmpeg.")));
      child.once("close", code => code === 0 ? done() : reject(new SafeError("Unable to combine the generated voice message.")));
    });
    const data = await readFile(resolve(dir, "reply.ogg"));
    if (!isOpus(data)) throw new SafeError("Combined speech is not OGG/Opus.");
    return data;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
