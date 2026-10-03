<div align="center">

# pi-latency-analytics

**See what consumed time inside [Pi](https://github.com/earendil-works/pi), without collecting message bodies or calling another model.**

[Installation](#installation) · [Reports](#reports) · [Measurements](#what-is-measured) · [Privacy](#storage-privacy-and-resilience) · [Support](#support-and-contact)

</div>

A standalone observer of public Pi lifecycle, provider, and tool events. Collection is deterministic and local: no generated summaries, external telemetry, embeddings, transport patches, or additional model requests. SQLite writes run in a Node worker rather than the synchronous agent event path.

## Requirements

- **Node.js 22.19+** with built-in `node:sqlite` and worker threads.
- A Node-based Pi host exposing the public APIs used by this extension. Offline checks have exercised Pi 0.99.2 and the maintained Pi 1.0.0 host; future versions/platforms require acceptance checks.
- A private writable local analytics directory. Network filesystems are not validated.

There are no runtime npm dependencies. Pi supplies the declared `@earendil-works/pi-ai` and coding-agent peers. No Telegram bridge, subagent package, or Pi core modification is required.

## Installation

After a release is published, npm installation is `pi install npm:pi-latency-analytics`. Until then, install a reviewed local package:

```sh
pi install /absolute/path/to/pi-extensions/packages/pi-latency-analytics
```

Keep the referenced checkout in place. Activate with `/reload` when the session is idle and you intend to load the change. Do not also copy another entry into automatic extension discovery. Removal uses `pi remove <installed-source>` and retains the database.

The writer starts on `session_start`, not factory registration. Default storage is:

```text
<Pi agent directory>/analytics/analytics.sqlite
```

Normally this is `~/.pi/agent/analytics/analytics.sqlite`. `PI_LATENCY_DIR` overrides the directory. Reloads/sessions reuse the same database; WAL/SHM files are SQLite companions, not extra analytics databases.

## Reports

Ask normally: “Show the last recorded Pi latency breakdown.” The read-only `latency_query` tool supports:

- **`last`**: most recent finished/interrupted activity in the current session, excluding the activity asking for the report.
- **`recent`**: newest matching activities; default limit 10, maximum 50.
- **`slow`**: matching activities ordered by observed duration.
- **`trace`**: bounded details for a required `trace_id`.
- **`status`**: database counts and recorder health.

A model can explain recorded data when asked; collection itself never invokes one. For local deterministic output without a model request:

```text
/latency
/latency last
/latency recent 10
/latency slow 5
/latency trace TRACE_ID
/latency status
```

`/latency` is a native Pi command, not a Telegram bot-menu command. The extension never sends or edits Telegram messages. Reports say `pi-only`; they do not claim delivery timing.

## What is measured

One trace represents a **logical Pi activity** from the first observed input or maintenance/agent boundary until `agent_settled`. `agent_end` alone is not final because retries, compaction, and continuations can follow.

Recorded intervals include:

- **Preparation**: observed input to first agent start; a combined gap, not guaranteed routing/transcription/queue attribution.
- **Model**: context/request preparation through assistant message end, with observable retry/streaming boundaries.
- **Provider headers**: observed request-header to response-header hooks, with HTTP status when available. Attribution is best-effort because hooks lack request IDs and background requests can overlap.
- **Reasoning stream**: normalized thinking start/end, not private computation time or reasoning content.
- **Tools**: execution intervals, including parent IDs for nested calls.
- **Compaction** and blocking **UI waits**.

Sparse markers track first normalized content/text/reasoning output and relevant boundaries. First-output latency is measured from an observed provider preparation hook, not the first network byte or necessarily the first text. Missing boundaries produce `null`/incomplete coverage, not invented values. Delta contents are never retained.

Elapsed durations use a process-local monotonic clock; UTC timestamps support correlation. Wall-clock adjustments do not rewrite durations, and monotonic readings are not compared across processes. Available model/provider/thinking and usage metadata is captured; reasoning tokens are already part of output usage and must not be added twice.

### Overlap-safe accounting

Exclusive phase totals partition observed elapsed time using this precedence:

```text
compaction > UI wait > tools > model > preparation > unattributed
```

Parallel/nested tool `work_ms` can exceed an activity's elapsed time because it is cumulative overlapping work. Header/reasoning intervals are children of model time, not additional elapsed phases. Unattributed time stays unattributed; its cause is not inferred.

### Coverage limits

- No original Telegram polling receipt, durable-admission delay, final rendering/upload/send acknowledgment, phone display, or read receipt.
- Earlier input handlers can bypass this observer. It uses the first available boundary, not a fabricated earlier event.
- Steering/follow-up or multiple inputs can share an ambiguous trace. This is not per-message transport correlation.
- Reports are session-chronological, not guaranteed current-branch or Telegram-reply-ID lookups.
- Retry sleeps and custom extension model work are not completely instrumented. A shell call is one tool span, not automatic subprocess/upload phase tracing.
- Timings before activation cannot be reconstructed retrospectively.

## Storage, privacy, and resilience

One SQLite database holds `instances`, `traces`, `spans`, and `events`. Schema/application identifiers reject unrelated or unsupported-newer databases without overwriting them. There is no automatic retention purge.

Allowlisted metadata includes generated IDs, PID, timing, tool names, model/provider/thinking, status, usage counts, and source categories. It excludes prompts, assistant bodies, thinking text/signatures, tool arguments/results/commands, API payloads, header values, credentials, authenticated URLs, and exception messages.

> [!NOTE]
> Local metadata is not anonymous. Session IDs and names can still identify activity. Do not publish the database with source code.

Directories use `0700`, the database `0600`. Final-directory/database symlinks are refused, but same-user code remains outside an OS security boundary.

Handlers enqueue bounded records without awaiting SQL. A worker batches at a 25 ms schedule or 64 records, uses WAL, and handles brief lock contention off the agent thread. The buffer ceiling is 4,096 retained buffered/in-flight records. Loss increments health counters and conservatively marks traces potentially incomplete; recorder failure never blocks/retries ordinary agent work. An explicitly requested query performs a bounded flush.

Hard kills can lose batches; this is not lossless crash auditing or a guaranteed 25 ms loss window. On restart, unfinished work from demonstrably dead PIDs is marked interrupted without inventing an end timestamp. Live/reused PIDs remain conservative uncertainty.

Summaries are bounded at 5,000 spans, 30 model requests, and 12 tool-name summaries; trace detail caps are 256 spans/128 events with truncation indicators. SQL is parameterized; the tool cannot run arbitrary SQL or delete records.

## Development

From the monorepo root, install package-local tooling if needed:

```sh
npm --prefix packages/pi-latency-analytics install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-latency-analytics run verify
npm --prefix packages/pi-latency-analytics run bench
```

The benchmark uses synthetic normalized events and a real background writer/database under ignored `.bench/`. It measures observer costs, not live end-to-end latency or delivery overhead. State the workload/environment when reporting numbers.

Tests cover timing, overlap, privacy, settlement, ambiguity, multiple writers, permissions, bounded buffers, interruption recovery, and actual Pi loader/SDK behavior with synthetic streams. They do not require a live provider. See [AGENTS.md](AGENTS.md) for module invariants and regression targets. This package has no automatic CI or npm publication workflow; releases are deliberate operator actions.

## Support and contact

If pi-latency-analytics is useful to you, you can support its development on
[Ko-fi](https://ko-fi.com/rcsaquino).

<a href='https://ko-fi.com/rcsaquino' target='_blank'><img height='72' style='border:0px;height:72px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
