# Working on @rcsaquino/pi-background-tasks

Read [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). The npm scope does not rename the source directory, task storage, commands, or tools. This package manages independent in-process Pi agents, not subprocess-hosted Telegram sessions or durable distributed jobs.

## Setup and verification

From the monorepo root:

```sh
npm --prefix packages/pi-background-tasks install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-background-tasks run check
npm --prefix packages/pi-background-tasks test
npm --prefix packages/pi-background-tasks run verify
```

Install dependencies only when needed. The package declares Node 22.19+ and Pi 1.x. Host packages stay peers; do not bundle another Pi runtime. Set `PI_BACKGROUND_TEST_ROOT` for isolated direct test scratch, or use the root runner.

## Architecture

- `index.ts`: distributable forwarding entry.
- `src/index.ts`: model-facing schemas, tools, `/bg`, flags, and lifecycle registration.
- `src/policy.ts`: ETA/context validation, routing, coherent history, tool/path guards, and worker instructions.
- `src/manager.ts`: admission, capacity, leases, cancellation, notifications, ETA, and usage/result bookkeeping.
- `src/worker.ts`: independent agent, inherited model/tool behavior, bounded execution, and compaction.
- `src/store.ts`: private atomic task metadata/results, report-only interruption recovery, and shared writer leases.
- `src/report.ts`: pure terminal validation, closed diagnostic sanitization and deterministic settlement reports.
- `src/types.ts`: dispatch, profile, runtime, and persisted-record contracts.

## Behavioral invariants

- Capture exact provider/model/thinking at dispatch. Do not guess defaults or substitute a virtual router's physical model silently. Use the parent's public model registry and nested-tool APIs.
- Brief mode is the default and does not read/project parent history. Selected mode transmits only explicit bounded reference text. Full mode is opt-in projected history under an explicit user request; never use it to repair a vague brief.
- Preserve essential inherited instructions, advertised skills and callable tools without initializing extensions again. Necessary skill bodies are read by workers, not wholesale copied from earlier context.
- Require complete task/title/ETA/reason fields and valid uncertainty bounds. Automatic routing is strictly above 120 seconds; manual requests always delegate. Do not add a timer pretending to predict work.
- Accepted dispatch returns immediately. The main chat must remain usable; no sleep/poll loops, long foreground tool promise, or duplicate execution of accepted work.
- Keep a worker's abort signal independent of foreground cancellation. Explicit cancellation is cooperative and cannot roll back effects. Shutdown/session replacement cancels workers and handles stuck tools conservatively.
- One write task owns the exact canonical-workspace lease. Treat shells/unclassified effects as writes, resolve symlink paths, and retain the lease until uncertain tools settle. Do not generalize this to an OS sandbox or overlapping-tree lock.
- Read-only workers cannot use mutating/unclassified tools. Hidden/model-only tools stay excluded; nested calls cannot recursively spawn workers, manage another job, or hijack Telegram delivery.
- ETA updates are remaining duration plus elapsed time, with reasons and bounded uncertainty. They do not extend the runtime safety timeout. No invented percentages/deadlines.
- Persist output before queuing completion. Deliver through the main chat and do not blindly replay uncertain notifications after a crash.
- Accept worker prose only after a nonblank visible `stop` response without unfinished tool calls. Persist standalone deterministic fallbacks for other settlements; label failed partial prose unverified. No finalizer model calls or task/tool replay.
- Persist only closed diagnostic enums, validated counters/timestamps and known tool identities (`other` for unlisted identities). Preserve observed failure provenance, not guessed provider/preparation categories. Never copy reasoning, signatures, full transcripts, arguments/results, auth, raw errors or provider diagnostics. Visible prose itself still needs privacy review.
- Reject unsafe storage/result symlinks and traversal. A storage-failure fallback is bounded and process-local, explicitly non-durable; withhold completion reservation and retain once-only retrieval usage within that process.
- Report usage exactly once when results are fetched, including nested usage without double-counting reasoning. Pagination and notification delivery must not duplicate it.
- Failures, length stops, capacity conflicts, and interrupted state remain explicit; never fabricate successful completion or replay uncertain effects.

## Regression targets

- `policy.test.ts`: estimates, strict threshold, context validation/history boundaries, profile inheritance, and nested tool/path guards.
- `integration.test.ts`: actual Pi session responsiveness, context modes, permission forwarding, cancellation, model changes, usage, and shutdown.
- `manager.test.ts`: ETA revisions, overdue notification, cancellation, durable completion, and automatic routing state.
- `store.test.ts`: permissions, atomic output, context metadata/legacy records, corruption, cross-session writer leases, and interruption recovery.
- `reporting.test.ts`, `restore-reporting.test.ts`: strict terminal reporting, safe failure provenance, standalone fallbacks, secret exclusion, limits/shutdown/lease uncertainty, storage faults, legacy restoration, notification durability and once-only paginated retrieval.
- `compaction.test.ts`: same-profile compaction and coherent tool-call/result retention.
- `loader.test.ts`: distributable entry point without starting runtime resources.

Use synthetic streams and private temporary roots. Tests must show real observable concurrency and inherited hooks, not just successful registration. Add race/fault cases when changing leases, settlement, persistence, notification, or cancellation. Run package verification, then shared verification for cross-package/API changes.

## Boundaries

This version requires long-lived TUI/RPC hosting and does not make jobs survive process exit. Provider lifecycle and AgentSession recovery are not fully duplicated; document intentional inheritance exceptions rather than promising a clone.

Creating documentation or code does not authorize global registration, turning automatic routing on/off in a live session, cancelling real jobs, changing runtime records, enabling another extension, or restarting Pi. Keep task archives and user deliverables private and outside Git. Do not commit, push, release, bump versions, or publish without explicit approval.
