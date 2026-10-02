# Working on pi-idle-compaction

Read [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). This is a standalone native-compaction adapter, not a generic background supervisor or a replacement summarizer.

## Setup and verification

From the monorepo root:

```sh
npm --prefix packages/pi-idle-compaction install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-idle-compaction run typecheck
npm --prefix packages/pi-idle-compaction test
npm --prefix packages/pi-idle-compaction run verify
```

Install dependencies only when needed. Node `>=26.10.0 <27` and coding-agent `^0.99.2 || ^1.0.0` are declared. Runtime requires no npm dependencies; tooling/host links are development-only. Keep neighboring `pi-auto-learn` source available for the lock-protocol compatibility test.

## Module boundaries

- `index.ts`: registers lifecycle hooks, `/idle-compact`, and optional versioned subagent RPC.
- `controller.mjs`: 60-minute timer, 100,000-token admission, generation/history invalidation, native compaction, and held-lease cleanup.
- `background.mjs`: optional neutral/legacy provider contracts, bounded status validation, and auto-learn worker/writer admission leases.
- `scripts/no-network.mjs`: test-process preload only; never a runtime dependency.
- `scripts/link-host.mjs`: package-local development host linking; the root helper handles missing/broken links across packages.

## Invariants

- Preserve the idle duration, token boundary, history-change requirement, idle/pending checks, and once-per-leaf attempt semantics unless a behavior change is requested.
- Timers run only for long-lived TUI/RPC modes. Input, tools/agents, UI waits, navigation, compaction, and shutdown invalidate/suspend admission correctly.
- Revalidate after every asynchronous admission step. A new generation, changed history/tokens, disabled state, or pending work must prevent a late compaction and release its own lease.
- Call only public native `ctx.compact`. Do not replace prompts, retention budgets, model choice, or Pi's normal compaction configuration.
- Hold admitted auto-learn worker/writer leases through complete/error/synchronous-throw/shutdown paths. Do not introduce a check-to-start gap or admit a second overlapping compaction.
- Never pause auto-learn, edit its state/config/skills, import it at runtime, steal an existing lease, or delete an uncertain owner's files. Validate tokens and unsafe file/link boundaries; release writer before worker.
- Cleanup uncertainty fails closed and stops future admission rather than claiming success.
- Missing optional subagent tooling requires no RPC. Present-but-broken RPC remains unsafe; absence and unhealthy presence are not interchangeable.
- Registry providers are bounded, synchronous, versioned, and validated. Preserve same-session filtering and replacement-safe disposal. Unknown/malformed/throwing state cannot mean idle.
- Never imply complete coverage of OS jobs, remote work, or another package merely because it is co-installed. Integrations require explicit reviewed provider/admission contracts.
- Commands are native Pi controls; on/off is session-local and resets with a fresh extension runtime. Do not add transport bot commands or silently persistent settings.

## Tests

- `controller.test.mjs`: timer thresholds, generation/history/token races, attempts, error paths, and lease lifetime.
- `background.test.mjs`: optional RPC, auto-learn lock compatibility, stale/foreign owners, link safety, and cleanup uncertainty.
- `registry.test.mjs`: supported contracts, same-session visibility, limits, malformed providers, and replacement-safe disposal.
- `adapter.test.mjs`: actual lifecycle adapter, modes, optional integrations, and mocked compaction.
- `loader.test.mjs`: isolated public Pi loading without runtime dependencies or subagents.

Tests forbid network operations and must not invoke paid native compaction. Use fake clocks, synthetic sessions, mock compact callbacks, and isolated local lease roots. Preserve the sibling import `../pi-auto-learn/src/lock.ts` as a test-only compatibility check, not a production dependency. Add race/fault cases for every admission or cleanup change.

## Deployment and release

Only the root `index.ts` is an extension entry; keep controller/background relative files in the runtime package. Do not add subagent activation, new runtime dependencies, private Pi APIs, settings rewrites, or uninstall behavior.

Source changes do not update the running runtime. An approved deployment must back up and avoid duplicate discovery, preserve unknown locks/state, and separately authorize activation. Do not force live compaction, inject TUI input, restart services, remove other packages, commit, push, tag, or publish without approval.
