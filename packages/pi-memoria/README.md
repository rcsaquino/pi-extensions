<!-- prettier-ignore -->
<div align="center">

# pi-memoria

**Global memory for [Pi](https://github.com/earendil-works/pi): startup rules in `MEMORY.md`, durable facts in SQLite FTS5, and cited search across every past conversation.**

[![Node.js >= 22.19](https://img.shields.io/badge/Node.js-%3E%3D22.19-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MIT license](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)

[How it works](#how-it-works) • [Installation](#installation) • [Hot memory](#hot-memory) • [Tools](#tools) • [Configuration](#configuration) • [Performance](#performance) • [Support](#support-and-contact)

</div>

pi-memoria gives Pi one memory shared across every project: instructions that must apply from the first message go in a capped `MEMORY.md`, everything else in SQLite with FTS5, and past conversations stay searchable through ripgrep. Five tools, local storage only. No embeddings, no network calls, no background model work.

## Requirements

- **Node.js 22.19+** (uses `node:sqlite`; earlier baselines 22.19/24.20, maintained suite 26.10.0).
- A Node-based **Pi** host. The pinned development baseline is 1.0.0, the maintained Pi host. Standalone/Bun builds are not validated with `node:sqlite`.
- **ripgrep (`rg`)**, either on PATH or in Pi's managed `<agent-dir>/bin/` directory, for session search.

## Installation

```sh
pi install npm:pi-memoria
```

This installs the current public npm release. The source version is recorded in `package.json`; unpublished checkout changes require a local install.

Activate with `/reload` in an idle session when intended, or a separately approved restart. To uninstall, run `pi remove npm:pi-memoria`; stored memory remains until you delete its directory.

<details>
<summary><strong>Install from a local checkout</strong></summary>

From the monorepo root:

```sh
npm --prefix packages/pi-memoria install --ignore-scripts --legacy-peer-deps --workspaces=false
pi install /absolute/path/to/pi-extensions/packages/pi-memoria
```

Keep the checkout in place: a local install references it directly. To try it without installing:

```sh
pi -e /absolute/path/to/pi-extensions/packages/pi-memoria/index.ts
```

</details>

## How it works

| Store | What belongs there | How it is retrieved |
|---|---|---|
| `MEMORY.md` | Instructions that must apply before any retrieval cue appears | Loaded at startup and refreshed before every user prompt |
| SQLite + FTS5 | Preferences, facts, decisions, names, conventions | `memoria_search` |
| Original Pi JSONL sessions | What was actually said, including old branches and pre-compaction messages | `memoria_sessions`, with file and line citations |

"Start every sentence with `beep_boop`" belongs in hot memory: even a session starting with "Hello" must obey it. "The user likes apples" belongs in SQLite with tags such as `fruit` and `preferences`: a fruit recommendation supplies the retrieval cue.

The model decides what to save and when to search; nothing is extracted automatically. Before saving, it searches for related memories, keeps unchanged facts, and edits existing ones when information changes. SQLite rejects repeated identical adds; differently worded paraphrases depend on the model's judgment.

## Hot memory

```md
- [h_0123456789abcdef] [p=90] Start every sentence with beep_boop.
```

Priority is **0–100** (default 50). The **entire file**, including IDs and newlines, must fit in **5,000 UTF-16 code units**, checked before every write. Content is single-line; CR, LF, U+2028, and U+2029 are rejected.

Duplicate adds reuse the existing bullet and consume no capacity. When space is needed, strictly lower-priority bullets are archived to SQLite first (`hot-archive`), then the file is atomically replaced; if that cannot free enough room, the write fails with the live file unchanged.

> [!WARNING]
> Prefer the tools for edits. External edits can bypass the cap until the next load, and oversized content is never injected.

## Recall

Keyword search uses the supplied terms with prefix matching and English stemming, not automatic terminology rewriting. Save personal shorthand as an ordinary fact containing both forms, for example `The user's shorthand piem refers to the pi-extensions monorepo.` Searching `piem` then retrieves that fact; use its meaning for a follow-up search when needed. Session search has no recency or project filter. For "remember when" questions, search sessions and cite the original entries; follow `next_offset`/`next_text_offset`, and check `warnings` and `exhausted`. A partial or failed search is never proof of absence.

## Tools

| Tool | Purpose |
|---|---|
| `memoria_add` | Save a fact to SQLite or a startup rule to hot memory |
| `memoria_edit` | Change content, tags, priority, or hot text by ID |
| `memoria_delete` | Remove a memory by ID |
| `memoria_search` | Search SQLite with keywords, modes, and exact tags |
| `memoria_sessions` | Search or read original Pi session entries with citations |

Tool replies are compact; oversized results spill to a private `pi-memoria-result-*` file.

**Add a fact:**

```json
{"content":"The user likes apples.","tags":["fruit","preferences"]}
```

**Add a hot rule:**

```json
{"store":"hot","content":"Start every sentence with beep_boop.","priority":90}
```

**Search memories:**

```json
{"query":"kubernetes deploy","mode":"all","tags":["infrastructure"]}
```

**Search sessions:**

```json
{"query":"deadline","role":"user","after":"2025-03-04","before":"2025-03-05"}
```

**Read a session entry:**

```json
{"action":"read","path":"/absolute/path/to/session.jsonl","line":42}
```

- **Add:** `store` is `long_term` (default) or `hot`; SQLite accepts `tags` and `source`. Identical content is reused with `created: false`; edits are the only way to change a fact. SQLite limits: 20,000 characters, 30 tags, 2,000-character source.
- **Edit/delete:** pass an `id` (`m_` for SQLite, `h_` for hot) and only the fields to change. `expected_revision` or hot `expected_content` catches concurrent writes. Deletion never archives hot bullets or erases sessions.
- **Search:** `memoria_search` searches SQLite only; hot `h_` entries are injected from `MEMORY.md` and cannot be searched or read by this tool. `mode` is `any` (default), `all`, `phrase`, or `literal`; a miss falls back to a literal scan and reports the mode used. `tags` match exactly and case-sensitively. Read an SQLite memory with its `m_` ID; long content paginates via `text_offset`.
- **Sessions:** decoded JSON is searched, including hidden, ignored, and inactive-branch files. Results carry path/line citations. `exhausted: true` means every accessible root was scanned without errors; warnings mean partial results, never absence.

## Configuration

<details>
<summary><strong>Environment variables and storage layout</strong></summary>

| Variable | Effect |
|---|---|
| `PI_CODING_AGENT_DIR` | Pi's agent directory; memoria defaults to its `memoria/` child and looks for managed ripgrep in its `bin/` child |
| `PI_MEMORIA_DIR` | Override the single global memory directory |
| `PI_MEMORIA_SESSION_DIRS` | JSON array of additional absolute session roots |

```text
~/.pi/agent/memoria/
├── MEMORY.md
├── memoria.sqlite
└── backups/
```

Database startup recognizes truly empty stores and the exact shipped memoria v1/v2 schemas, including legacy stores without an application identifier. Current stores receive the `MEMO` application identifier without a schema-version bump. Foreign, future, customized or unsupported schemas are refused before chmod, journal-mode changes or migration. Supported v1 migration preserves facts, archives, duplicates and FTS indexes.

Database/companion files must be regular single-link files, and existing directory components cannot be symlinks. Unsafe `-wal`, `-shm`, `-journal` aliases and orphan companions are refused. Ownership inspection uses a private mode-0700 temporary snapshot of the database/WAL/journal, because even SQLite READONLY can alter original SHM read marks. Snapshot files use 0600, copying uses a fixed-size buffer with bounded change retries, and cleanup runs on success/failure. Startup inspection is linear in stored bytes and needs temporary disk capacity; normal queries do not copy the store. Concurrent supported startup still re-attests under its migration transaction. These are focused startup checks, not an OS lease against uncoordinated path/schema mutations by another process.

Session search prefers Pi's managed `<agent-dir>/bin/rg` (`rg.exe` on Windows), then inherited PATH if the managed executable is missing (ENOENT). Permission errors or other operational failures are reported, not hidden by fallback. Resolution is retried on each search so a binary provisioned after extension loading is recognized. `PI_CODING_AGENT_DIR` uses the same absolute/tilde normalization as the memory configuration; `PI_MEMORIA_DIR` does not move the managed-bin location. Explicit executable overrides for custom callers/tests remain authoritative.

Memoria never downloads binaries or changes PATH. Normal interactive Pi startup can provision missing ripgrep on supported platforms. On an offline first start, after a failed download, or where Pi cannot provision it (such as Android/Termux), install system ripgrep or provision the managed binary separately. Android/Termux users can use `pkg install ripgrep`. Reading an original entry with `action=read` does not require ripgrep.

The default session root is `<agent-dir>/sessions`; roots Pi uses are remembered across projects. Changing `PI_MEMORIA_DIR` selects a different store without migrating the old one, project `cwd` is never used to choose it, and no data is sent over the network.

</details>

## Performance

<details>
<summary><strong>Benchmark: 10,000 memories and 50,000 session entries (11.9 MB)</strong></summary>

| Operation | Median | p95 |
|---|---:|---:|
| Selective SQLite FTS5 lookup | 0.093 ms | 0.119 ms |
| Exact-tag filtered FTS5 lookup (10,000 matching rows) | 6.308 ms | 7.365 ms |
| Literal SQLite full scan | 4.709 ms | 5.094 ms |
| Hot-file refresh with locking | 0.148 ms | 0.249 ms |
| Session match near the end of the corpus | 26.776 ms | 34.777 ms |
| Absent session term, complete scan | 4.325 ms | 5.172 ms |

`npm run bench` recreates this synthetic corpus in a temporary directory. Warm-cache medians on Linux, Node 24.20, Ryzen 5 7500F, including `rg` startup. Indexed lookups stay fast; scans grow with corpus size. Not a performance guarantee.

</details>

## Development

From the monorepo root:

```sh
npm --prefix packages/pi-memoria install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-memoria run verify
npm --prefix packages/pi-memoria run bench
```

No package lockfile is currently committed, so `npm ci` is not a fresh-checkout setup command. The shared host-link helper preserves working dependencies and only repairs missing/broken links.

There is no build step: Pi loads `index.ts` directly. `src/database.ts`, `src/hot-memory.ts`, and `src/sessions.ts` own the storage layers; `index.ts` wires them to lifecycle events and the tool schemas. Tests use temporary directories, real SQLite FTS5, real `rg`, concurrent writers, and Pi's extension loader. See [AGENTS.md](AGENTS.md) for architecture and contribution rules.

## Support and contact

If pi-memoria is useful to you, you can support its development on
[Ko-fi](https://ko-fi.com/rcsaquino).

<a href='https://ko-fi.com/rcsaquino' target='_blank'><img height='72' style='border:0px;height:72px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
