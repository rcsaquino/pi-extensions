<div align="center">

# @rcsaquino/pi-subagents

**Hand a self-contained job to a named headless Pi worker, keep chatting, correct its course, and get one report when it settles.**

</div>

The npm package is `@rcsaquino/pi-subagents`; the source directory and runtime paths remain `pi-subagents`. The extension is a launcher and a supervisor. It ships no agents, no transport integration, and no orchestration layer.

## Requirements

- **Linux with procfs.** Process identity, liveness, and process-group control use `/proc`, boot ids, and POSIX process groups. Other platforms are unsupported.
- **Node.js 22.19+** and **Pi 1.x**, as declared by this package.
- A **saved session**. Dispatch is refused when the session has no session file, such as with `--no-session`, because a run's notice could never be delivered later.
- `pi` on `PATH` for the worker process, and provider credentials inherited from the Pi service.

There are no runtime npm dependencies. Pi supplies the declared host peers.

## Installation

For development dependencies, from the monorepo root:

```sh
npm --prefix packages/pi-subagents install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
```

After a release is published, installation is `pi install npm:@rcsaquino/pi-subagents`. Until then, install the reviewed local package:

```sh
pi install /absolute/path/to/pi-extensions/packages/pi-subagents
```

Activation requires a Pi restart. The extension ships no definitions; the subagents root may be absent or empty.

## Defining a subagent

A subagent is a directory under `~/.pi/agent/subagents/<name>/` (or `$PI_CODING_AGENT_DIR/subagents/<name>/`):

```text
~/.pi/agent/subagents/
  reviewer/
    prompt.md   required, 1 byte to 16 KiB
    description.md       optional, one-line summary for the prompt
    agent.json           optional capability overrides
    runs/          reserved, written only by the extension
```

The name must match `^[a-z0-9][a-z0-9_-]{0,63}$`. A directory is a definition if and only if it contains a regular `prompt.md`. Discovery runs on every dispatch and before every agent run, so creating, editing, or deleting a definition takes effect immediately with no reload. The extension loads no definitions of its own.

`prompt.md` is passed as the appended system prompt. It replaces the discovered `APPEND_SYSTEM.md`; the main agent's addendum is not inherited. It should state identity, principal, reporting discipline, refusal rules, that Eve may steer mid-run, and that the final message is the report. It must not restate job content; that belongs in the brief.

`description.md` is optional. When present, it is flattened to one line and listed with the agent's name inside `<subagents>` in the system prompt, capped at 400 characters. A definition without it stays dispatchable but is not advertised to the model.

### agent.json

Optional. Absence means builtin tools only, no extensions, no skills, and the main session's provider, model, and thinking level.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `extensions` | string[] | `[]` | Entries passed as `-e`. Absolute paths or `builtin:<name>`. |
| `skills` | string[] | `[]` | Absolute skill directories passed as `--skill`. |
| `excludeTools` | string[] | `[]` | Builtin tools to remove: `read`, `bash`, `edit`, `write`. |
| `model` | string | main's | Exact id or `provider/id`; no patterns, no `:thinking` suffix. |
| `thinking` | enum | main's | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `timeoutSeconds` | integer | `14400` | Hard wall-clock cap, 60 to 604800. |
| `maxTurns` | integer | `300` | Assistant-turn cap, 1 to 1000. |

Unknown keys and unknown tool names are hard errors. Capability is decided only in `agent.json`; a dispatch cannot add, remove, or reschedule it. `excludeTools` is a denylist, so extension tools keep working when a definition narrows the builtins.

Example, for a read-only reviewer with MCP:

```json
{
  "extensions": ["builtin:mcp"],
  "excludeTools": ["bash", "edit", "write"],
  "timeoutSeconds": 7200,
  "maxTurns": 150
}
```

The worker loads `AGENTS.md` and project context files. It does not inherit `APPEND_SYSTEM.md`, `MEMORY.md`, or any transport extension.

## Tools

**`subagent_dispatch`** starts a run and returns after the supervisor reports ready, normally within two seconds. It requires `agent`, `title`, `brief`, and `cwd`. The brief is a file, not conversation history, and must be self-contained.

**`subagent_steer`** sends an adjustment into a live worker without restarting it. Messages are delivered between turns and preserve completed work. Delivery is best effort: a steer may be dropped if the run settles first, and an ack means "forwarded to Pi", not "read by the model". Steering a settled run is refused.

**`subagent_tasks`** supports `list`, `status`, `result`, and `cancel` for runs from the current session only. `result` pages the final report at 12,000 characters by default; `list` shows 20 runs per page, newest first. `cancel` aborts the worker; completed work is not rolled back.

A settled run injects one hidden follow-up notice into the dispatching session. The notice contains the report, framed as untrusted worker output, and a pointer to the full report. It is delivered by whichever UI or transport is attached; the extension has no transport integration.

The default limit is **4 concurrent runs per session**, configurable with `--subagents-max-running` (1 to 16). There is no queue.

## Lifecycle and safety

Each run is two detached processes. The extension spawns a small supervisor, which spawns the worker in its own process group and speaks Pi's RPC protocol. The supervisor enforces timeout and turn limits, forwards steering, answers headless dialogs with "cancelled", and records the outcome. A subagent cannot dispatch another subagent.

When the main Pi process dies, the supervisor detects it within 500 ms, kills the worker group, keeps any captured report, and records `parent_gone`. An extension reload or session switch leaves the parent alive and does not kill a run. `systemctl stop` or a reboot may kill the cgroup first; those runs reconcile as cancelled or orphaned on the next start.

Run directories are `0700` and run files are `0600`. Reports come from the worker's final assistant message, are never trimmed, and are capped at 2 MiB. Logs are diagnostics and are capped at 1 MiB with a tail kept. The extension adds no secrets to records, notices, or logs, but worker output is untrusted and may contain whatever the worker saw.

## Development

```sh
npm --prefix packages/pi-subagents run check
npm --prefix packages/pi-subagents test
npm --prefix packages/pi-subagents run verify
```

Tests are offline: a deterministic fake RPC worker covers settlement, steering, dialogs, timeouts, cancellation, parent death, protocol failures, and log caps. No network or model calls are used. See [SPEC.md](SPEC.md) for the full contract.

## Limitations

- No teams, rosters, scheduling, or agent-to-agent coordination.
- No recursive delegation.
- No conversation history inheritance; briefs are files.
- No cross-platform process control.
- No bundled agents or transport routing.
- One extension process owns a session's runs; concurrent Pi processes sharing one session are unsupported.
