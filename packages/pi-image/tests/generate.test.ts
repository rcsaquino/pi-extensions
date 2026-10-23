import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { agentDir, readOpenRouterKey } from "../src/auth.ts";
import { assertSafeDownloadUrl, generateImageBytes, isPrivateAddress } from "../src/client.ts";
import { redactKey, safeError, SafeError } from "../src/errors.ts";
import { detectSavedMime, saveImage, slugify } from "../src/files.ts";
import { MAX_REFERENCE_TOTAL_BYTES, readReferenceImages, resolveOutputPath, validateModel, validatePrompt, validateSize } from "../src/validate.ts";

const scratch = process.env.PI_IMAGE_TEST_DIR || resolve(process.env.TMPDIR || "/tmp", "pi-image-tests");
await mkdir(scratch, { recursive: true });

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_MAGIC = Buffer.from([255, 216, 255, 0]);
/** Minimal fake raster bytes: real magic plus padding past the usability floor. */
function fakePng(bytes = 2048): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(bytes - PNG_MAGIC.length)]);
}
function fakeJpeg(bytes = 2048): Buffer {
  return Buffer.concat([JPEG_MAGIC, Buffer.alloc(bytes - JPEG_MAGIC.length)]);
}
const imageJson = (b64: string, mediaType = "image/png") => Response.json({ data: [{ b64_json: b64, media_type: mediaType }] });
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("txt2img success posts JSON to the Images endpoint and saves verified bytes", async t => {
  const root = await mkdtemp(join(scratch, "txt2img-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return imageJson(fakePng().toString("base64"));
  }) as typeof globalThis.fetch;
  const generated = await generateImageBytes({ key: "TEST-KEY", model: "openai/gpt-image-2.5-sunburst", prompt: "a red circle" }, fetch);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/images/generations");
  assert.equal(seen[0].init.method, "POST");
  assert.equal((seen[0].init.headers as Record<string, string>)["authorization"], "Bearer TEST-KEY");
  const body = JSON.parse(String(seen[0].init.body));
  assert.equal(body.model, "openai/gpt-image-2.5-sunburst");
  assert.equal(body.prompt, "a red circle");
  assert.ok(!("input_references" in body));
  const saved = await saveImage(join(root, "artifacts"), generated.data, "A Red Circle!!");
  assert.equal(saved.mime, "image/png");
  assert.equal(saved.bytes, 2048);
  assert.match(saved.path, /artifacts\/image-a-red-circle-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  assert.deepEqual(await readFile(saved.path), generated.data);
  assert.equal((await stat(saved.path)).mode & 0o777 & 0o077, 0);
});

test("img2img encodes workspace references as input_references data URLs", async t => {
  const root = await mkdtemp(join(scratch, "img2img-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "ref-one.png"), fakePng());
  await writeFile(join(root, "ref-two.jpg"), fakeJpeg());
  const references = await readReferenceImages(root, ["ref-one.png", "ref-two.jpg"]);
  assert.equal(references.length, 2);
  assert.ok(references[0].dataUrl.startsWith("data:image/png;base64,"));
  assert.ok(references[1].dataUrl.startsWith("data:image/jpeg;base64,"));
  let captured: Record<string, unknown> = {};
  const fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    return imageJson(fakeJpeg().toString("base64"), "image/jpeg");
  }) as typeof globalThis.fetch;
  const generated = await generateImageBytes({ key: "K", model: "m", prompt: "edit", size: "1024x1024", references }, fetch);
  assert.equal((captured["input_references"] as unknown[]).length, 2);
  assert.equal(captured["size"], "1024x1024");
  const saved = await saveImage(root, generated.data, "edit");
  assert.match(saved.path, /\.jpg$/);
});

test("url fallback downloads without credentials and rejects non-images", async t => {
  const image = fakePng();
  const fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("images/generations")) return Response.json({ data: [{ url: "https://cdn.example/x.png", media_type: "image/png" }] });
    assert.equal((init?.headers as Record<string, string> | undefined)?.["authorization"], undefined);
    return new Response(new Uint8Array(image), { headers: { "content-type": "image/png" } });
  }) as typeof globalThis.fetch;
  const ok = await generateImageBytes({ key: "K", model: "m", prompt: "p" }, fetch, publicLookup);
  assert.deepEqual(ok.data, image);
  const bad = (async (url: string) => {
    if (String(url).includes("images/generations")) return Response.json({ data: [{ url: "https://cdn.example/x.txt" }] });
    return new Response("nope", { headers: { "content-type": "text/plain" } });
  }) as typeof globalThis.fetch;
  await assert.rejects(generateImageBytes({ key: "K", model: "m", prompt: "p" }, bad, publicLookup), /did not return image bytes/);
});

test("credentials resolve .env first, then environment, then stored login, and fail closed when missing", async t => {
  const root = await mkdtemp(join(scratch, "auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const empty = join(root, "empty");
  await assert.rejects(readOpenRouterKey(empty, empty, {}), /OPENROUTER_API_KEY in \.env/);
  await writeFile(join(root, "auth.json"), JSON.stringify({ openrouter: { type: "api_key" } }));
  await assert.rejects(readOpenRouterKey(root, root, {}), /OPENROUTER_API_KEY in \.env/);
  await writeFile(join(root, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "  K-1  " } }));
  assert.equal(await readOpenRouterKey(root, root, {}), "K-1");
  assert.equal(await readOpenRouterKey(root, root, { OPENROUTER_API_KEY: " E-1 " }), "E-1");

  await writeFile(join(root, ".env"), "export OPENROUTER_API_KEY=\"dotenv-key\" # comment\nOTHER=x\n");
  assert.equal(await readOpenRouterKey(root, root, { OPENROUTER_API_KEY: "E-1" }), "dotenv-key");

  const cwd = join(root, "work");
  await mkdir(cwd);
  await writeFile(join(cwd, ".env"), "# no key here\nOTHER=1\n");
  assert.equal(await readOpenRouterKey(root, cwd, {}), "dotenv-key");

  const bare = join(root, "bare");
  await mkdir(bare);
  assert.equal(await readOpenRouterKey(bare, cwd, { OPENROUTER_API_KEY: "E-1" }), "E-1");

  await writeFile(join(cwd, ".env"), "OPENROUTER_API_KEY=cwd-key\n");
  assert.equal(await readOpenRouterKey(bare, cwd, { OPENROUTER_API_KEY: "E-1" }), "cwd-key");
});

test("prompt, model, and size validation rejects bad input", () => {
  assert.throws(() => validatePrompt(""), /non-empty/);
  assert.throws(() => validatePrompt("   "), /non-empty/);
  assert.throws(() => validatePrompt("x".repeat(4001)), /exceeds 4000/);
  assert.equal(validatePrompt("  ok  "), "ok");
  assert.equal(validateModel(undefined), "openai/gpt-image-2.5-sunburst");
  assert.equal(validateModel(""), "openai/gpt-image-2.5-sunburst");
  assert.throws(() => validateModel("has space"), /valid OpenRouter image/);
  assert.throws(() => validateModel("x".repeat(129)), /valid OpenRouter image/);
  assert.equal(validateModel("google/gemini-2.5-flash-image"), "google/gemini-2.5-flash-image");
  assert.equal(validateSize(undefined), undefined);
  assert.equal(validateSize("auto"), undefined);
  assert.equal(validateSize("2k"), "2K");
  assert.equal(validateSize("1024x1024"), "1024x1024");
  assert.throws(() => validateSize("huge"), /WIDTHxHEIGHT/);
  assert.throws(() => validateSize("100x100"), /between 256 and 4096/);
  assert.throws(() => validateSize("5000x5000"), /between 256 and 4096/);
});

test("reference images stay inside the workspace with bounded count and size", async t => {
  const root = await mkdtemp(join(scratch, "refs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "good.png"), fakePng());
  await writeFile(join(root, "notes.txt"), "not an image");
  await assert.rejects(readReferenceImages(root, ["missing.png"]), /inside the Pi working directory/);
  await assert.rejects(readReferenceImages(root, ["../escape.png"]), /inside the Pi working directory/);
  await assert.rejects(readReferenceImages(root, ["notes.txt"]), /PNG, JPEG, WebP, or GIF/);
  await assert.rejects(readReferenceImages(root, ["good.png", "good.png", "good.png", "good.png"]), /At most 3/);
  const big = join(root, "big.png");
  const handle = await open(big, "w");
  await handle.truncate(21 * 1024 * 1024);
  await handle.close();
  await assert.rejects(readReferenceImages(root, ["big.png"]), /20 MB/);
  const images = await readReferenceImages(root, ["good.png"]);
  assert.equal(images.length, 1);
});

test("output paths stay inside the workspace with lowercase hyphenated names", async t => {
  const root = await realpath(await mkdtemp(join(scratch, "out-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fallback = await resolveOutputPath(root, undefined);
  assert.equal(fallback.root, root);
  assert.equal(fallback.directory, join(root, "artifacts"));
  assert.equal(fallback.filename, undefined);
  const savedFallback = await saveImage(fallback.directory, fakePng(), "default", fallback.filename, { root: fallback.root });
  assert.match(savedFallback.path, /artifacts\/image-default-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  await assert.rejects(resolveOutputPath(root, "../evil.png"), /inside the Pi working directory/);
  const out = await resolveOutputPath(root, "My Shots/EVE Portrait.PNG");
  const saved = await saveImage(out.directory, fakePng(), "ignored", out.filename, { root: out.root });
  assert.match(saved.path, /My Shots\/eve-portrait\.png$/);
  assert.equal(detectSavedMime(Buffer.from("not bytes")), undefined);
  assert.equal(slugify("!!!"), "image");
});

test("outputPath accepts an existing directory or a trailing separator", async t => {
  const root = await realpath(await mkdtemp(join(scratch, "out-dir-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "album"));
  const album = await resolveOutputPath(root, "album");
  assert.equal(album.directory, join(root, "album"));
  assert.equal(album.filename, undefined);
  const saved = await saveImage(album.directory, fakePng(), "Red Circle", album.filename, { root: album.root });
  assert.match(saved.path, /album\/image-red-circle-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  const trailing = await resolveOutputPath(root, "new-album/");
  assert.equal(trailing.filename, undefined);
  const nested = await saveImage(trailing.directory, fakePng(), "Blue Sky", trailing.filename, { root: trailing.root });
  assert.match(nested.path, /new-album\/image-blue-sky-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  await writeFile(join(root, "plain.png"), fakePng());
  await assert.rejects(resolveOutputPath(root, "plain.png/"), /existing file, not a directory/);
});

test("symlinked output directories and final files are refused", async t => {
  const root = await realpath(await mkdtemp(join(scratch, "out-links-")));
  const outside = await realpath(await mkdtemp(join(scratch, "out-outside-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "artifacts"));
  await assert.rejects(resolveOutputPath(root, undefined), /symbolic link/);
  await assert.rejects(resolveOutputPath(root, "artifacts/escape.png"), /symbolic link/);
  await rm(join(root, "artifacts"));
  await symlink(outside, join(root, "shots"));
  await assert.rejects(resolveOutputPath(root, "shots/escape.png"), /symbolic link/);
  await writeFile(join(outside, "original.png"), fakePng());
  await symlink(join(outside, "original.png"), join(root, "linked.png"));
  await assert.rejects(resolveOutputPath(root, "linked.png"), /symbolic link/);
});

test("saveImage rechecks the created parent against the workspace", async t => {
  const root = await realpath(await mkdtemp(join(scratch, "out-race-")));
  const outside = await realpath(await mkdtemp(join(scratch, "out-race-outside-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const output = await resolveOutputPath(root, "safe/out.png");
  await mkdir(output.directory, { recursive: true });
  await rm(output.directory, { recursive: true, force: true });
  await symlink(outside, output.directory);
  await assert.rejects(
    saveImage(output.directory, fakePng(), "escape", output.filename, { root: output.root }),
    /inside the Pi working directory|symbolic link/,
  );
});

test("agent directory environment expands ~ and refuses relative paths", () => {
  assert.equal(agentDir({}), join(homedir(), ".pi", "agent"));
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/pi-agent" }), join(homedir(), "pi-agent"));
  assert.throws(() => agentDir({ PI_CODING_AGENT_DIR: "relative/agent" }), /absolute path/);
});

test("saved outputs reject non-PNG/JPEG bytes and tiny payloads", async t => {
  const root = await mkdtemp(join(scratch, "verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(saveImage(root, Buffer.from("<svg></svg>"), "p"), /PNG or JPEG/);
  await assert.rejects(saveImage(root, Buffer.concat([PNG_MAGIC, Buffer.alloc(10)]), "p"), /too small/);
});

test("default filenames are collision resistant and existing outputs need explicit overwrite", async t => {
  const root = await realpath(await mkdtemp(join(scratch, "overwrite-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await saveImage(root, fakePng(), "same prompt");
  const second = await saveImage(root, fakePng(2600), "same prompt");
  assert.notEqual(first.path, second.path, "same-second generations must not collide");
  assert.deepEqual(await readFile(first.path), fakePng(), "the earlier image must survive");

  const target = join(root, "fixed.png");
  const original = fakePng(3000);
  await writeFile(target, original);
  await assert.rejects(saveImage(root, fakePng(4096), "ignored", "fixed", { root }), /already exists/);
  assert.deepEqual(await readFile(target), original, "a refused overwrite leaves the file byte-for-byte intact");
  const replaced = await saveImage(root, fakePng(4096), "ignored", "fixed", { root, overwrite: true });
  assert.equal(replaced.path, target);
  assert.deepEqual(await readFile(target), fakePng(4096));
});

test("provider download URLs must be public HTTPS and never private addresses", async t => {
  const response = (url: string) => (async () => Response.json({ data: [{ url }] })) as typeof globalThis.fetch;
  await assert.rejects(
    generateImageBytes({ key: "K", model: "m", prompt: "p" }, response("https://127.0.0.1/x.png"), publicLookup),
    /private, loopback, or link-local/,
  );
  await assert.rejects(
    generateImageBytes({ key: "K", model: "m", prompt: "p" }, response("https://cdn.example/x.png"), async () => [{ address: "10.0.0.1", family: 4 }]),
    /private, loopback, or link-local/,
  );
  await assert.rejects(
    generateImageBytes({ key: "K", model: "m", prompt: "p" }, response("http://cdn.example/x.png"), publicLookup),
    /HTTPS on the default port/,
  );
  await assert.rejects(
    generateImageBytes({ key: "K", model: "m", prompt: "p" }, response("https://cdn.example/x.png"), async () => { throw new Error("dns"); }),
    /resolved safely/,
  );
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
  assert.equal(isPrivateAddress("fec0::1"), true);
  assert.equal(isPrivateAddress("::ffff:7f00:1"), true);
  assert.equal(isPrivateAddress("::ffff:5db8:d822"), false);
  assert.equal((await assertSafeDownloadUrl("https://cdn.example/x.png", publicLookup)).hostname, "cdn.example");
});

test("reference images have an aggregate byte budget", async t => {
  const root = await mkdtemp(join(scratch, "refs-total-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names: string[] = [];
  const size = Math.floor(MAX_REFERENCE_TOTAL_BYTES / 3) + 1024;
  for (let index = 0; index < 3; index++) {
    const name = `large-${index}.png`;
    names.push(name);
    const path = join(root, name);
    await writeFile(path, PNG_MAGIC);
    const handle = await open(path, "r+");
    await handle.truncate(size);
    await handle.close();
  }
  await assert.rejects(readReferenceImages(root, names), /32 MB in total/);
});

test("errors never expose the key or echo arbitrary provider prompt text", async t => {
  const key = "sk-or-v1-SECRET-KEY";
  assert.ok(!redactKey(`auth failed for ${key} ok`, key).includes(key));
  assert.equal(redactKey("plain", undefined), "plain");
  assert.equal(safeError(new Error("boom")), "Image generation failed. Check the stored OpenRouter login and connectivity.");
  assert.equal(safeError(new SafeError("careful")).length > 0, true);
  const fetch = (async () => Response.json({ error: { message: `bad key ${key} rejected for PRIVATE PROMPT` } }, { status: 401 })) as typeof globalThis.fetch;
  await assert.rejects(generateImageBytes({ key, model: "m", prompt: "PRIVATE PROMPT" }, fetch), error => {
    assert.match((error as Error).message, /authentication failed/);
    assert.ok(!(error as Error).message.includes(key));
    assert.ok(!(error as Error).message.includes("PRIVATE PROMPT"), "provider error text must not echo the prompt");
    assert.ok(!(error as Error).message.includes("bad key"), "provider messages are not included");
    return true;
  });
  const html = (async () => new Response("<html>nope</html>", { status: 500 })) as typeof globalThis.fetch;
  await assert.rejects(generateImageBytes({ key: "K", model: "m", prompt: "p" }, html), /HTTP 500/);
  const lying = (async () => new Response(JSON.stringify({ data: [{ nope: 1 }] }), { headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
  await assert.rejects(generateImageBytes({ key: "K", model: "m", prompt: "p" }, lying), /no image data/);
});

test("oversized provider responses are refused before buffering", async t => {
  const fetch = (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }), {
    headers: { "content-length": String(60 * 1024 * 1024) },
  })) as typeof globalThis.fetch;
  await assert.rejects(generateImageBytes({ key: "K", model: "m", prompt: "p" }, fetch), /exceeds the supported size/);
});
