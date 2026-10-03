# Working on pi-extensions

## Project and scope

This is a private npm workspace containing six independent Pi extension packages. The root supplies navigation and verification tooling, not an extension entry point. Read the target package's README and AGENTS.md before changing it; package-local instructions refine these rules for that subtree.

- `packages/pi-memoria`: global memory and original-session retrieval.
- `packages/pi-telegram`: `@rcsaquino/pi-telegram`, transport, media, and explicit speech delivery.
- `packages/pi-auto-learn`: directory-scoped background skill maintenance.
- `packages/pi-idle-compaction`: native idle compaction and admission guards.
- `packages/pi-latency-analytics`: local Pi timing metadata and SQLite reporting.
- `packages/pi-background-tasks`: `@rcsaquino/pi-background-tasks`, independent in-process workers and writer leases.
- `scripts/workspaces.mjs`: sequential shared verification runner.
- `scripts/link-host.mjs`: development-only missing/broken host dependency links.
- `scripts/publication.test.mjs`: offline release-metadata, included-file, import-closure, documentation, and publication-workflow regression checks.
- `.github/workflows/publish-pi-memoria.yml`: tag-driven npm publication for `pi-memoria` through a trusted publisher (OIDC); inert until the npm package settings are configured and a `pi-memoria-v<version>` tag is pushed.
- `RELEASING.md`: package-specific release preparation and manual publication, plus the one automated `pi-memoria` path.

Keep package versions, APIs, dependencies, and installability independent unless consolidation is explicitly requested. Do not modify another package simply because it shares this repository.

## Environment and setup

The full suite currently requires Node 26.10.x or newer in the 26.x line, npm, and a Node-based Pi host. The validated combined host is Pi 1.0.0. Read package manifests for their different engines and peer ranges. Memoria needs `rg`; Telegram ownership needs util-linux-compatible `flock`, and long-speech tests need ffmpeg.

Install dependencies package by package, using that package's README. For example:

```sh
npm --prefix packages/pi-telegram install --ignore-scripts --legacy-peer-deps --workspaces=false
```

This checkout does not commit package lockfiles. Use `npm ci` only with an existing usable package lockfile that has deliberately been supplied. Do not hand-edit lockfiles or dependency source files. Do not perform a root hoisting install or upgrade pinned Pi development versions as a side effect of an unrelated task.

With an installed host, `npm run link-host` creates missing project-local host peer/compiler links or replaces dangling symlinks. It preserves working dependencies and does not resolve a working-but-wrong peer. Use `PI_HOST_PACKAGE_DIR` for nonstandard installations. Link repair is not authorization to install or modify Pi globally.

## Verification

From the root:

```sh
npm run check
npm test
npm run verify
```

The runner finds all package directories and uses `check` or `typecheck` plus `test`. Root `check`, `test`, and `verify` also run `check:publication`; use `npm run check:publication` for just the offline publication regressions. It runs sequentially, sets `PI_OFFLINE=1`, and points shared temporary directories to ignored `temp_files/tests/`. Set `PI_EXTENSIONS_TEST_ROOT` to an approved isolated directory when needed. Some packages also have ignored package-local fixtures.

Targeted examples:

```sh
npm --prefix packages/pi-auto-learn run verify
npm --prefix packages/pi-background-tasks run verify
npm --prefix packages/pi-idle-compaction run verify
npm --prefix packages/pi-latency-analytics run verify
npm --prefix packages/pi-telegram run typecheck
npm --prefix packages/pi-telegram test
```

Run focused checks while changing code, then the root suite for shared integration, imports, path changes, or final verification. Read failures; do not weaken a regression test to obtain a green run. Add relevant tests for behavioral changes.

Use synthetic providers, isolated agent directories, fake clocks/transports, real local SQLite where appropriate, and read-only loader verification without session startup. Never use real memory, sessions, managed skills, analytics state, Telegram ownership/cursors, credentials, or live provider calls as test fixtures.

Report commands, outcomes, relevant environment, and remaining gaps. Offline SDK tests are not live-provider, production-poller, idle-soak, or end-to-end delivery acceptance. Benchmark claims must name the workload and distinguish synthetic observer costs from real user latency.

## Code and Pi integration

- Preserve explicit `.ts`/`.mjs` imports, strict types, small modules, and each package's existing formatting conventions.
- Pi loads TypeScript directly. Do not introduce a shared build, bundler, runtime dependency, or private host API without a justified request.
- Before changing Pi integration, read the installed coding-agent's documentation and matching examples. Resolve `docs/` and `examples/` from that installation and inspect exported declarations for exact signatures.
- Factories register capabilities only. Start processes, workers, timers, stores, and sockets in session lifecycle or the operation needing them; clean up idempotently.
- Keep event semantics, tool exposure, cancellation, session replacement, and `agent_settled` behavior explicit. Do not turn notification-only events into implicit continuation loops.
- Keep host-supplied Pi packages as peers, not new runtime dependencies. A local development copy is not proof that production should bundle another host.
- Review background visibility/admission contracts before combining extensions. Do not assume independent packages automatically coordinate all their work.

## Files, permissions, and deployment

Runtime state and source are different assets. Never commit secrets, `.env`, memory contents/databases, original transcripts, analytics databases, media downloads, persistent cursors, active locks, or private validation corpora. Keep local reports and fixtures in approved ignored locations or outside this repository.

The existing workspace aliases are compatibility symlinks into `packages/`. Before changing them, inspect active lazy imports, settings, dependency links, and external helpers. Installed extension copies are deployment artifacts; canonical development happens here. Do not edit deployed copies in place during source work.

Source edits do not authorize package registration, enabling another extension, changing global settings, reloading the session, restarting a service, terminal-input injection, or live testing. Do not create duplicate extension discovery through both a package declaration and a copied entry. Preserve registration state and runtime data unless the user separately authorizes a deployment change.

## Review and release

- Keep the requested scope small and preserve unrelated user work.
- Keep README claims and AGENTS instructions consistent with actual scripts, manifests, tool schemas, and implementation.
- Changes to contact/support details require the user's direction; do not invent an email address or promise an unconfigured support channel.
- Do not commit, push, tag, bump versions, create releases, publish packages, or alter CI/trusted publishing without explicit approval. Pushing a `pi-memoria-v<version>` tag authorizes npm publication by the workflow.
- Follow [RELEASING.md](RELEASING.md) after explicit approval. Only `pi-memoria` has automated publication (`.github/workflows/publish-pi-memoria.yml`, on `pi-memoria-v*` tags after full verification); every other package is manual, and publishing a GitHub release does not itself publish npm packages.
- Use the manifest's exact npm name and package-specific tags. Keep source/runtime paths unscoped when changing only a package's npm identity.
- Do not reuse memoria's old standalone trusted-publisher identity or claim npm write access was verified by a dry run.
