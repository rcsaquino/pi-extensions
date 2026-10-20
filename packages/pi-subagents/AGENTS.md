# Working on @rcsaquino/pi-subagents

Read [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md), [README.md](README.md), and [SPEC.md](SPEC.md). This package launches and supervises external Pi processes; it is not an orchestrator and ships no agent definitions.

## Setup and verification

From the monorepo root:

```sh
npm --prefix packages/pi-subagents install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-subagents run check
npm --prefix packages/pi-subagents test
npm --prefix packages/pi-subagents run verify
```

Tests are offline and use a fake RPC worker. They do spawn real supervisor and worker processes, so they require Linux procfs and a writable temporary root (`PI_SUBAGENTS_TEST_ROOT`). Do not replace the fake worker with a live provider call.

## Architecture

- `index.ts`: distributable forwarding entry.
- `src/index.ts`: tool schemas, descriptions, flag registration, and session lifecycle.
- `src/manager.ts`: dispatch, discovery-driven validation, supervisor spawn and ready handshake, reconciliation, notices, steering, cancellation, retention.
- `src/registry.ts`: `prompt.md` discovery, optional `description.md` summaries, and strict `agent.json` validation.
- `src/context.ts`: renders the `<subagents>` system prompt section from described definitions.
- `src/model.ts`: provider/model/thinking resolution against the model registry.
- `src/store.ts`: atomic records, run ids, exclusive run directories, record reading.
- `src/proc.ts`: `/proc` identity, boot-id checks, process-group ownership and signals.
- `src/notice.ts`: untrusted report framing, notice cap, durations.
- `supervisor.mjs`: the spawned supervisor. Strict JSONL RPC client, timeout/turn enforcement, steering acks, headless dialog cancellation, report capture, exit codes.
- `SPEC.md`: the contract. Update it with a section 20 entry when behavior changes.

## Behavioral invariants

- The supervisor is the only code allowed to parse worker protocol output. The extension reads `exit.code`, `exit.reason`, `report.md`, `supervisor.ready`, `dialogs.json`, and steering files.
- Dispatch waits at most two seconds for `supervisor.ready`. A failed start returns an error with the run id and the last supervisor line, records a terminal status, and queues no notice.
- Only `agent_settled` settles a run. `agent_end` does not.
- Steering is best effort. Acks distinguish `queued`, `started`, `settled`, and `rejected`; a timeout is reported as unconfirmed, never delivered. The tool never deletes an unacknowledged steer, and never reports a settled-run steer as applied.
- The final tentative report comes only from an assistant `message_end` in the final `agent_start` generation. Never fall back to an earlier message or trim the text.
- Every group kill verifies the recorded boot id, the process session id, and start ticks. Never signal the extension's own group.
- The supervisor dies with the parent Pi process and records `parent_gone`; an extension reload or session switch does not kill runs.
- `task.json` is written only by the extension, atomically, with unknown fields preserved. The supervisor writes only its own run files.
- Notices are at-least-once per settled run, deduplicated within the process, scoped to the dispatching session, and framed as untrusted.
- The worker inherits the service environment (including provider credentials), but not conversation history, memory, transport extensions, or the parent's appended system prompt.
- `PI_SUBAGENTS_WORKER=1` is set for every worker; dispatch refuses to run when it is set, so recursion is blocked.
- Capability lives only in `agent.json`. No dispatch field may widen it.
- Retention never removes a running run, a pending notice, or an unsupported schema version. Other sessions' runs are reconciled only when that session is opened.

## Regression targets

- `registry.test.ts`: defaults, unknown keys, extension/skill path rules, tool denylist, model patterns, thinking, bounds, discovery warnings.
- `model.test.ts`: inherited and qualified selections, unique/ambiguous bare ids, credentials, thinking overrides.
- `store.test.ts`: run-id shape, private atomic writes, exclusive directories, record round-trip, exit mapping, notice framing and caps.
- `supervisor.test.ts`: settlement, empty reports, final-generation capture, dialogs, mid-run and final-scan steering, timeout, turn limit, SIGTERM, parent death, vanished run directory, protocol failure, spawn failure, log caps, abort escalation.
- `extension.test.ts`: dispatch artifacts, notice delivery and dedup, result pagination, steering, cancel, concurrency limits, validation errors, session ownership, incompatible records, retention, synchronous spawn failure.
- `loader.test.ts`: distributable entry loads without starting runtime resources.

## Boundaries

Linux only. Do not add team orchestration, recursive delegation, automatic retries, workspace locks, transport routing, or bundled agent definitions without changing the spec first.

Creating documentation or code does not authorize installing, registering, enabling, or restarting this extension, editing `~/.pi/agent/subagents`, changing global settings, or cancelling real runs. Do not commit, push, tag, release, bump versions, or publish without explicit approval.
