# Working on @rcsaquino/pi-background-task

Read [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). This package forks the current Pi session into a detached `pi -p` process. It is not an orchestrator, keeps no agent definitions, and does not change the worker's tools or system prompt. Each dispatched task is prefixed with a fixed operational note.

## Setup and verification

From the monorepo root:

```sh
npm --prefix packages/pi-background-task install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-background-task run check
npm --prefix packages/pi-background-task test
```

Tests are offline and cover prompt composition, notice framing, retention, settled-status mapping, run-id containment, process-group kill escalation, restart recovery and one-notice-per-run idempotency. The maintained baseline is Node 26.12.0 on Pi 1.5.0. Test files and package-local scripts are checkout-only and excluded from the tarball.

## Architecture

- `index.ts`: tool registration, run admission, settle notices, and session-start recovery.
- `src/store.ts`: run paths, atomic metadata writes, bounded reads, process identity checks, retention.
- `src/launch.ts`: detached spawn and process-group termination.
- `src/notice.ts`: notice framing, excerpt truncation, and duration formatting.

## Behavioral invariants

- `background_task` launches `$PI_BACKGROUND_PI` (default `pi`) `--fork <PI_SESSION_FILE> --session-id <run id> --name <title> -p <prompt>` with `detached: true`, then returns immediately. A missing binary fails with the command and the `PI_BACKGROUND_PI` override in the error. `<prompt>` is the caller's task prefixed with `WORKER_NOTE` from `src/launch.ts`.
- The note states that the run is detached, no one will answer questions, the final message is the report, and nested dispatch is forbidden unless the task requires it. It belongs to the user message, so the system prompt and forked history remain byte-identical to the parent for prompt caching.
- Runs live under `<agent dir>/background/<parent session id>/<run id>/`; the forked session lives in the normal project session directory.
- At most four concurrent runs per session and at most two nesting levels. Dispatch fails closed when a persisted session file is unavailable.
- Each run records `etaMinutes` (default 10), an `etaFrom` base, and `etaPending` once a reminder goes out. `reminderState` in `src/notice.ts` returns `none`, `remind`, or `missing`: nothing before the window ends, a reminder once per `etaMinutes` interval, and an error when a reminder was never answered. `background_eta` calls `applyEta` to rebase `etaFrom` from now, clear `etaPending`, and reset the count. Metadata writes use a unique temp file and a per-run in-process lock; a reminder records its attempt before sending, so a failed write never repeats every poll. `background_list` resolves worker transcripts with one `sessionFiles` index per call. The reminder is a separate `background-task-eta` message and never replaces or suppresses the settle notice. It supplies facts plus the obligation to tell the user, and carries no voice or phrasing rules, because the same transport serves any agent.
- One notice per settled run, sent with `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` and a 1,200 character excerpt. An explicit `background_kill` settles silently and records `notified: true`, so it is never announced or retried; other runs keep a failed send as `notified: false` so `session_start` recovery retries.
- `background_kill` signals the process group with SIGTERM and escalates to SIGKILL after four seconds. Never signal this process's own group.
- `session_start` recovery finalizes dead running runs and resends unnotified reports. Retention keeps running runs and undelivered notices, and removes settled runs older than 30 days or beyond the newest 25.
- Liveness checks prefer the `PI_BACKGROUND_RUN` environment marker because Pi rewrites `process.title` and `/proc/<pid>/cmdline`. The cmdline check is only a fallback for callers without that marker.
- Print mode does not stream; the report exists only after the worker settles.
- The worker sees the conversation as of the fork and inherits the service environment. Never persist provider credentials or write another extension's runtime state.
