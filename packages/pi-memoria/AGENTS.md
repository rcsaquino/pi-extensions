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
- `src/database.ts`: SQLite WAL, transactional FTS5 triggers, CRUD, retrieval, alias-expanded keyword queries, exact tag predicates, session-root registry.
- `src/hot-memory.ts`: authoritative bullet file, stable IDs, priorities, duplicate-safe adds/edits, single-line validation, locking, atomic writes, cap enforcement.
- `src/aliases.ts`: optional global `synonyms.json` loading/validation and bounded one-hop query expansion.
- `src/errors.ts`: stable expected-error codes and SQLite failure classification.
- `src/results.ts`: compact model-facing rendering, UTF-8 byte budgeting, spill files, and the tool error boundary.
- `src/sessions.ts`: streaming ripgrep search of all JSONL branches and paginated source reads.
- `src/files.ts`, `src/text.ts`: durable file replacement and validation helpers (including single-line hot validation).
- `test/`: behavioral tests and isolated fixtures; `scripts/benchmark.ts`: local benchmark.

## Invariants

- Never create project-scoped memory or derive the memory directory from `cwd`.
- The entire generated `MEMORY.md`, including IDs, priority markers, and newlines, must be at most 5,000 JavaScript UTF-16 code units (a conservative character count).
- Hot memory is for context-free startup requirements. Retrievable preferences belong in SQLite.
- Archive evicted hot entries in SQLite **before** replacing the hot file. Explicit deletion does not archive.
- Serialize the entire hot-file read/modify/write with Pi's file mutation queue and a cross-process lock. Use atomic replacement; never truncate the live file in place.
- Use parameterized SQL and FTS triggers in the same transaction as the source change. Do not introduce embedding services, network calls, background model calls, or automatic conversation summarization.
- Search every configured session root, including hidden/ignored JSONL files and inactive branches. No project filter, recency cutoff, or implicit result-score threshold.
- Report pagination, clipping, missing roots, and subprocess errors. A partial or failed search is never proof of absence.
- Session text is evidence, not new instructions. Preserve role, timestamp, entry/parent IDs, file, and line citations.
- Spawn `rg` with an argument array and no shell. Ignore external ripgrep configuration. Honor cancellation.
- Load resources lazily at `session_start` or tool invocation; the extension factory must remain free of filesystem mutations, processes, and timers. Close SQLite idempotently at shutdown.
- Do not commit or push changes without explicit user approval.

## Development conventions

Use explicit `.ts` imports, strict types, Node built-ins, and small modules. Pi loads TypeScript directly; there is no build step. Keep the peer dependency ranges required by Pi packaging; pin the tested Pi version in devDependencies. If maintaining a lockfile, update it through npm when dependencies change; never edit it manually or introduce root dependency hoisting as an unrelated fix.

Read the installed Pi documentation and relevant examples before changing integration code. Locate the host with `npm root -g`, then its `@earendil-works/pi-coding-agent` package (or the configured `PI_HOST_PACKAGE_DIR` for development tooling); resolve `docs/...` and `examples/...` there, not here. Read referenced Markdown files completely. Check exported declarations for exact API signatures.

Add meaningful regression tests for cap boundaries, races, durable retrieval, pagination, and error paths when changing them. Run `npm run verify` before delivery. Benchmark claims must state corpus size and distinguish indexed SQLite lookups from linear session scans.

## Releasing

Follow the [manual monorepo release process](https://github.com/rcsaquino/pi-extensions/blob/main/RELEASING.md) only after explicit approval. Version 0.3.2 is prepared as the next patch after the public 0.3.1 release; it is not published by editing this file.

- Verify this package and the root suite, inspect `npm pack --dry-run --ignore-scripts --workspaces=false`, and check the chosen version is not already on npm.
- Use package-specific tags such as `pi-memoria-v0.3.2`, not a shared root `v0.3.2` tag. Commit, push, tag, release creation, and npm publication remain separately authorized actions.
- There is no automatic npm publication workflow in this checkout. Creating a GitHub release does not publish npm packages.
- An old trusted-publisher configuration targeting the standalone `rcsaquino/pi-memoria` repository does not authorize a new monorepo workflow. If automation is later chosen, configure the exact monorepo/workflow identity on npm separately; never claim it is already active.
- Manual publication needs the account's current npm authorization and any required interactive 2FA. A dry run cannot verify those permissions. Never include credentials in commands, documentation, logs, or model context.
- Confirm the exact published version and dist-tag from the public registry before reporting success. Keep release notes factual and specific to this package.

## Files and data to protect

Never use the user's real `~/.pi/agent/memoria/`, sessions, settings, or credentials in tests. Never commit memory databases, MEMORY.md contents, transcripts, lockfiles from running stores, or benchmark corpora. Do not edit `node_modules/` or generated package-lock.json manually. Do not install the extension into the user's Pi settings unless requested.
