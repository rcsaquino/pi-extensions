# @rcsaquino/pi-background-task

Delegate long work by forking the current conversation into a detached Pi session. The worker is not a reduced subagent: it is this same agent, with the same model, tools, skills, extensions, memory, and working directory, running headless in the background.

## Why

A fork keeps full context and capability, and the session file lives in the normal project session directory, so `memoria_sessions` can find it later. There is no agent registry, no separate prompt, and no skill configuration to drift.

## Tools

| Tool | Purpose |
|---|---|
| `background_task` | Fork `PI_SESSION_FILE` into a detached `pi -p` run and return a run id |
| `background_list` | Status, elapsed time, pid, and report path for this session's runs |
| `background_result` | Paged report text, with stderr tail fallback when nothing was produced |
| `background_kill` | SIGTERM the process group, SIGKILL after 4s |

## Behavior

- Command: `pi --fork <session file> --session-id <run id> --name <title> -p <prompt>` with `detached: true`, so the worker survives this process. `<prompt>` is the caller's task prefixed by a fixed operational note: the worker is detached, cannot ask questions, must end with a report, and must not nest dispatch unless the task requires it.
- The note travels in the user message, so the system prompt and forked history stay byte-identical to the parent for prompt caching.
- One notice per run, injected with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, carrying a 1,200 character excerpt and the run id.
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
- `telegram_send` exists in the worker but refuses, because it needs an inbound Telegram request context.
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
