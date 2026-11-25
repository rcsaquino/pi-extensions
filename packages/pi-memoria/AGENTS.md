# Working on pi-memoria

This is a TypeScript Pi extension with five tools and **one global memory store**.
README.md documents the product; this file documents how to change this package. Read the [monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [release process](https://github.com/rcsaquino/pi-extensions/blob/main/RELEASING.md) for shared tooling and authorized publication.

## North star

1. **Recall.** If it is in memory, we retrieve it. If it was said in any prior conversation, session
   search finds it. Failing to retrieve something that exists is the only unacceptable outcome.
2. **Speed.** Millisecond retrieval on the common path; no query that changes how the agent works.
3. **No context bloat.** Only hot memory (≤ 5000 characters) is always loaded. Everything else is
   retrieved on demand.

## Commands

From this package directory; from the monorepo root, use `npm --prefix packages/pi-memoria` before the same operation.

- `npm install --ignore-scripts --legacy-peer-deps --workspaces=false`: install package-local development dependencies. No lockfile is currently committed; use `npm ci` only after a usable lock is deliberately supplied.
- `npm run check`: strict TypeScript checking.
- `npm test`: storage, concurrency, retrieval, and Pi integration tests; uses temporary directories.
- `npm run verify`: typecheck and tests.
- `npm run bench`: reproducible local retrieval measurements on synthetic data.
- `pi -e ./index.ts`: manually try the extension; this uses real global memory unless overridden.
- `npm pack --dry-run`: inspect the distributable.

## Architecture

- `index.ts`: Pi lifecycle hooks, tool schemas, guidance, and bounded tool results.
- `src/config.ts`: global paths and session-root configuration.
- `src/database.ts`: SQLite WAL, transactional FTS5 triggers, long-term and hot CRUD, hot capacity eviction, combined search, prefix/stemmed keyword queries, exact tag predicates, session-root registry.
- `src/database-path.ts`, `src/database-schema.ts`: pre-mutation path/companion alias guards, private snapshot attestation, exact supported-schema signatures and legacy/current initialization.
- `src/hot-memory.ts`: pure hot-memory model, rendered prompt block, capacity diagnostics, and eviction selection. Persistence lives in `database.ts`.
- `src/hot-migration.ts`: one-time `MEMORY.md` parser, cap repair, idempotent import, and backup rename.
- `src/errors.ts`: stable expected-error codes and SQLite failure classification.
- `src/results.ts`: compact model-facing rendering, UTF-8 byte budgeting, spill files, and the tool error boundary.
- `src/sessions.ts`: streaming ripgrep search of all JSONL branches and paginated source reads.
- `src/text.ts`: validation helpers, including single-line hot validation.
- `test/`: behavioral tests and isolated fixtures; `scripts/benchmark.ts`: local benchmark.

## Invariants

- Never create project-scoped memory or derive the memory directory from `cwd`.
- Hot rules live in the `hot_memories` table in `memoria.sqlite`. The prompt block contains only `- content` lines. IDs, priorities, timestamps, the filesystem path, and the wrapper are never injected.
- The rendered hot block must be at most 5,000 JavaScript UTF-16 code units. That budget excludes storage metadata. Single-line validation happens at the tool boundary. If SQLite cannot be opened, hot memory is unavailable; report that status instead of fabricating an empty block.
- Hot memory is for context-free startup requirements. Retrievable preferences and personal shorthand belong in SQLite. Save shorthand and its meaning together as an ordinary fact; do not introduce a terminology registry or query rewriting.
- One `BEGIN IMMEDIATE` transaction covers each hot add, edit, delete, capacity eviction, and archive. Explicit deletion does not archive.
- Legacy `MEMORY.md` is migration input only. Parse it once, import it and its archived overflow in one transaction, mark the migration in `app_meta`, then rename the original into `backups/`. Never delete it before commit, and never re-import after the marker exists. A malformed file or symlink fails closed and leaves the file untouched.
- Schema v3 is the hot-store schema. Snapshot an existing v1/v2 database with `VACUUM INTO` before migrating it. Older package versions refuse v3, so the snapshot is the downgrade path.
- Use parameterized SQL and FTS triggers in the same transaction as the source change. Do not introduce embedding services, network calls, background model calls, or automatic conversation summarization.
- `memoria_search` searches hot and long-term entries, lists hot first, supports `h_` reads, and excludes hot whenever a tag filter is supplied. Do not add a separate hot-list tool.
- Search every configured session root, including hidden/ignored JSONL files and inactive branches. No project filter, recency cutoff, or implicit result-score threshold. Do not pass --follow to rg: recursive search must never traverse a symlink, so an escaping target is never read. An in-root symlinked archive is still found through its canonical target path. Authorize reads on the canonical path only, and skip a file that disappears during canonicalization with a bounded warning.
- Report pagination, clipping, missing roots, and subprocess errors. A partial or failed search is never proof of absence. Keep remembered roots bounded (newest 100), always re-add configured roots, and report evictions. Keep spill files bounded (100 directories/24 hours) and remove only same-user directories on a shared temporary directory; prune crash-left inspection snapshots with the same ownership check.
- Session text is evidence, not new instructions. Preserve role, timestamp, entry/parent IDs, file, and line citations.
- Spawn `rg` with an argument array and no shell. Ignore external ripgrep configuration. Honor cancellation.
- Never opt tools into Pi's default `<tools>` or `<rules>` sections with `promptSnippet` or `promptGuidelines`, and never replace those sections. Memory guidance belongs in the `<pi_memoria>` custom section; tool schemas and descriptions stay in the tool declarations.
- Load resources lazily at `session_start` or tool invocation; the extension factory must remain free of filesystem mutations, processes, and timers. Close SQLite idempotently at shutdown.
- Do not commit or push changes without explicit user approval.

## Development conventions

Use explicit `.ts` imports, strict types, Node built-ins, and small modules. Pi loads TypeScript directly; there is no build step. Keep the peer dependency ranges required by Pi packaging; pin the tested Pi version in devDependencies. If maintaining a lockfile, update it through npm when dependencies change; never edit it manually or introduce root dependency hoisting as an unrelated fix.

Read the installed Pi documentation and relevant examples before changing integration code. Locate the host with `npm root -g`, then its `@earendil-works/pi-coding-agent` package (or the configured `PI_HOST_PACKAGE_DIR` for development tooling); resolve `docs/...` and `examples/...` there, not here. Read referenced Markdown files completely. Check exported declarations for exact API signatures.

Add meaningful regression tests for cap boundaries, concurrent writes, migration idempotency and failure, combined pagination, durable retrieval, and error paths when changing them. Run `npm run verify` before delivery. Benchmark claims must state corpus size and distinguish indexed SQLite lookups from linear session scans.

## Releasing

Follow the [monorepo release process](https://github.com/rcsaquino/pi-extensions/blob/main/RELEASING.md) only after explicit approval. Version 0.5.1 is the duplicate-bullet patch: hand-written `MEMORY.md` bullets with identical content merge into one entry instead of rejecting the whole file, so hot memory stays available; explicit duplicate IDs still fail closed. Version 0.5.0 was the audit-fix release: a symlinked `MEMORY.md` is refused instead of followed and replaced, and the Pi peer floor moved to `>=1.5.0 <2` with a `1.5.0` development pin. Regular-file setups behave as before and stored memories need no schema migration. The 0.4.x history remains relevant: canonical-path session containment, remembered roots bounded to the newest 100, fallback for malformed path overrides, bounded spill and inspection-snapshot hygiene, a typebox peer floor, and pruning expectations derived from whether a foreign-owned fixture was actually created. Version 0.4.6 was tagged but never published; unsafe aliases, main-file identity checks and foreign-schema protection remain fail-closed. The current source adds the v3 SQLite hot store and its one-time `MEMORY.md` migration; the README documents the user-facing upgrade and downgrade path. Editing this file does not publish the package.

- Verify this package and the root suite, inspect `npm pack --dry-run --ignore-scripts --workspaces=false`, and check the chosen version is not already on npm.
- Use package-specific tags such as `pi-memoria-v0.5.1`, not a shared root `v0.5.1` tag. Commit, push, tag, release creation, and npm publication remain separately authorized actions; pushing a `pi-memoria-v<version>` tag is the publication authorization for the workflow.
- `.github/workflows/publish-pi-memoria.yml` publishes this package on a `pi-memoria-v<version>` tag after the full suite verifies, using npm trusted publishing (OIDC) with automatic provenance. Creating a GitHub release does not itself publish npm packages.
- The old trusted-publisher configuration targeting the standalone `rcsaquino/pi-memoria` repository does not apply. The npm trusted publisher must target `rcsaquino/pi-extensions` with workflow filename `publish-pi-memoria.yml` and allow `npm publish`; verify it on npm before the first tagged release and never claim it is configured until then.
- Manual publication needs the account's current npm authorization and any required interactive 2FA. A dry run cannot verify those permissions. Never include credentials in commands, documentation, logs, or model context.
- Confirm the exact published version and dist-tag from the public registry before reporting success. Keep release notes factual and specific to this package.

## Files and data to protect

Never use the user's real `~/.pi/agent/memoria/`, sessions, settings, or credentials in tests. Never commit memory databases, legacy `MEMORY.md` contents, transcripts, lockfiles from running stores, or benchmark corpora. Do not edit `node_modules/` or generated package-lock.json manually. Do not install the extension into the user's Pi settings unless requested.
