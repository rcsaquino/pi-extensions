# Working on pi-latency-analytics

Read [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). This is a deterministic, standalone observer using public Pi events, one local SQLite database, and a background writer. It must not become another LLM workflow or a Telegram instrumentation patch.

## Setup and commands

From the monorepo root:

```sh
npm --prefix packages/pi-latency-analytics install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-latency-analytics run check
npm --prefix packages/pi-latency-analytics test
npm --prefix packages/pi-latency-analytics run verify
npm --prefix packages/pi-latency-analytics run bench
```

Install dependencies only when needed. Node 22.19+ with `node:sqlite`/workers is required. The maintained suite uses Node 26.10.0 and Pi 1.0.0; the package retains older development pins. Do not upgrade or consolidate dependencies as part of unrelated work. Host peers are supplied by Pi in production; there are no runtime npm dependencies.

Tests and benchmark create private synthetic local stores. Never set their paths to the user's actual `PI_LATENCY_DIR` or analytics database. Root verification provides isolated scratch; direct benchmark scratch is ignored `.bench/`.

## Module map

- `index.ts`: capability/event registration, metadata configuration, read-only `latency_query`, `/latency`, and idempotent writer lifecycle.
- `lib/collector.mjs`: activity boundaries, monotonic spans/markers, normalized stream observation, usage, and uncertainty.
- `lib/isolation.mjs`: independent linked worker collectors, validated v1 telemetry and dispatch-root host-tool routing.
- `lib/client.mjs`: bounded queue, worker protocol, flushing/querying, health, and cleanup.
- `lib/writer.mjs`: off-thread batching and storage protocol.
- `lib/database.mjs`: SQLite schema/application guards, private storage, writes, recovery, queries, and overlap-safe summaries.
- `lib/database-path.mjs`: pre-mutation directory/file/SQLite-companion alias guards, private stable ownership snapshots and descriptor-based file permissions.
- `lib/report.mjs`: deterministic local report formatting.
- `scripts/benchmark.mjs`: synthetic observer microbenchmark with a real writer.

## Invariants

- Collection makes no model/network calls, changes no prompt/tool result, and imports or patches no Telegram transport, Pi core, or other extension. Register capabilities at factory time; start the writer only with the session.
- Never inspect/store message bodies, thinking text/signatures, tool arguments/results/commands, authenticated URLs, credential/header values, API payloads, or raw exceptions. Keep metadata fields allowlisted and bounded.
- Trace logical activities until `agent_settled`; `agent_end` is not necessarily final. Preserve retry/compaction/continuation boundaries, maintenance cases, session replacement, and ambiguity from multiple inputs.
- Use a monotonic clock for elapsed intervals and wall-clock values only for correlation. Do not compare process-local monotonic readings across instances.
- First normalized output is not first network byte or necessarily first text. Missing hooks remain missing. Never assign host provider hooks without request IDs to a model window; retain unknown attribution. Context-start timing and explicitly correlated worker-preparation timing are distinct.
- Foreground and worker trace/model/tool windows stay separate. Capture queued workers' original dispatch links before a later foreground starts; close queue spans at resource admission and keep local model-admission wait distinct from provider windows. Finalized worker ancestry remains a bounded tombstone, not a new foreground activity. Route starts by actual nested parent ancestry, never a foreground provider-ID prefix alone; known sparse end events may close their recorded span. Request/aggregate usage must be counted once; result retrieval cannot duplicate it. Unknown UI ancestry stays unattributed during worker overlap. The event bus is trusted code, not an authenticated effect/telemetry boundary.
- Exclusive phase totals are a partition, not summed overlapping work. Nested/parallel cumulative tool work may exceed elapsed time. Do not double-count model children or reasoning token usage.
- Unknown gaps remain unattributed. Do not invent retry, queue, transport, subprocess, or background-model causes.
- Never claim Telegram delivery/upload timing, per-reply correlation, device display/read receipts, or historical traces before activation.
- Keep synchronous handlers bounded and non-blocking. Recorder failure/loss must not retry or block normal agent work; an explicit query may request a bounded flush.
- Preserve private file modes, unsafe-link rejection, parameterized SQL, application/schema identifiers, and refusal of unsupported newer/unrelated databases.
- Lost records retain conservative flags. Crash recovery cannot fabricate completion timestamps or assume a live/reused PID is dead. No automatic destructive retention purge.
- `latency_query` remains read-only and bounded. `last` excludes the current report activity. Pagination/detail clipping must retain truncation and coverage indicators.

## Regression tests

- `collector.test.mjs`: boundaries, normalized sparse events, clocks, usage, parallel/nested tools, and content non-access.
- `storage.test.mjs`: schema/permissions, recovery, symlinks, concurrent writers, batching, loss, and initialization failures.
- `edge-cases.test.mjs`: attribution/uncertainty, lifecycle edge cases, and missing boundaries.
- `isolation.test.mjs`: two concurrent linked workers plus foreground, clean span ownership, usage deduplication, cancellation/error/shutdown, late/invalid/private events and legacy schema-v1 querying.
- `extension.test.mjs`: public registration, observational behavior, querying, and cleanup.
- `sdk.test.mjs`: actual Pi loader/session with synthetic provider streams and tool activity.

Run targeted regressions, package verification, then shared checks for API/path integration changes. Fixtures must forbid live provider/transport calls. Benchmark evidence must state workload, environment, timer/sample overhead, and synthetic scope; do not turn a microbenchmark into a user-facing latency guarantee.

## Operations and release

Keep the database outside source control and do not expose real activity metadata in reports/tests. Inspection is not authorization to delete records, migrate the live database, change global paths/settings, reload/restart the host, or instrument another extension.

Pi loads TypeScript directly; retain `index.ts` and the complete relative `lib/` tree. No shared compile step or physical duplicate host runtime is required. This package has no automatic CI or publication workflow. Do not commit, push, tag, release, bump versions, or publish without explicit approval.
