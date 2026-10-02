import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { expandQuery, loadAliases, MAX_ALIAS_FILE_BYTES } from "../src/aliases.ts";
import { temporary } from "./helpers.ts";

test("built-in aliases apply without a file, and a missing file is not a warning", async (t) => {
  const configuration = loadAliases(join(await temporary(t), "synonyms.json"));
  assert.equal(configuration.warning, undefined);
  assert.deepEqual(expandQuery(["k8s", "prefs", "unknown"], configuration.aliases).expansions, [
    { term: "k8s", aliases: ["kubernetes"] },
    { term: "prefs", aliases: ["preferences"] },
  ]);
  assert.equal(expandQuery(["K8S"], configuration.aliases).expansions[0]?.term, "K8S", "the original term keeps its spelling");
});

test("user mappings add, override, and disable built-ins directionally and one hop", async (t) => {
  const path = join(await temporary(t), "synonyms.json");
  await writeFile(path, JSON.stringify({
    K8S: ["KUBERNETES", "kube"],
    prefs: [],
    alpha: ["beta", "beta", "alpha"],
    beta: ["gamma"],
  }));
  const configuration = loadAliases(path);
  assert.equal(configuration.warning, undefined);
  assert.deepEqual(expandQuery(["k8s"], configuration.aliases).expansions[0]?.aliases, ["kubernetes", "kube"], "targets are lowercased and deduplicated");
  assert.deepEqual(expandQuery(["prefs"], configuration.aliases).expansions, [], "an empty array disables the key while keeping the original term");
  assert.deepEqual(expandQuery(["alpha"], configuration.aliases).expansions[0]?.aliases, ["beta"], "self-alternatives are removed");
  assert.deepEqual(expandQuery(["beta"], configuration.aliases).expansions[0]?.aliases, ["gamma"], "mappings are directional");
  assert.deepEqual(expandQuery(["gamma"], configuration.aliases).expansions, [], "one-hop mappings are not recursive");
});

test("malformed, invalid, or oversized configuration is ignored whole with a warning", async (t) => {
  const directory = await temporary(t);
  const cases: Array<[string, string]> = [
    ["malformed JSON", "{"],
    ["non-object JSON", "[]"],
    ["multiword key", JSON.stringify({ "two words": ["x"] })],
    ["punctuation key", JSON.stringify({ "k8s!": ["x"] })],
    ["non-string target", JSON.stringify({ k8s: [1] })],
    ["multiword target", JSON.stringify({ k8s: ["two words"] })],
    ["too many targets", JSON.stringify({ k8s: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] })],
    ["too-long token", JSON.stringify({ k8s: ["x".repeat(81)] })],
    ["duplicate normalized key", JSON.stringify({ K8s: ["a"], k8s: ["b"] })],
    ["too many keys", JSON.stringify(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`t${i}`, ["x"]])))],
    ["oversized file", `"${"x".repeat(MAX_ALIAS_FILE_BYTES)}"`],
  ];
  let index = 0;
  for (const [label, contents] of cases) {
    const path = join(directory, `synonyms-${index++}.json`);
    await writeFile(path, contents);
    const configuration = loadAliases(path);
    assert.ok(configuration.warning, `${label} must warn`);
    assert.deepEqual(expandQuery(["k8s"], configuration.aliases).expansions, [{ term: "k8s", aliases: ["kubernetes"] }], `${label} must keep built-ins`);
  }
  const unreadable = join(directory, "directory-not-file");
  await mkdir(unreadable);
  const configuration = loadAliases(unreadable);
  assert.ok(configuration.warning);
  assert.deepEqual(expandQuery(["db"], configuration.aliases).expansions, [{ term: "db", aliases: ["database"] }]);
});

test("prototype-like keys are own keys and cannot corrupt lookup", async (t) => {
  const path = join(await temporary(t), "synonyms.json");
  await writeFile(path, '{"__proto__":["legit"],"constructor":["built"],"toString":["text"]}');
  const configuration = loadAliases(path);
  assert.equal(configuration.warning, undefined);
  assert.deepEqual(expandQuery(["constructor"], configuration.aliases).expansions, [{ term: "constructor", aliases: ["built"] }]);
  assert.deepEqual(expandQuery(["toString"], configuration.aliases).expansions, [{ term: "toString", aliases: ["text"] }]);
  assert.deepEqual(expandQuery(["missing"], configuration.aliases).expansions, []);
  assert.equal(({} as Record<string, unknown>).legit, undefined);
});

test("alias expansion is bounded per query instead of silently dropping alternatives", () => {
  const targets = (prefix: string) => Array.from({ length: 8 }, (_, i) => `${prefix}${i}`);
  const aliases = new Map(Array.from({ length: 17 }, (_, i) => [`t${i}`, targets(`x${i}`)]));
  const overflow = expandQuery(Array.from({ length: 17 }, (_, i) => `t${i}`), aliases);
  assert.deepEqual(overflow.expansions, []);
  assert.match(overflow.warning!, /over the 128-term limit/u);
  const within = expandQuery(Array.from({ length: 16 }, (_, i) => `t${i}`), aliases);
  assert.equal(within.warning, undefined);
  assert.equal(within.expansions.flatMap((value) => value.aliases).length, 128);
});
