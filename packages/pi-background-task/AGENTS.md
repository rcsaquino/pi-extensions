# Working on @rcsaquino/pi-background-task

Read [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). This package forks the current Pi session into a detached `pi -p` process. It is not an orchestrator, keeps no agent definitions, and does not change the worker's tools or prompt.

## Setup and verification

From the monorepo root:

```sh
npm --prefix packages/pi-background-task install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-background-task run check
npm --prefix packages/pi-background-task test
```

Tests are offline and cover notice framing and retention. The maintained baseline is Node 26.12.0 on Pi 1.3.0. Test files and package-local scripts are checkout-only and excluded from the tarball.

## Architecture

- `index.ts`: tool registration, run admission, settle notices, and session-start recovery.
- `src/store.ts`: run paths, atomic metadata writes, bounded reads, process identity checks, retention.
- `src/launch.ts`: detached spawn and process-group termination.
- `src/notice.ts`: notice framing, excerpt truncation, and duration formatting.

## Behavioral invariants

- `background_task` launches `pi --fork <PI_SESSION_FILE> --session-id <run id> --name <title> -p <task>` with `detached: true`, then returns immediately.
- Runs live under `<agent dir>/background/<parent session id>/<run id>/`; the forked session lives in the normal project session directory.
- At most four concurrent runs per session and at most two nesting levels. Dispatch fails closed when a persisted session file is unavailable.
- One notice per settled run, sent with `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` and a 1,200 character excerpt. A failed send leaves `notified` false so `session_start` recovery retries.
- `background_kill` signals the process group with SIGTERM and escalates to SIGKILL after four seconds. Never signal this process's own group.
- `session_start` recovery finalizes dead running runs and resends unnotified reports. Retention keeps running runs and undelivered notices, and removes settled runs older than 30 days or beyond the newest 25.
- Liveness checks prefer the `PI_BACKGROUND_RUN` environment marker because Pi rewrites `process.title` and `/proc/<pid>/cmdline`. The cmdline check is only a fallback for callers without that marker.
- Print mode does not stream; the report exists only after the worker settles.
- The worker sees the conversation as of the fork and inherits the service environment. Never persist provider credentials or write another extension's runtime state.
