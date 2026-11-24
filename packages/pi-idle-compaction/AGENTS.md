# Working on pi-idle-compaction

Read [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). This is a standalone native-compaction adapter that hands the compacted context to a fresh session, not a generic background supervisor or a replacement summarizer.

## Setup and verification

From the monorepo root:

```sh
npm --prefix packages/pi-idle-compaction install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-idle-compaction run typecheck
npm --prefix packages/pi-idle-compaction test
npm --prefix packages/pi-idle-compaction run verify
```

Install dependencies only when needed. Node `>=26.12.0 <27` and coding-agent `>=1.6.0 <2` are declared; the maintained offline baseline is Node 26.12.0 on Pi 1.6.0. Runtime requires no npm dependencies; tooling/host links are checkout-only development helpers excluded from the tarball.
`typecheck` covers `index.ts` and all runtime modules (`checkJs`). Test files are deliberately outside the project: their synthetic timers and partial host contexts are loose on purpose, and requiring them to satisfy `setTimeout`/`ExtensionCommandContext` would fake fidelity without testing anything.

## Module boundaries

- `index.ts`: registers lifecycle hooks, `/idle-compact`, the internal `/idle-compact-rotate` command, session-handoff dispatch, and neutral provider admission.
- `controller.mjs`: 60-minute timer, 100,000-token admission, generation/history invalidation, native compaction, and held-lease cleanup.
- `rotation.mjs`: compaction payload capture, retained-tail projection, and seeding the replacement session.
- `background.mjs`: optional neutral provider contract with session/global scope, bounded status validation, and standalone admission without foreign runtime files.
- `scripts/no-network.mjs`: test-process preload only; never a runtime dependency.
- `scripts/link-host.mjs`: package-local development host linking; the root helper handles missing/broken links across packages.

## Invariants

- Preserve the idle duration, token boundary, history-change requirement, idle/pending checks, and once-per-leaf attempt semantics unless a behavior change is requested.
- After a timer-requested compaction succeeds, the adapter requests one fresh session seeded with that compaction's summary and the retained tail. The old session stays on disk. A compaction not requested by the idle timer never rotates.
- The handoff is dropped if the session is busy, has pending messages, or another extension cancels the switch. A failed or cancelled compaction leaves the old session untouched and requests no new session.
- A late asynchronous admission cannot rotate after activity, a settle, a suspend, a reset, a disable, or shutdown. Release its lease and re-arm against the new state.
- Call `ctx.newSession()` only through the internal command context. The handoff requests it with `pi.sendUserMessage('/idle-compact-rotate', { expandPromptTemplates: true })`; never mutate `sessionManager` directly or inject terminal input. The command makes no model request.
- Seed the replacement with `appendCompaction(..., null, ...)` as a Pi-generated entry followed by the retained model-visible tail. Never copy the old full tree, and never copy system, compaction-summary, branch-summary, or excluded bash messages as ordinary messages.
- Timers run only for long-lived TUI/RPC modes. Input, tools/agents, UI waits, navigation, compaction, and shutdown invalidate/suspend admission correctly.
- Revalidate after every asynchronous admission step. A new generation, changed history/tokens, disabled state, or pending work must prevent a late compaction and release its own lease.
- Call only public native `ctx.compact`. Do not replace prompts, retention budgets, model choice, Pi's normal compaction configuration, or Pi's `<tools>`/`<rules>` sections.
- Recheck provider snapshots after asynchronous provider admission. Do not admit a second overlapping compaction or imply that a snapshot excludes future work.
- Never edit another extension's state/config/skills or create foreign runtime leases.
- Cleanup uncertainty fails closed and stops future admission rather than claiming success.
- Registry providers are bounded, synchronous, versioned, and validated. Preserve same-session filtering for session providers, global-scope blocking while any item is active, and replacement-safe disposal. Unknown/malformed/throwing state cannot mean idle.
- Never imply complete coverage of OS jobs, remote work, or another package merely because it is co-installed. Integrations require explicit reviewed provider/admission contracts.
- Commands are native Pi controls; on/off is session-local and resets with a fresh extension runtime. Do not add transport bot commands or silently persistent settings.

## Tests

- `controller.test.mjs`: timer thresholds, generation/history/token races, attempts, error paths, and lease lifetime.
- `rotation.test.mjs`: compaction payload capture, tail filtering, and summary-first seeding order.
- `background.test.mjs`: standalone admission, same-session provider gating, global-scope blocking, and malformed provider state.
- `registry.test.mjs`: supported contracts, same-session visibility, limits, malformed providers, and replacement-safe disposal.
- `adapter.test.mjs`: actual lifecycle adapter, modes, optional integrations, and mocked compaction.
- `loader.test.mjs`: isolated public Pi loading without runtime dependencies or companion packages.

Tests forbid network operations and must not invoke paid native compaction. Use fake clocks, synthetic sessions, mock compact callbacks, and isolated local fixtures. Add race/fault cases for every admission or cleanup change.

## Deployment and release

Only the root `index.ts` is an extension entry; keep controller/background/rotation relative files in the runtime package. Do not add new runtime dependencies, private Pi APIs, settings rewrites, or uninstall behavior.

Source changes do not update the running runtime. An approved deployment must back up and avoid duplicate discovery, preserve unknown locks/state, and separately authorize activation. Do not force live compaction, inject TUI input, restart services, remove other packages, commit, push, tag, or publish without approval.
