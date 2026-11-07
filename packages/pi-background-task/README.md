# @rcsaquino/pi-background-task

Delegate long work by forking the current conversation into a detached Pi session. The worker is not a reduced subagent: it is this same agent, with the same model, tools, skills, extensions, memory, and working directory, running headless in the background.

## Why

A fork keeps full context and capability, and the session file lives in the normal project session directory, so a memory package's `memoria_sessions` tool can find it later when that package is installed. There is no agent registry, no separate prompt, and no skill configuration to drift.

This package works with no other package from this repository installed.

## Requirements

- **Linux.** The manifest declares `os: linux`; other platforms are refused at install time.
- **Node.js 22.19+** and a Node-based **Pi** host at **`>=1.5.0 <2`**.
- A **`pi` executable on `PATH`** to run workers, or **`PI_BACKGROUND_PI`** set to the executable's path (for a wrapper, a version manager, or a nonstandard host).

## Installation

```sh
pi install npm:@rcsaquino/pi-background-task
```

Until the package is published, install it from a clone:

```sh
pi install ./pi-extensions/packages/pi-background-task
```

Run `/reload` in an idle session to activate it. If the worker binary is not `pi` on `PATH`, set `PI_BACKGROUND_PI` in the environment that starts Pi. A missing binary now fails the dispatch with the command and the override in the error message.

## Tools

| Tool | Purpose |
|---|---|
| `background_task` | Fork `PI_SESSION_FILE` into a detached `pi -p` run and return a run id |
| `background_eta` | Rebase a running task's ETA from now and restart its reminder window |
| `background_list` | Status, elapsed time, pid, and report path for this session's runs |
| `background_result` | Paged report text, with stderr tail fallback when nothing was produced |
| `background_kill` | SIGTERM the process group, SIGKILL after 4s |

## Behavior

- Command: `$PI_BACKGROUND_PI` (default `pi`) `--fork <session file> --session-id <run id> --name <title> -p <prompt>` with `detached: true`, so the worker survives this process. `<prompt>` is the caller's task prefixed by a fixed operational note: the worker is detached, cannot ask questions, must end with a report, and must not nest dispatch unless the task requires it.
- The note travels in the user message, so the system prompt and forked history stay byte-identical to the parent for prompt caching.
- Every dispatch carries `eta_minutes` (default 10). A run still going past its ETA sends a follow-up turn asking for a revised estimate to relay, then keeps checking once per current estimate. `background_eta` rebases that window from now, so the next check follows the new promise. If no estimate is recorded by the next interval, the run raises an ETA error instead of another reminder, and repeats it until one lands or the run is killed. A run that beats its ETA sends only the settle notice. The reminder carries facts and the obligation to tell the user; wording is left to the agent.
- One notice per run, injected with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, carrying a 1,200 character excerpt and the run id. A run explicitly cancelled with `background_kill` settles silently: no follow-up notice, but its report and `background_result` stay available.
- At most four concurrent runs per session, and at most two nesting levels.
- No timeout. A stuck run is stopped with `background_kill`.
- Runs are recovered on `session_start`: a dead pid finalizes the run, an unnotified result is re-sent.
- Artifacts are pruned on `session_start` and after recovery: a settled run is deleted when it is older than 30 days or beyond the newest 25 runs for that session, whichever comes first. Running runs and runs whose notice was never delivered are never deleted. The forked sessions are not touched.

## Layout

Artifacts live outside the session store:

```
<agent dir>/background/<parent session id>/<run id>/
  meta.json    status, pid, timestamps, exit code, notified flag
  task.md      the dispatched prompt (note plus task)
  report.md    worker stdout (the final answer)
  stderr.log   worker stderr
```

The forked session itself is written by Pi to the normal project session directory, next to every other session.

## Notes

- Print mode does not stream, so the report appears only when the run ends.
- If the Telegram package is installed, `telegram_send` exists in the worker but refuses because it needs an inbound Telegram request context.
- The worker sees the conversation as of the fork. Anything said afterward is invisible to it.

## Development

```sh
npm --prefix packages/pi-background-task install --ignore-scripts --legacy-peer-deps --workspaces=false
npm --prefix packages/pi-background-task run check
npm --prefix packages/pi-background-task test
```

## Support and contact

If these extensions are useful to you, you can support their development on
[Ko-fi](https://ko-fi.com/rcsaquino).

<a href='https://ko-fi.com/rcsaquino' target='_blank'><img height='72' style='border:0px;height:72px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
