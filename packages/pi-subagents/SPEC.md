# pi-subagents: specification

Draft 14, reviewed and implemented.
Date: 2026-10-20
Supersedes: pi-background-tasks as the maintained delegation extension.

This is the current design, not a permanent contract. It will change as the
extension is used. Each accepted change gets a short entry in section 20 and a
matching edit here, so the document always describes what is actually built.

## 1. Purpose

Give the main agent a way to hand a self-contained job to a separate pi process,
keep chatting while it runs, correct its course without restarting it, and
receive one report when it settles.

A subagent is a user-defined directory holding a prompt and optional capability
overrides. The extension launches it as a headless pi process in RPC mode,
supervises it, and injects the result into the parent session as a follow-up
notice.

The extension is a launcher and a supervisor. It is not an orchestrator, ships
no agents of its own, and has no transport integration.

## 2. Non-goals

- Teams, rosters, scheduling, or agent-to-agent coordination.
- Recursive delegation. A subagent cannot dispatch another subagent.
- Self-improvement, automatic retries, or re-planning.
- Workspace locks, leases, staged brokers, or publication approval.
- Conversation history inheritance. Briefs are files, not transcripts.
- Background execution inside the parent process. Workers are real processes.
- Cross-platform support. Liveness and process-group control rely on Linux
  `/proc`, boot ids, and POSIX process groups.
- Per-job capability changes. Capability lives in `agent.json` (section 6).
- Bundled agent definitions. The extension provides the mechanism only.
- Transport routing or chat ownership. Delivery belongs to whichever UI or
  transport is attached to the session.

## 3. Vocabulary

| Term | Meaning |
| --- | --- |
| Main agent | Eve, the interactive session that dispatches work. |
| Subagent | A named definition under `~/.pi/agent/subagents/<name>/`. |
| Run | One execution of one subagent for one brief. |
| Brief | The complete, self-contained job description. |
| Report | The subagent's final visible message, captured at settlement. |
| Steering | An instruction sent into a running worker, delivered between turns. |
| Supervisor | The small Node process that owns one worker's RPC session. |
| Notice | A hidden follow-up message injected into the main session when a run settles; its turn produces the reply the user sees. |

Hierarchy: sir, then Eve, then subagents. A subagent works for Eve, reports to
Eve, and never addresses sir.

## 4. Directory layout

```
~/.pi/agent/subagents/
  <name>/
    prompt.md     required, the static appended system prompt
    description.md         optional, one-line summary for the prompt
    agent.json             optional, capability overrides
    runs/
      20261020-081500-a1b2c3/
        task.json          run record, written only by the extension
        brief.md           exact brief handed to the worker
        argv.json          exact pi argv, no shell interpolation
        supervisor.ready   written once the worker has spawned
        settling           present while finalization excludes new steers
        supervisor.log     supervisor diagnostics only
        child.log          worker stderr
        dialogs.json       denied-dialog count, written by the supervisor
        report.md          captured final message, atomic rename, max 2 MiB
        exit.code          atomic exit status
        exit.reason        optional fixed reason, atomic
        session/           worker pi session files
        steer/
          0001.json        queued steering message
          0001.ack         delivery acknowledgement
```

Root resolution: `$PI_CODING_AGENT_DIR/subagents`, defaulting to
`~/.pi/agent/subagents`. No other root. A relative `PI_CODING_AGENT_DIR` is
rejected; prompt assembly then omits the subagent section and dispatch reports
the error, so one malformed override does not fail every turn.

The root may be absent or empty. Both are valid states: the extension loads,
lists no agents, and rejects dispatch with "no agents defined".

### 4.1 Discovery

- A directory is a definition if and only if it contains a regular `prompt.md`.
- `runs/` is reserved and never a definition. The name `runs` is therefore
  reserved as well.
- Dot-directories are ignored.
- Discovery happens on every dispatch and before every agent run. Nothing is
  cached at startup, so a new or edited subagent applies on the next call with
  no reload.
- `description.md` is optional and never affects whether a directory is a
  definition.
- Name rule: `^[a-z0-9][a-z0-9_-]{0,63}$`. Name is the directory name and the id.

Unknown name: error listing available definitions.
Missing or non-regular `prompt.md`: not listed, with a validation warning.

### 4.2 Create and delete

- Create: `mkdir subagents/<name>` and write `prompt.md`. Nothing else required.
- Delete: `rm -rf subagents/<name>`. Its runs go with it. This is intended.
- Deleting an agent while a run is active leaves the supervisor running with a
  vanished run directory. The supervisor detects this within one poll and aborts
  the worker (section 7.4). Nothing is replayed and no record survives.

### 4.3 Context listing

- `description.md` is optional, 1 byte to 4 KiB, plain text.
- Whitespace is collapsed to a single line; the rendered text is capped at 400
  code points on a word boundary, including the trailing ellipsis when truncated.
- Before every agent run, discovery runs and described definitions are rendered
  as `- <name>: <description>` in the `subagents` system prompt section, which
  Pi wraps as `<subagents>...</subagents>`.
- A definition without a description is still dispatchable and still appears in
  `subagent_tasks`; it is simply not advertised in the prompt.
- No section is added when no definition has a description.

## 5. prompt.md

- Static file, 1 byte to 16 KiB, plain Markdown.
- Passed with `--append-system-prompt`, so it replaces the discovered
  `APPEND_SYSTEM.md`. The main agent's EVE addendum is never inherited.
- It must not restate job content. Job content lives in the brief.
- It may state identity, principal, reporting discipline, and refusal rules.
- It must mention that Eve may steer mid-run: steering messages are updated
  instructions, not a new brief, and completed work must not be redone.
- It must say that the final message is the report, and that the principal is
  Eve, never sir.

The extension ships no `prompt.md` files. Every definition, including the
background worker, is authored outside the package and lives only under the
subagents root.

## 6. agent.json

Optional. Absence means the minimal default: builtin tools only, no extensions,
no skills, same provider/model/thinking as the main agent.

Schema, additional properties rejected:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `extensions` | string[] | `[]` | Entries passed as `-e`. `builtin:mcp` allowed; absolute paths or `builtin:<name>` only. |
| `skills` | string[] | `[]` | Directories passed as `--skill`, absolute paths only. |
| `excludeTools` | string[] | `[]` | Builtin tools to remove with `-xt`. Values limited to read, bash, edit, write. |
| `model` | string | main's | Exact model ID or `provider/model`; no patterns. |
| `thinking` | enum | main's | One of off, minimal, low, medium, high, xhigh, max. |
| `timeoutSeconds` | integer | 14400 | Hard wall-clock cap, 60 to 604800. |
| `maxTurns` | integer | 300 | Safety cap on assistant turns, 1 to 1000. |

Rules:

- Unknown keys and unknown tool names are hard errors, not ignored.
- Capability is decided only here. A dispatch chooses the agent and the job; it
  cannot add, remove, or reschedule capability.
- `extensions` and `skills` are the only way to add capability. There is no
  inheritance from the main agent's package list.
- Absolute `extensions` and `skills` paths must exist at dispatch; `builtin:`
  entries are resolved by Pi.
- `excludeTools` is a denylist, not an allowlist. Extension tools keep working
  when a definition narrows the builtins, and no tool list needs to be pinned.
- Validation errors block dispatch of that agent with a clear message. Other
  agents remain usable.

Example, for a definition that wants MCP and read-only file access:

```json
{
  "extensions": ["builtin:mcp"],
  "excludeTools": ["bash", "edit", "write"],
  "timeoutSeconds": 7200,
  "maxTurns": 150
}
```

The extension ships no definitions. Once installed, the root may be empty until
the first agent is authored.

## 7. Runtime architecture

Each run has two long-lived processes in two process groups:

1. The extension starts the supervisor directly with `spawn(process.execPath,
   [supervisor.mjs, runDir], { detached: true, stdio: "ignore", cwd: runDir })`.
   `detached: true` makes the supervisor a session and group leader, so its pid
   is its pgid. The extension calls `unref()` and keeps no handle.
2. The supervisor starts the worker as a child in RPC mode, in its own process
   group (`detached: true`), and speaks JSONL on its stdin and stdout. The
   worker's pgid is its pid, and every tool subprocess inherits it.

Two groups are required: the supervisor must be able to kill the worker and all
of its children without killing itself. The supervisor installs SIGTERM and
SIGINT handlers; a signal starts the cancel path and never exits on the default
disposition, unless the `settling` marker is present, in which case it is logged
and ignored. It also sets `PI_SUBAGENTS_WORKER=1` in the worker environment, and
the extension refuses dispatch when that variable is set, so a definition that
explicitly loads this package cannot recurse.

The supervisor records its parent pid, boot id, and `/proc` start ticks at
startup and checks them on a dedicated 500 ms timer. If the parent is gone, is a
zombie, or its start ticks changed, the supervisor does not start a new run.
Outside finalization it sends SIGKILL to the worker's process group; during
finalization it lets the report write finish. It keeps any report already
captured, writes `exit.reason` `parent_gone` and `exit.code` 131, and exits. This
path is independent of the extension and of the RPC loop, so a blocked request
cannot delay it. A subagent is killed within one 500 ms check after the Pi
process dies and never starts a new run; the only exception is finishing a report
already captured.

Why a supervisor instead of spawning `pi -p` directly:

- RPC is the only supported way to steer a live session.
- The supervisor survives an extension reload, but not the Pi process: it watches
  the parent and kills the worker when the parent dies.
- Timeout, turn limit, and cancellation keep working even if the extension is
  not loaded.
- Steering is delivered through files, so it also works after a reload.

`supervisor.mjs` ships with the package. It is not generated per run, and it is
the only code allowed to parse worker protocol output.

### 7.1 The worker command

`argv.json` holds the exact argv array, including the executable as element 0.
The supervisor spawns `argv[0]` with `argv.slice(1)`, never builds a shell
command, and never splits strings.

```
pi
--mode rpc
-ne -ns -np
--append-system-prompt <prompt.md>
[--provider <provider>] --model <model> --thinking <level>
[-xt <comma-joined excluded tools>]
[--skill <path>]...
[-e <agent extension>]...
--session-dir <run>/session
```

Notes:

- No `-p`. RPC mode is inherently headless and stays alive for steering.
- Provider is passed only when `model` has no `/`; a qualified model goes to
  `--model` alone, and an unqualified override uses the main session's provider.
  An unqualified ID must resolve to exactly one model; an ambiguous ID is a
  validation error. A `:thinking` suffix is rejected so `--thinking` remains the
  only source of the level. The extension resolves the model against the current
  model registry, checks that credentials are configured, and validates the
  thinking level against the allowed values before dispatch; an unknown or
  unauthenticated model is a validation error, not a failed run.
- `-ne` disables discovered, configured, and built-in extensions. The only
  extensions are the explicit `agent.json` entries; none are mandatory.
- `-ns` and `-np` disable skills and prompt templates. Explicit `--skill` paths
  from `agent.json` still load.
- Context files are not suppressed, so `~/.pi/agent/AGENTS.md` and any project
  `AGENTS.md` still apply.
- `cwd` is required at dispatch and validated as an existing directory. It is
  never inferred from the definition directory.
- The child inherits the service environment, so provider credentials remain
  available.
- Every path is validated and absolute, written by the extension, never derived
  from the brief.

### 7.2 Protocol handling

The supervisor is a strict JSONL client:

- Read stdout as a byte stream and split only on LF, stripping one optional CR.
  Never use `readline`, which also splits on U+2028 and U+2029. Decode with a
  streaming UTF-8 decoder so a multibyte character is never split across chunks.
- Frame chunks into one fixed 8 MiB buffer; never concatenate an unbounded
  number of chunks. Reject any line or unterminated buffer over 8 MiB, log,
  destroy stdout, release the buffer, and exit 4 without waiting the normal
  10-second worker-exit grace.
- EOF on stdout before `agent_settled` is a protocol failure, even if the worker
  process has not exited yet.
- Drain stdout continuously; a stalled reader stalls the worker.
- Send one JSON object plus LF per command, honoring stdin backpressure.
- Treat stderr as diagnostics only, never as protocol. Drain it continuously to
  `child.log`; a full pipe would stall the worker.
- Correlate responses by the optional `id`; do not assume response order.

### 7.3 Headless UI policy

RPC mode reports extension dialogs as `extension_ui_request`. No human is
present, so the supervisor must answer them, or a run hangs until timeout.

- Dialog methods (`select`, `confirm`, `input`, `editor`): immediately respond
  with `{"type":"extension_ui_response","id":"<id>","cancelled":true}`.
- Fire-and-forget methods (`notify`, `setStatus`, and similar): ignore.
- Every request is logged to `supervisor.log` with method, title, and decision.
- Each cancellation increments a counter written atomically to `dialogs.json`,
  which is how the extension records `deniedDialogs` without writing the run
  record from the supervisor.
- A denied dialog is not a run failure. The worker sees the refusal, adapts, and
  continues, or reports that it is blocked.
- The count of denied dialogs is recorded and included in the failure notice if
  the run later fails.

### 7.4 Supervisor loop

1. Read `task.json` and `argv.json`. Refuse to start if either is invalid. Record
   the parent pid, boot id, and `/proc` start ticks. Write one startup line to
   `supervisor.log` with pid, pgid, parent pid, cwd, and argv.
2. Verify `cwd` exists; if not, write `exit.code` 97 and exit. If the parent is
   already gone, write `exit.reason` `parent_gone`, `exit.code` 131, and exit
   before spawning the worker.
3. Spawn `pi` with the argv, cwd, piped stdin/stdout, stderr to `child.log`,
   `detached: true`, and env `PI_SUBAGENTS_WORKER=1`. If spawn fails, log the
   error, write `exit.reason` `spawn_error`, write `exit.code` 4, and exit.
4. Write `supervisor.ready` atomically with the supervisor pid, pgid, worker
   pid, worker pgid, worker start ticks, and start time. If that write fails,
   kill the worker's process group, write `exit.code` 74 if possible, and exit; a
   worker must never outlive a supervisor that could not publish its identity.
5. Start the timeout clock, the turn counter, and the 500 ms parent-liveness
   timer. The timeout uses a monotonic clock. The counter increments on each
   `turn_end`; reaching `maxTurns` aborts the worker and finalizes with exit 5.
   The parent timer is independent of the RPC loop.
6. Set steering mode to `one-at-a-time`, then send the brief as the initial
   `prompt` command. If the parent is gone, finalize with 131 instead of sending
   the brief. A rejected prompt finalizes with exit 4 and the RPC error in
   `supervisor.log`. A `handled` disposition also finalizes with exit 4, because
   an input handler consumed the brief and no run will settle.
7. Every 500 ms: check the run directory still exists, forward new steer files,
   and enforce the timeout and turn cap. Before forwarding a steer, re-check the
   parent; if it is gone, skip the forward and finalize with 131.
8. On `agent_settled`:
   - If the parent is gone, skip the steer scan and finalize with exit 131.
   - If the supervisor requested the abort (cancel, timeout, or turn limit), skip
     the steer scan and finalize with the pending code.
   - If it reports `aborted` without a supervisor request, write `exit.reason`
     `aborted` and finalize with exit 4.
   - Otherwise run a final steer scan. If any exist, concatenate them in
     sequence order and send one normal `prompt`, which starts a new run; a
     `steer` command only queues while the agent is idle and would never revive
     it. Re-check the parent immediately before sending that prompt; if it is
     gone, skip the scan and finalize with exit 131. Then wait for the next
     settlement instead of exiting.
9. When a scan finds none, finalization begins: capture the text of the final
   assistant message from its `message_end` event. Track the current run
   generation from `agent_start`, and accept only a `message_end` from that
   generation. If no such message exists, the report is empty. Do not pull text
   from an earlier assistant message or from `get_last_assistant_text`. Do not
   trim. Cap at 2 MiB with a truncation marker, and treat whitespace-only text
   as empty. If the parent dies during finalization, set the pending code to 131
   and do not start a new run; the report write continues.
10. Write `exit.reason` first when the reason is not implied by the code, then
    `exit.code` atomically. If the parent is gone, use `parent_gone` and 131 even
    when a report exists. Close stdin, wait up to 10 seconds for the worker,
    then SIGKILL the worker's process group even if the worker already exited,
    to reap background children. Before any group kill, verify that the group's
    process session id still equals `workerPid` and that at least one member
    started at or after `workerStartTicks`. If the group is empty or the process
    session id no longer matches, skip the kill. The supervisor never signals its
    own group.
11. Exit.

When the parent-liveness timer fires before finalization, it sends SIGKILL to
the worker's process group, after the same group-ownership check used in step
10, keeps any report already captured, writes `exit.reason` `parent_gone` and
`exit.code` 131, and exits. If finalization has begun, it only sets the pending
code; the report write completes. If `exit.code` is already written, the timer
does nothing. The timer and the main loop share one pending code; the first to
write `exit.code` wins, and the other path stops. The timer never starts a new
run, even if a steer file is present.

Every RPC request has a 30 second response timeout, except `abort`, which gets
2 seconds so the cancel path stays inside the extension's 15 second backstop. A
timed-out request is a protocol failure; the report is still taken only from the
final run's `message_end`, or is empty if none arrived. Startup failures that can
still write the run directory record `exit.code` 4 for invalid input or 74 for
I/O before exiting. Uncaught exceptions are written to `supervisor.log` and,
when the run directory is still writable, `exit.code` 4 before exiting.

Timeout is measured on a monotonic clock and is suspended when finalization
begins. If a final steer revives the run, the clock resumes with its remaining
time. Once step 9 starts and no steer revives the run, neither timeout nor
cancel can kill it; the report is written and the run ends `done` (or exit 3 for
an empty report).

`child.log` and `supervisor.log` are capped at 1 MiB. When a log passes the cap,
the supervisor keeps the last 256 KiB and prepends a truncation marker. Logs are
diagnostics; losing old lines never changes a run's outcome.

If the run directory disappears, abort the worker, kill the worker's process
group, and exit 6. Code 6 is supervisor-internal: there is nowhere to record it,
so the extension never observes it. The worker must not keep spending tokens.

### 7.5 Exit codes

These values are written to `exit.code`, except 6. The extension never reads a
process exit status from a detached supervisor.

| Code | Meaning |
| --- | --- |
| 0 | `agent_settled`, non-empty report |
| 3 | settled with an empty report |
| 4 | protocol failure, self-abort (`exit.reason: aborted`), worker spawn failure (`exit.reason: spawn_error`), or worker exited before `agent_settled` |
| 5 | `maxTurns` reached |
| 74 | I/O failure while writing run files |
| 97 | `cwd` missing at supervisor start |
| 124 | timeout |
| 130 | cancelled through SIGTERM |
| 131 | parent Pi process gone |

Code 6 is reserved for the supervisor-internal case where the run directory
disappeared. It is never written, because there is nowhere to write it, so the
extension never observes it. A deleted run directory is reconciled from live
state: `orphaned` with `unrecorded_exit` when a record survives, and nothing at
all when the whole definition directory is gone.

## 8. Run lifecycle

States: `running`, `done`, `failed`, `cancelled`, `orphaned`.

1. Dispatch reconciles owned runs, then validates agent, `agent.json`, `cwd`,
   and limits.
2. Run id generated as `<YYYYMMDD-HHMMSS>-<6 lowercase hex>`, from local
   dispatch time and 3 random bytes. The directory is created with `mkdir` at
   mode 0700, which fails if it exists; a collision retries with fresh random
   bytes up to 5 times, then dispatch fails with `run_id_collision`. `task.json`
   is written atomically immediately after.
3. `brief.md` written atomically, with an envelope header:

```markdown
# Brief

From: Eve
To: subagent <name>
Dispatched: <ISO time>
Working directory: <cwd>
Deadline: <ISO time> (dispatch time plus timeoutSeconds)
Tools: as declared in agent.json
Report: your final message

---

<task body>
```

4. `argv.json` written, then the supervisor spawned directly, detached.
   Supervisor pid, pgid, boot id, and start time recorded in `task.json`. The
   tool waits up to 2 seconds for `supervisor.ready`, then parses it and records
   `workerPid`, `workerPgid`, and `workerStartTicks`.
   - Ready: the run id is returned.
   - No ready file, the ready file is invalid, or the supervisor is already
     gone: the extension reads the ready file once more, then sends SIGTERM to
     the supervisor. If the ready file appeared, it records the worker fields
     and kills the worker group after the supervisor exits. After 2 seconds it
     sends SIGKILL to the supervisor group, but only while the supervisor's pid
     and start ticks still match. It marks the run `failed` with `spawn_error`,
     or with the status mapped from `exit.code` when that file exists, so an I/O
     or cwd failure is recorded accurately. It returns an error with the run id
     and the last supervisor log line. No notice is queued, because the caller
     already has the error.
5. Supervisor starts the worker, writes `supervisor.ready`, sends the brief as
   the initial prompt, and waits.
6. Settlement happens on `agent_settled`, not `agent_end`, because retries,
   compaction recovery, steering, and follow-ups follow `agent_end`.
7. Supervisor captures the final assistant text, writes `report.md`, then writes
   `exit.reason` when needed, then `exit.code`, and exits.
8. The extension watcher sees the supervisor process gone, maps the exit code
   and optional `exit.reason` to a status, and updates `task.json`.
9. A notice is attempted for every settled run owned by the current session
   (section 11).

Status mapping:

| Exit code | Status | Reason |
| --- | --- | --- |
| 0 | `done` | none |
| 3 | `failed` | `empty_report` |
| 4 | `failed` | `exit.reason` when it is `aborted` or `spawn_error`; otherwise `protocol_error` |
| 5 | `failed` | `turn_limit` |
| 74 | `failed` | `io_error` |
| 97 | `failed` | `cwd_missing` |
| 124 | `failed` | `timeout` |
| 130 | `cancelled` | `cancelled` |
| 131 | `cancelled` | `parent_gone` |
| other nonzero | `failed` | `exit_<code>` |
| no exit file, process gone, cancel requested | `cancelled` | `cancelled` |
| no exit file, process gone | `orphaned` | `unrecorded_exit` |
| no exit file, supervisor alive, stale `settling` | `failed` | `finalization_timeout` |

Timeout is a failure, not a cancellation. Eve's cancel and a parent-process exit
produce `cancelled`; a timeout remains `failed`. Exit 4 normally uses
`protocol_error`; a self-aborted settlement uses `aborted`, and a worker spawn
failure uses `spawn_error`.

Retries: none. A failed run stays failed and is visible in `subagent_tasks`.

### 8.1 Watcher and reconciliation

Session identity comes from the session manager: `sessionId` is the current
session's id and `sessionFile` is its absolute path. Dispatch requires both. An
ephemeral session started with `--no-session` is refused with "subagent dispatch
requires a saved session", because its runs could never be revisited and a
pending notice would be uncollectable.

- Each run belongs to the session recorded in `sessionId`. The extension reads,
  writes, lists, reconciles, and injects notices only for runs owned by its
  current session.
- While the current session has any run with status `running`, the extension
  polls once per second: it checks the supervisor's liveness with `pid`, boot id,
  and start ticks, and looks for `exit.code`.
- When a supervisor is dead, map the code and optional reason if `exit.code`
  exists, or map to `cancelled` when `cancelRequestedAt` is set and to
  `orphaned` otherwise. In every case, before marking the run, inspect the
  worker group: if its process session id equals `workerPid` and any member
  started at or after `workerStartTicks`, send SIGKILL to `-workerPgid`. A dead
  supervisor must not leave a spending worker or its children behind.
- If `exit.code` exists but the supervisor is still alive, the extension waits
  up to 15 seconds for it to exit, then kills the supervisor group and the
  worker group, each only while its process session id and start ticks still
  match, and settles from the code. A stuck supervisor never leaves a finished
  run `running`.
- If the supervisor is alive, `settling` is present, and its mtime is older than
  60 seconds, finalization is hung. The extension re-checks the marker
  immediately before signalling; if it is gone, it skips the kill. Otherwise it
  sends SIGKILL to the supervisor group and the worker group, each only while
  its process session id and start ticks still match, and marks the run `failed`
  with `finalization_timeout`. A report already written is kept.
- `task.json` updates for one run are serialized through a per-run promise
  chain, so a watcher update, a cancel request, and a notice update cannot
  overwrite each other.
- Every tool call reconciles owned runs before reading or acting, so a stale
  `running` record is corrected before it affects a limit, a list, or a cancel.
- `session_start` replaces the owned set, clears any timer left by the previous
  session, performs the same reconciliation, and then injects any pending
  notices for that session. `session_shutdown` clears the timer and stops
  polling; it does not cancel runs. The supervisor's parent watchdog handles
  process death; a session switch or extension reload leaves the Pi process
  alive, so it does not fire.
- If a `running` record lacks supervisor or worker fields but `supervisor.ready`
  is valid, the extension repairs the record from that file before reconciling.
- A run dispatched from a session that is no longer open is left alone. It is
  reconciled when that session is opened again; its notice is never injected
  into a different session.
- The polling timer stops when no owned run is running. There are no background
  timers for other sessions.

### 8.2 Shutdown and service lifecycle

The supervisor and worker are in their own sessions, not in Pi's process group.
The supervisor also watches the parent Pi pid on a 500 ms timer. A Pi exit kills
the worker and the supervisor. An extension reload or session switch leaves the
parent alive, so it does not.

| Trigger | Supervisor and worker | Run record and notice |
| --- | --- | --- |
| `systemctl disable` only | Nothing. Disable changes boot behavior; it does not stop a running unit. | Unchanged. |
| Ctrl+D or TUI quit | Pi exits. The parent watchdog fires within 500 ms, sends SIGKILL to the worker group, and exits 131. A cgroup kill or a service SIGTERM may win the race. | `cancelled` with `parent_gone` when 131 is written; `cancelled` with `cancelled` if SIGTERM wrote 130; `orphaned` if the cgroup killed it first. A report already captured is kept; the notice stays pending. |
| Pi killed, no cgroup kill | Same as Ctrl+D. | Same. |
| `systemctl stop`, `disable --now`, or `restart` with the default cgroup kill | The cgroup may kill the supervisor before the watchdog; either way no worker survives. | `cancelled`/`parent_gone` if 131, `cancelled`/`cancelled` if SIGTERM wrote 130, otherwise `orphaned`. Partial reports are kept; notices stay pending. |
| Host reboot | All processes die; the watchdog may write 131 before the reboot. | `cancelled`/`parent_gone` if 131, `cancelled`/`cancelled` if SIGTERM wrote 130, otherwise `orphaned`. Notices stay pending. |
| Unit disabled and never started again | The parent watchdog killed in-flight runs when Pi exited; there is no reconciliation. | `task.json` can lag; pending notices are protected from cleanup. |

Notes:

- `systemctl disable` alone does not stop a running service. If the agent died,
  the cause is a stop, restart, reboot, or cgroup kill, not the disable.
- Systemd's default `KillMode=control-group` kills detached children too. With
  `KillMode=process`, the cgroup does not; if Pi also exits, the parent watchdog
  still ends the run with 131.
- Whether a Pi exit or kill also triggers a service restart depends on the unit.
  The current unit uses `Restart=always`; a restart applies the cgroup row.
- The parent watchdog is independent of the extension. An extension reload or
  session switch leaves the Pi pid alive and does not kill a run.
- `task.json` is written only by the extension. While Pi is down, it can lag; the
  supervisor's `exit.code` and `report.md` are the authoritative output.
- A parent death is a cancellation, not an orphan, when 131 is written. The
  final steer scan never starts a new run after the parent is gone.
- A notice for a closed session is never injected elsewhere. It is delivered on
  the next `session_start` for that session.

## 9. task.json

The run record is written only by the extension, never by the supervisor. It is
rewritten atomically (temp file plus rename) at dispatch, on cancel request, and
on every notice or status update.

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | integer | `1`. |
| `id` | string | Run id, also the directory name. |
| `agent` | string | Definition name. |
| `title` | string | Dispatch title. |
| `cwd` | string | Absolute working directory. |
| `sessionId` | string | Dispatching session. The ownership key. |
| `sessionFile` | string | Absolute owning session file. Required at dispatch. |
| `status` | enum | running, done, failed, cancelled, orphaned. |
| `createdAt` | ISO string | Dispatch time. |
| `startedAt` | ISO string | Supervisor spawn time. |
| `finishedAt` | ISO string | Settlement time, optional. |
| `cancelRequestedAt` | ISO string | Optional, time cancel was requested. |
| `provider` | string | Resolved provider. |
| `model` | string | Resolved model. |
| `thinking` | string | Resolved thinking level. |
| `timeoutSeconds` | integer | Effective value. |
| `maxTurns` | integer | Effective value. |
| `pid` | integer | Supervisor pid; optional until spawn. |
| `pgid` | integer | Supervisor process group; optional until spawn. |
| `workerPid` | integer | Worker pid, from `supervisor.ready`; optional until ready. |
| `workerPgid` | integer | Worker process group, from `supervisor.ready`; optional until ready. |
| `workerStartTicks` | integer | Worker `/proc/<pid>/stat` field 22; optional until ready. |
| `bootId` | string | `/proc/sys/kernel/random/boot_id` at spawn; optional until spawn. |
| `startTicks` | integer | `/proc/<pid>/stat` field 22; optional until spawn. |
| `exitCode` | integer | Optional until settlement. |
| `reason` | string | Optional failure reason; `exit.reason` wins when present. |
| `reportBytes` | integer | Optional, size read at settlement. |
| `steerCount` | integer | Successfully forwarded steering messages. |
| `deniedDialogs` | integer | Headless UI requests auto-cancelled. |
| `notice` | enum | Absent while running or after a spawn failure; pending, sent, or failed after settlement. |
| `noticeAttempts` | integer | Incremented before each injection attempt. |
| `noticeAt` | ISO string | Optional, time of the last successful injection. |
| `noticeNextAttemptAt` | ISO string | Optional, earliest retry time after a transport failure. |

Unknown fields are preserved on rewrite. A missing or unreadable `task.json`
makes the run invisible to `list`; it is never reconstructed from logs. The
extension is the only writer of `task.json`; `deniedDialogs` is copied from
`dialogs.json` during reconciliation, not written by the supervisor. A
`schemaVersion` other than `1` is listed as incompatible and is never acted on,
so a newer run directory cannot be corrupted by an older extension.

## 10. Steering

Purpose: sir asks for a change during a run; Eve passes it into the same worker
session without losing completed work.

Tool: `subagent_steer` (section 12.2).

Flow:

1. The tool validates the run is `running` and the message is 1 to 8000 chars.
2. It allocates the next sequence by creating `steer/<sequence>.json.tmp` with
   `O_EXCL`, writes the message and timestamp, then renames it to
   `steer/<sequence>.json`. Concurrent steers therefore get distinct numbers,
   and the supervisor never reads a partial file.
3. The supervisor polls the steer directory every 500 ms and forwards new
   messages in ascending sequence order. A message sent while the worker is
   streaming goes as an RPC `steer` command, which delivers after the current
   tool batch and before the next model call. If that command is rejected, the
   supervisor retries it as a `prompt` on the next poll instead of acking it.
4. If the worker is between runs but not settled, which the supervisor knows
   from its `agent_start` and `agent_end` tracking, it sends a normal `prompt`
   command instead. A rejected prompt leaves the file unacknowledged for the
   next poll.
5. The supervisor writes `<sequence>.ack` atomically with the disposition:
   `queued` (steer accepted), `started` (prompt accepted), `settled` (too late,
   not forwarded), or `rejected` (invalid).
6. The tool waits up to 2 seconds for the ack. A timeout is not proof of
   non-delivery: the file stays in place and the tool returns "not confirmed",
   never "delivered". The tool never deletes an unacknowledged file; pruning
   removes it with the run.
7. On `agent_settled`, the supervisor writes a `settling` marker, waits 500 ms
   for in-flight steer writes to land, then performs a final steer scan. Any
   steers found there are concatenated in sequence order and sent as one normal
   `prompt`, because a `steer` command only queues while the agent is idle and
   would never revive it. A rejected prompt is a protocol failure; finalize with
   exit 4. `settling` is removed, the timeout resumes with its remaining time,
   and the run continues.
8. If the final scan is clean, the supervisor keeps `settling` for another
   500 ms, scans once more, and leaves the marker in place through exit. This
   closes the polling and exit windows without a lock. The marker is removed
   early only when a final steer revives the run. A steer file that lands after
   the second scan is acked `settled` and left for pruning; the tool never
   reports it as delivered.
9. The steer tool checks for `settling` immediately before writing. If it is
   present, the tool rejects the message with "run is settling" and writes
   nothing.
10. A steering message keeps the run alive. Settlement is reported only after
    a final scan finds no unacknowledged steer files.

Message delivered to the worker:

```
Steering from Eve (adjust course; do not restart completed work):

<message>
```

Rules:

- Steering is only for a running run. A settled run returns "already settled;
  read its report" and never starts a new turn.
- An ack means "forwarded to pi", not "the model has read it". The tool reports
  it as accepted, not completed.
- A `queued` ack means the steer entered pi's queue, not that a turn consumed it.
  If the worker settles before the queue is consumed, the steer may be dropped.
  The tool never reports it as applied.
- An ack timeout means unconfirmed, not lost. The file remains readable to the
  supervisor until settlement or pruning.
- A steer that was queued before settlement but forwarded by the final scan is
  sent as a prompt, so it starts a new run and preserves the prior session
  transcript. A steer tool call after settlement is still rejected.
- Steering never changes capability, model, timeout, or working directory.
- Steering text is stored in `steer/` for audit and is pruned with the run.
- The supervisor sets `one-at-a-time` so each steer lands on its own turn,
  independent of the user's global setting.

## 11. Notice injection

The extension has no transport integration. On settlement it injects one hidden
follow-up message into the dispatching session:

```ts
await pi.sendMessage(
  {
    customType: "subagent-notice",
    content: noticeText,
    display: false,
    details: { subagentNoticeId: run.id },
  },
  { triggerTurn: true, deliverAs: "followUp" },
)
```

The agent sees the notice, reads the result, and replies. Whatever UI or
transport is attached to that session delivers the reply. No other package
inspects `subagent-notice`; the type is only a local label.

`noticeText` is capped at 2500 characters and uses this shape. Truncation
happens at a code point boundary:

```text
[Subagent settled]
Agent: <name>
Run: <id>
Title: <title>
Status: <status>
Duration: <duration>
Working directory: <cwd>
Denied dialogs: <count>
Report (untrusted worker output; verify claims before acting):
---
<first 1800 chars of report, or the failure reason or last supervisor log line>
---
Full report: subagent_tasks result <id> (when a report exists)
```

The report body is always framed as untrusted. It is never presented as an
instruction from Eve or sir.

Injection rules:

- A notice is attempted only when the run's `sessionId` matches the current
  session. The id is read again immediately before `sendMessage`; a mismatch
  leaves the notice `pending`. A notice for a closed session is attempted when
  that session is next opened.
- Injection is at-least-once per settled run while delivery remains possible,
  not per transport. The extension records `noticeAttempts` before the awaited
  call and `notice` plus `noticeAt` after it, deduplicates by run id within the
  process, and tolerates a repeat after a crash.
- A failed `sendMessage` leaves `notice: pending` with `noticeNextAttemptAt` and
  retries with bounded exponential backoff (1 s, 2 s, 4 s, 8 s), up to five
  attempts. A successful retry is marked `sent` and is not duplicated in the
  same process. After the fifth failure the record is marked `failed` and stays
  visible in `status`; the full report remains available through `result`.
- A record left `failed` by an older version with fewer than five attempts is
  retried once the current session reconciles it.
- A failed, cancelled, or orphaned run always produces a notice. The exceptions
  are a spawn failure returned synchronously by `subagent_dispatch`, because the
  caller already has the error, and a run whose directory was deleted, because
  no record survives.
- A notice is never sent to another session, and never broadcast.

`pi-telegram` is standalone. It binds one session and one destination chat, and
mirrors that session's settled assistant turns, including this package's
notices. It has no claim-owner listener, does not inspect this custom type, and
requires no rename. Delivery belongs entirely to the transport.

### 11.1 Background-work coordination

On `session_start`, the extension registers a synchronous provider named
`pi-subagents` under the neutral process-local registry key
`Symbol.for("idle-compaction.background-work.v1")`. `listActiveWork(context)`
returns at most the runs with `status: "running"` whose `sessionId` or
`sessionFile` matches `context.sessionId`, as `{ id, sessionId }` items. It reads
only this package's run records and never calls the retired legacy RPC. The
provider is unregistered on `session_shutdown`. A corrupt foreign registry is
ignored so dispatch remains usable, with one bounded warning; `pi-idle-compaction`
then fails closed for current subagent tools rather than assuming idleness. An
unreadable run root or malformed/incompatible `task.json` throws instead of
returning an empty snapshot.

## 12. Tools

Three tools. No web tools of its own, no staging, no publication.

### 12.1 `subagent_dispatch`

Non-blocking after startup. Writes the brief, starts the supervisor, waits for
`supervisor.ready` for at most two seconds, and returns the run id.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `agent` | string | yes | Definition name. |
| `title` | string | yes | Short single-line label, 1 to 160 chars. |
| `brief` | string | yes | Self-contained job, 1 to 40000 chars. |
| `cwd` | string | yes | Existing absolute directory. |

No capability fields. `excludeTools`, extensions, model, thinking, timeout, and
turn limit come from `agent.json` only. Newlines in `title` are collapsed to
spaces before it reaches a notice. Returns `{ id, status, agent, title }` once
ready is recorded.

Auto-delegation policy stays: for work expected to take over two minutes,
dispatch before starting it, with a complete brief. Manual requests always
delegate. The enforced cap is `timeoutSeconds`.

Description, deliberately short:

> Delegate a self-contained job to a named subagent and keep the chat free.
> Returns after the supervisor reports ready, at most two seconds. Briefs are
> files, not history: include paths, scope, constraints, and completion
> criteria. No worker memory, no recursive delegation. Do not poll; a notice
> arrives when it settles.

### 12.2 `subagent_steer`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | Run id. |
| `message` | string | yes | Instruction, 1 to 8000 chars. |

Description:

> Send an instruction into a running subagent without restarting it. Delivered
> between turns; completed work is preserved. Use when sir changes direction or
> adds a requirement. Delivery is best effort: an accepted steer can still be
> dropped if the run settles first. Not valid after the run settles. Waiting for
> the ack can take up to two seconds.

Returns `{ id, disposition }`, or `{ id, disposition: "unconfirmed" }` on ack
timeout.

### 12.3 `subagent_tasks`

Inspect or cancel without waiting.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | enum | yes | `list`, `status`, `result`, or `cancel`. |
| `id` | string | for status, result, cancel | Run id. |
| `page` | integer | no | `list` page, 1-based, default 1. |
| `offset` | integer | no | `result` character offset, default 0. |

Description:

> Inspect or cancel subagent runs from this session. Use `result` after a notice
> to read a report; do not poll while a run is active.

Actions: `list`, `status`, `result`, `cancel`. All actions are scoped to the
current session; a run from another session is reported as not found.

- `list`: newest first, 20 per page, with id, agent, title, status, created and
  finished times, and duration. `page` is 1-based and defaults to 1. A run with
  an unsupported `schemaVersion` is shown as `incompatible`.
- `status`: the full `task.json` summary for one run. An incompatible run
  returns `incompatible` without interpreting its fields.
- `result`: pages `report.md` only. 12000 characters by default, with an
  `offset` for continuation; the result includes `totalChars` and
  `nextOffset`. Page boundaries back up rather than splitting a UTF-16 surrogate
  pair. A running run returns its status and no report. A terminal run
  with no report returns its status, reason, and the report path if one exists.
  An incompatible run returns `incompatible` and no report.
- `cancel`: checks the `settling` marker, then records `cancelRequestedAt` and
  sends SIGTERM to the supervisor only. The supervisor aborts the worker, waits
  10 seconds, then kills the worker's process group. If the supervisor is still
  alive 15 seconds after the tool returns, the extension kills the supervisor's
  group while its pid and start ticks still match, and the worker's group while
  its process session id equals `workerPid` and a member started at or after
  `workerStartTicks`, as a backstop. A cancel that arrives while the `settling`
  marker is present is refused, the supervisor ignores SIGTERM while the marker
  is present, and an incompatible run is refused.

## 13. Limits, timeout, and cancellation

- Default maximum 4 running subagents per session, configurable with
  `--subagents-max-running` (1 to 16).
- No queue. A dispatch beyond the limit is rejected with a clear message; the
  main agent decides whether to wait or do the work itself.
- Runs from other sessions do not count against the limit and are never touched
  by this session's watcher or cleanup.
- Timeout and `maxTurns` come from `agent.json`. The supervisor enforces both,
  so they survive an extension reload.
- Cancel and timeout share the abort path: RPC `abort` with a 2 second timeout,
  wait 10 seconds, then SIGKILL the worker's process group after confirming its
  process session id equals the worker pid and a member started at or after
  `workerStartTicks`. The supervisor never signals its own group. The difference
  is only the recorded status: `cancelled` for cancel, `failed` with reason
  `timeout` for timeout.
- A cancel requested while `settling` is present is refused; the run finishes
  normally. The marker stays in place through exit, so a cancel cannot truncate
  a report that is already being written. The timeout clock also stops at
  finalization.
- A worker that ignores abort is killed at the 10 second mark.
- Pi shutdown kills children by design. The supervisor watches the parent pid
  and, when it dies, sends SIGKILL to the worker group, keeps any captured
  report, writes `exit.code` 131, and exits. A service manager that kills the
  whole cgroup may win the race; those runs become `orphaned` on the next start.
  Extension reloads and session switches leave the parent alive, so they do not
  kill runs (section 8.2).

## 14. Security

- Run directories are 0700; run files are 0600. The supervisor is spawned
  directly, so there is no launcher script to protect. Definition directories
  are user-authored.
- No secrets are added by the extension to `task.json`, notices, logs, or
  errors. Worker output is untrusted and may contain whatever the worker saw.
- `exit.reason` is a fixed short value such as `aborted` or `spawn_error`, never
  free text, so it cannot carry secrets.
- `child.log` is stderr only, capped continuously and truncated at settlement.
- Reports are worker output and treated as claims, not verified facts.
- Report text is framed as untrusted in every notice and is never rendered as
  an instruction from Eve or sir.
- One extension process owns a session's runs. Concurrent Pi processes sharing
  the same session are unsupported.
- The worker runs in its own process group, separate from the supervisor, so a
  kill cannot take out the supervisor before it records the outcome.
- `PI_SUBAGENTS_WORKER=1` is set for every worker. Dispatch refuses to run with
  that variable set, so recursion is blocked even if a definition explicitly
  loads this package.
- The extension never interpolates brief or steering text into shell commands;
  both travel as JSON strings over RPC.
- `cwd` must exist and be absolute. Symlinks are resolved by the OS; the
  extension does not canonicalize or sandbox the path.
- A subagent runs as the service user with pi's base tools. That is full file
  access, by design. Read-only jobs exclude bash, edit, and write; anything that
  includes `bash` is not read-only.
- No network extension is loaded by default. A definition that includes `bash`
  can still reach the network through the shell, so read-only means no `bash`,
  `edit`, or `write`.
- The definition root is trusted input. Editing `prompt.md` or `agent.json` is
  equivalent to granting capability, the same as editing an extension.
- Steering messages come from the main agent, are bounded, and are never
  executed as commands.
- Headless UI dialogs are auto-cancelled and logged, never bypassed.

## 15. Retention

- On startup and after each settlement: for runs owned by the current session,
  delete runs older than 14 days, then if an agent still has more than 100 runs,
  delete the oldest beyond 100.
- Never delete a running run, a run whose notice is still `pending`, or a run
  with an unsupported `schemaVersion`.
- Runs owned by another session are not touched; they are pruned when that
  session is next opened.
- A directory under `runs/` with no readable `task.json` is debris and is pruned
  for every session once its mtime is older than 14 days. Nothing in it can be
  protected, and the gap between `mkdir` and the first `task.json` write is
  milliseconds.
- Definitions and `prompt.md` are never touched by cleanup.

## 16. Failure modes

| Situation | Behavior |
| --- | --- |
| Unknown agent, bad name | Reject dispatch, list available agents. |
| No agents defined | Reject dispatch with "no agents defined". |
| Ephemeral session (`--no-session`) | Reject dispatch with "subagent dispatch requires a saved session". |
| Invalid `agent.json` | Reject that agent, name the offending key. |
| Unknown model or thinking level | Reject dispatch before writing the run. |
| `cwd` missing | Reject before writing anything. |
| Spawn failure | Run `failed` with `spawn_error` or the recorded exit code; the tool returns the error and no notice is queued. |
| RPC parse or protocol failure | Supervisor logs, aborts, exit 4, partial report kept. |
| Empty report | `failed`, `empty_report`, notice sent with paths. |
| Turn limit | `failed`, `turn_limit`, abort, notice sent. |
| Worker killed externally | Supervisor sees EOF, exit 4, `failed` with `protocol_error`; partial report preserved. |
| Supervisor killed externally | `orphaned` when no exit file; otherwise the recorded code. The extension kills the leftover worker group. |
| Host reboot mid-run | 131/`parent_gone`, 130/`cancelled`, or orphaned if no code; notice pending. |
| Service stop that kills the cgroup | Supervisors and workers die; 131/`parent_gone`, 130/`cancelled`, or orphaned if no code; notice pending. |
| Run directory deleted mid-run | Supervisor aborts within one poll and exits 6 internally; nothing is recorded, so the extension sees a dead supervisor with no exit file. A surviving `task.json` reconciles as `orphaned`/`unrecorded_exit`. |
| Disk write failure | Exit 74, `failed` with `io_error`, never `done`, notice sent. If `exit.code` itself cannot be written, the run ends `orphaned` with `unrecorded_exit` and the notice carries the last supervisor log line. |
| Self-aborted settlement | `failed` with `aborted`; no report treated as success. |
| Steering a settled run | Rejected with "already settled". |
| Steering ack timeout | Tool returns "not confirmed"; the file may still be delivered or is pruned with the run. |
| Extension reload while running | Workers keep running; parent alive, so the watchdog does not fire; steering still works; watcher reconciles on load. |
| TUI exit or Pi SIGKILL | Parent watchdog SIGKILLs the worker and exits 131; `cancelled`/`parent_gone`, `cancelled`/`cancelled` if SIGTERM wins, or orphaned if the cgroup kills first; report kept; notice pending. |
| Session switched before settlement | Run keeps running; notice stays pending; delivered when that session is reopened. |
| Session never reopened | Run remains recorded with a pending notice; it is not delivered elsewhere and is protected from cleanup. |
| Cancel during finalization | Refused; the run completes normally. |
| Supervisor gone with cancel requested, no exit file | `cancelled`, not `orphaned`. |
| Supervisor not ready within 2 seconds | Dispatch returns an error; run recorded as `failed` with `spawn_error`, or with the exit code if one was written. |
| Supervisor hangs with no exit file | Before finalization, cancel manually; the cancel backstop kills the groups. During finalization, a `settling` marker older than 60 seconds is killed. |
| Finalization hangs | `settling` older than 60 seconds, groups killed, `failed` with `finalization_timeout`; a written report is kept. |

## 17. Migration from pi-background-tasks

1. New source at `packages/pi-subagents`, package `@rcsaquino/pi-subagents`,
   version `0.1.0`. No shared code with the old package.
2. `pi-background-tasks` was uninstalled from `settings.json` on 2026-10-20.
   Its source and orphaned runtime data at `~/.pi/agent/background-tasks` were
   deleted on 2026-10-20 after explicit approval. The implementation remains
   recoverable from Git history.
3. Install `pi-subagents` by adding its package entry to `settings.json`.
4. The spec lives at `packages/pi-subagents/SPEC.md` and ships with the package.
5. Activation requires a Pi restart. No reload-based partial state.
6. Rollback requires restoring `packages/pi-background-tasks` from Git history,
   reinstalling it and restarting. The source, settings entry and runtime data
   no longer exist, so rollback is not a one-line edit.
7. The extension ships with no definitions. The background worker and any other
   agents are authored separately after installation; nothing is created,
   copied, or migrated by the extension.
8. `pi-telegram` was simplified separately: one session, one destination chat,
   mirroring settled turns. Nothing here depends on that change, and the notice
   works with or without a transport attached.

## 18. Acceptance criteria

- Installing the extension creates no definitions and no prompt files.
- An absent or empty subagents root is valid; `list` returns nothing and
  dispatch says no agents are defined.
- Creating a directory with `prompt.md` makes it dispatchable with no reload.
- Deleting the directory removes it from `list` on the next call.
- Dispatch requires a saved session; an ephemeral session is refused with a
  clear error.
- A run id collision retries and never overwrites an existing run directory.
- A deleted run directory never produces a `run_dir_missing` status.
- A dispatch returns promptly, normally within two seconds, and the main
  session stays usable.
- No extension is loaded unless `agent.json` names it.
- The worker has no skills unless `agent.json` names them, and no prompt
  templates at all.
- The worker loads `AGENTS.md` and project context files.
- The worker does not inherit `APPEND_SYSTEM.md`, `MEMORY.md`, or Telegram.
- A brief containing quotes, `$()`, and newlines reaches the worker verbatim.
- `agent_settled` is the settlement signal; `agent_end` alone never settles.
- A steering message reaches a running worker, preserves prior work, and does
  not start a new run.
- A steer sent during finalization is caught by the final scan or rejected with
  "run is settling"; an ack timeout is reported as unconfirmed, never as
  delivered. A steer caught after settlement starts a new run through `prompt`.
- Steering a settled run is rejected and starts nothing.
- Headless dialogs are cancelled and logged; the run does not hang.
- Timeout is `failed` with reason `timeout`, not `cancelled`.
- Every terminal state for the current session injects one notice turn,
  including empty report, nonzero exit, external kill, timeout, and restart
  recovery, with no duplicate within a process. A synchronous spawn failure is
  the exception; its error goes to the caller instead, and a deleted run
  directory leaves no record to notify from.
- Notice injection works with no transport attached; the TUI shows the reply.
- The package contains no transport-specific type check or event listener.
- Reports are readable through `subagent_tasks result` with pagination.
- Timeout, turn limit, and cancel terminate the worker's process group without
  killing the supervisor before it records the result.
- Pruning never removes a running run, a pending notice, an incompatible run, or
  a definition.
- A dispatch returns a run id only after `supervisor.ready`; a supervisor that
  fails to start produces an error, not a silent run.
- A run is visible only in the session that dispatched it.
- A notice for a closed session stays pending and is delivered when that session
  is reopened; it is never injected into another session.
- A TUI exit or Pi SIGKILL kills the subagent. The supervisor writes 131 and
  exits; the run is `cancelled` with `parent_gone`, `cancelled` with `cancelled`
  if SIGTERM wins, or `orphaned` if the cgroup kill wins. A captured report is
  kept.
- A subagent never starts new work after the Pi process dies; it is killed
  within 500 ms. Only a captured report may still be written.
- An extension reload or session switch does not kill a run; the parent Pi
  process is still alive.
- A cgroup-killing service stop maps runs from `exit.code` when present and
  `orphaned` otherwise; `systemctl disable` alone changes nothing.
- Report text in a notice is framed as untrusted.
- `child.log` and `supervisor.log` stop growing at 1 MiB.
- Cancel during finalization is refused and the report is written intact.
- A canceled supervisor that leaves no exit file is recorded as `cancelled`.
- A dead supervisor does not leave a live worker group behind.
- A stale `settling` marker is killed and the run ends `failed` with
  `finalization_timeout`, not `running` forever.
- The supervisor traps SIGTERM and exits through the cancel path.
- A model or thinking override is resolved before dispatch; an unknown value is
  a validation error, not a failed run.
- A worker cannot dispatch another subagent even if the extension is loaded.
- The report is the final assistant message, untrimmed, and never stale text
  from an earlier turn.
- A write failure that can still record an exit is `io_error`, never `done`; a
  failure to record the exit ends `orphaned` with `unrecorded_exit`.
- A `task.json` with an unsupported `schemaVersion` is listed as incompatible
  and is not acted on.
- `maxTurns` is enforced on `turn_end`, not on wall time.

## 19. Test plan

- Offline supervisor tests against a fake RPC worker that emits deterministic
  `message_end`, `turn_end`, `agent_settled`, dialogs, and steers. No network,
  no model.
- Framing: LF-only splitting, U+2028 inside a JSON string, partial lines, a line
  over 8 MiB, and stdout backpressure. Stderr is drained continuously.
- Discovery: empty root, valid definition, missing prompt.md, bad name, dot-dir,
  runs/ ignored.
- Config: defaults, each key, unknown key, unknown tool, web tool in
  `excludeTools`, bad thinking, bounds, empty versus absent values.
- Arg construction: exact argv for default, exclusions, extensions, skills,
  model override, provider handling, and rejection of a `:thinking` suffix.
- Validation: unknown model, unknown thinking, recursion guard, and unsupported
  `schemaVersion`.
- Report capture: the final message from the final run, earlier text ignored,
  untrimmed, empty report, and a final steer starting a new run.
- Shell-safety: brief with quotes, newlines, `$()`, backticks, `;`, and paths
  with spaces; `report.md` equals the fake output byte for byte.
- Lifecycle: done, empty report, nonzero exit, missing exit file, timeout, turn
  limit, cancel, run-directory deletion, I/O failure, self-abort and
  worker-spawn failure reasons, a ready-handshake failure with an exit code, and
  orphan reconciliation after simulated restart.
- Process groups: worker is in its own group; timeout and cancel kill the worker
  group and leave the supervisor alive long enough to write `exit.code`; a dead
  supervisor leaves no live worker group.
- Steering: mid-run delivery, ack, multiple messages in order, atomic sequence
  allocation, settled-run rejection, ack timeout, final-scan rescue, settle-time
  steer delivered as `prompt`, settling marker, a cancelled run not revived by
  a late steer, and survival across reload.
- UI: each dialog method cancelled, fire-and-forget ignored, counts recorded.
- Notices: one injection per run, truncation, no duplicate within a process,
  and a tolerated repeat after a crash. Transport delivery is out of scope.
- Session ownership: dispatch in session A, open session B, confirm the run is
  absent, the notice stays pending, then reopen A and receive it once.
- Shutdown: a fake parent exits; the supervisor SIGKILLs the worker, writes 131,
  keeps a captured report, and does not revive a final steer; a cgroup kill with
  no exit file maps to `orphaned`; an extension reload with the parent alive
  does not kill the run; `disable` alone changes nothing.
- Parent liveness: a live parent, a zombie, a reused pid, a parent that dies
  during an RPC wait, and a parent that dies during finalization.
- Ready handshake: a fake supervisor that never writes `supervisor.ready`
  produces a dispatch error and a `spawn_error` run.
- Cancel race: a cancel while `settling` is present is refused; report is
  intact.
- Log caps: stderr and supervisor logs stop at 1 MiB and keep the tail.
- Notice framing: a report containing instruction-like text is rendered inside
  the untrusted block, not as agent instructions.
- Retention: age and count pruning, running run, pending notice, and
  incompatible run protected; a debris directory without `task.json` is pruned
  after 14 days.
- Identity: dispatch from an ephemeral session is refused; rapid dispatches get
  distinct run ids; a deleted run directory never yields `run_dir_missing`.
- Finalization hang: a `settling` marker older than 60 seconds is killed and
  recorded as `finalization_timeout`.
- One live dispatch against a real pi with a trivial prompt, not part of CI.

Target: 65 to 85 focused tests, typecheck clean, no network in the suite.
Expected implementation size: about 1,500 lines of source plus tests.

## 20. Decisions and changelog

Draft 14 to draft 15:

- Added the synchronous `idle-compaction.background-work.v1` provider so current
  `pi-idle-compaction` sees same-session running workers without a legacy RPC.
- Made notice transport failures retryable with bounded exponential backoff and
  a visible `noticeNextAttemptAt`; the final failure is `failed`, not silent.
- Kept the 400-code-point description cap inclusive of its trailing ellipsis.
- Added Linux-only `os` metadata, a Pi `>=1.2.0 <2` host-peer floor, and a
  bounded `typebox` peer range.

Draft 13 to draft 14:

- Renamed the definition prompt file from `PROMPT.md` to `prompt.md`.
- Added an optional `description.md` per definition. Before each agent run,
  described definitions are listed as `- <name>: <description>` in the
  `subagents` system prompt section (`<subagents>...</subagents>`). Whitespace
  is collapsed to one line and the text is capped at 400 code points including
  a trailing ellipsis.
- A definition without `description.md` remains dispatchable but is not listed
  in the prompt. No section is added when nothing is described.

Draft 12 to draft 13:

- Removed the dispatch `eta_seconds` and `estimate_reason` fields. The shown
  duration was informational only, enforced nothing, and was not surfaced in
  notices or the run list. `task.json` and the brief envelope no longer carry
  it; `timeoutSeconds` remains the only enforced time limit.

Draft 1 to draft 2:

- Added mandatory web access for every subagent.
- Replaced one-shot `pi -p` with a supervisor and RPC mode.
- Added steering and the `subagent_steer` tool.
- Removed `tools` and `timeout_seconds` from dispatch.
- Resolved the first five open questions.

Draft 2 to draft 3:

- Defined `task.json` as a versioned schema with a single writer.
- Closed the settlement/steering race with a final steer scan and a 2 second ack.
- Made cancel signal only the supervisor; the supervisor escalates.
- Separated timeout (`failed`) from cancellation (`cancelled`).
- Added the headless UI auto-cancel policy.
- Replaced exactly-once notice claims with at-least-once delivery.
- Made the supervisor abort when its run directory disappears.
- Added boot id to liveness checks.
- Specified strict JSONL framing and backpressure handling.
- Replaced the `tools` allowlist with `excludeTools`, so extension tools cannot
  be dropped by a pinned list.
- Added `maxTurns` as a runaway safeguard.
- Clarified the service-shutdown behavior at the time; superseded by the parent
  watchdog in draft 10.
- Corrected prompt wording for the brief's arrival path.

Draft 3 to draft 4:

- Removed mandatory web access. Network capability is now opt-in per definition
  through `agent.json` extensions.
- Removed every reference to a bundled background worker, including its prompt.
- The extension ships no agents and creates none on install.
- Web access testing left the offline suite; only a trivial live dispatch
  remains optional and manual.

Draft 4 to draft 5:

- Removed the transport claim and route contract, and the pi-telegram rename.
- A notice is now a plain hidden follow-up turn. Delivery belongs to whichever
  UI or transport is attached to the session.
- `pi-telegram` becomes standalone in its own change: one session, one
  destination chat, and it mirrors settled turns.
- Removed transport coupling from the acceptance criteria and tests.

Draft 5 to draft 6:

- Added session ownership: `sessionId` and `sessionFile` in `task.json`, and all
  reads, writes, notices, limits, and cleanup scoped to the dispatching session.
- A notice for a closed session stays pending and is delivered when that session
  is reopened, never to another session.
- Specified the watcher and reconciliation triggers, including the polling
  cadence and the no-timer state when nothing is running.
- Added the `supervisor.ready` handshake so a failed spawn is reported as an
  error instead of a silent run.
- Added `cancelRequestedAt` and the rule that a cancel without an exit file
  maps to `cancelled`, not `orphaned`.
- Defined `maxTurns` as counted on `turn_end`.
- Capped `child.log` and `supervisor.log` at 1 MiB with a 256 KiB tail.
- Framed report text as untrusted in every notice.
- Set run files to 0600 and run directories to 0700.
- Scoped retention to the current session and protected pending notices.
- Added a `settling` marker and a second scan so a late steer is either caught or
  rejected, and an ack timeout is reported as unconfirmed rather than deleting
  the message.
- Updated migration for the actual pi-background-tasks uninstall.

Draft 6 to draft 7:

- Removed `run.sh`. The extension spawns the supervisor directly with
  `detached: true`, which makes its pid equal to its pgid and avoids a launcher
  process whose pid would differ from the recorded one.
- Fixed steering at settlement: a late steer is forwarded as `prompt`, because a
  `steer` command only queues while the agent is idle and would never revive it.
  Added atomic sequence allocation and ordered delivery.
- Separated the supervisor and worker into two process groups. The supervisor
  traps SIGTERM, writes `exit.code`, then kills only the worker group. The
  extension kills a leftover worker group during reconciliation.
- Added `workerPid`, `workerPgid`, and `workerStartTicks`, serialized
  `task.json` updates, and a grace period for a supervisor that writes
  `exit.code` but does not exit.
- Suspended the timeout clock during finalization instead of letting it run, and
  made it monotonic.
- Captured the final assistant message without trimming or a stale fallback.
  Added exit 74 for I/O failure and explicit handling of a self-aborted
  settlement.
- Resolved model and thinking against the model registry before dispatch and
  rejected `:thinking` suffixes.
- Added the recursion guard, Linux-only scope, `subagent_tasks` pagination
  fields, unsupported `schemaVersion` handling, and clearer spawn-failure
  notice rules.
- Updated acceptance criteria and tests for the new process and steering
  behavior.

Draft 7 to draft 8:

- Fixed the spawn-failure and orphan paths so a worker group cannot outlive its
  supervisor, and every group kill verifies the group process session id and
  start ticks before signalling.
- Clarified that a late `supervisor.ready` is read once more before teardown, and
  that the supervisor kills its worker if it cannot publish its identity.
- Corrected the status table so a self-aborted settlement is `aborted`, not
  `protocol_error`.
- Made steer sequence allocation use a temp file plus rename, so the supervisor
  never reads a partial steer.
- Corrected the network claim: no extension is loaded by default, but `bash`
  still reaches the network. Read-only jobs exclude `bash`, `edit`, and `write`.
- Corrected failure rows for an externally killed worker and a refused cancel.
- Added `exit.reason` for the two exit-4 cases that the code alone cannot
  distinguish, `aborted` and `spawn_error`, and made the extension read it.
- Made a supervisor-requested abort skip the final steer scan, so a cancelled or
  timed-out run cannot be revived by a late steer.
- Let the ready handshake use an exit code when the supervisor wrote one, so an
  I/O or cwd failure is not mislabeled as `spawn_error`.
- Documented the unresponsive-supervisor case and narrowed the no-secrets claim
  to what the extension adds, since worker output is untrusted.
- Removed the `get_last_assistant_text` fallback, which could return an earlier
  turn's text. The report now comes only from the final run's `message_end`, or
  is empty.
- Kept `settling` in place through exit, so a cancel cannot truncate a report
  that is being written, and made the supervisor ignore SIGTERM while the marker
  is present.
- Made a final-steer prompt failure finalize with exit 4 instead of hanging the
  revived run.
- Gave `abort` a 2 second timeout so the cancel path stays inside the extension's
  15 second backstop.
- Protected incompatible runs from pruning, and clarified that a queued steer can
  be dropped if settlement wins the race.
- Corrected the rollback path to the absolute package directory.
- Added a 60-second stale-`settling` backstop so a hung finalization cannot
  leave a run `running` forever.
- Aligned the dispatch timing, notice bookkeeping, retention test, and
  write-failure wording.

Draft 8 to draft 9:

- Added an explicit shutdown and service-lifecycle table for `systemctl
  disable`, Ctrl+D or TUI quit, Pi SIGKILL, cgroup-killing stop or restart, host
  reboot, and a disabled unit that never restarts.
- Clarified that `systemctl disable` alone does not stop a running unit, that
  `task.json` can lag while Pi is down, and that `exit.code` and `report.md` are
  authoritative until reconciliation.

Draft 11 to draft 12:

- Implementation clarifications. `argv.json` includes the executable as element
  0; the supervisor spawns `argv[0]` with the remaining arguments.
- Added `dialogs.json`, the supervisor's channel for the denied-dialog count,
  since `task.json` remains extension-only.
- A `handled` initial prompt finalizes with exit 4: an input handler consumed
  the brief, so no settlement can arrive.
- Absolute `extensions` and `skills` paths must exist at dispatch, not merely be
  absolute.
- Recorded that the spec now ships inside the package.

Draft 10 to draft 11:

- Removed exit 6 from the published exit codes and the status mapping. It is
  supervisor-internal, since a vanished run directory cannot hold `exit.code`;
  such a run reconciles from live state.
- Made `eta_seconds` and `estimate_reason` durable: both are stored in
  `task.json` and the brief envelope, and are informational only.
- Defined session identity, and refused dispatch from an ephemeral
  `--no-session` session, whose runs could neither be revisited nor have their
  pending notices collected.
- Defined run id generation and collision handling, and made a debris run
  directory without a readable `task.json` prunable after 14 days.

Draft 9 to draft 10:

- Subagents now die with the main Pi process. The supervisor records its parent
  pid, boot id, and start ticks, checks them on a dedicated 500 ms timer, and on
  parent death sends SIGKILL to the worker group, keeps a captured report,
  writes `exit.reason` `parent_gone` and `exit.code` 131, and exits.
- Added 131 to the exit and status mapping as `cancelled`/`parent_gone`, removed
  cross-restart survival, and updated 8.2, failure modes, acceptance, and tests.
- An extension reload or session switch leaves the parent alive and does not kill
  a run.
