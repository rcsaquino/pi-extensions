<div align="center">

# @rcsaquino/pi-background-tasks

**Delegate work without blocking your [Pi](https://github.com/earendil-works/pi) conversation, using the same model and a compact task brief.**

[Installation](#installation) · [Usage](#usage) · [Context](#context-and-inheritance) · [Safety](#safety-and-lifecycle) · [Support](#support-and-contact)

</div>

The npm package is `@rcsaquino/pi-background-tasks`; the source directory and runtime paths remain `pi-background-tasks`. It is distinct from the unrelated unscoped npm package.

Runs independent in-process workers while the main chat remains available. Each worker captures the active provider, physical model, and thinking level at dispatch. Conversation history is **not copied by default**. A realistic duration estimate is mandatory, and accepted work returns an internal task ID immediately.

## Requirements

- **Node.js 22.19+** and **Pi 1.x**, as declared by this package.
- A long-lived **TUI or RPC** session. Print/JSON mode refuses background starts that would die at exit.
- A writable private runtime directory and the current public Pi nested-tool/model APIs.

There are no runtime npm dependencies. Pi supplies the declared host peers. Virtual model routers are rejected in this version; select a physical model rather than relying on an undocumented substitution.

## Installation

For development dependencies, from the monorepo root:

```sh
npm --prefix packages/pi-background-tasks install --ignore-scripts --legacy-peer-deps --workspaces=false
```

After a release is published, npm installation is `pi install npm:@rcsaquino/pi-background-tasks`. Until then, install the reviewed local package separately:

```sh
pi install /absolute/path/to/pi-extensions/packages/pi-background-tasks
```

Use `/reload` in an idle Pi session when you intend to activate it. Keep the local checkout in place. This does not require pi-subagents, patch Pi core, or initialize another Telegram transport. Removal uses `pi remove <installed-source>` and leaves saved runtime records intact.

## Usage

Ask normally: “Run this in the background and tell me when it is ready.” Native Pi controls are also available:

```text
/bg Implement and test the requested change in the approved project.
/bg list
/bg status bg-012345abcdef
/bg result bg-012345abcdef
/bg cancel bg-012345abcdef
/bg auto off
/bg auto on
```

`/bg <task>` queues a short main-agent request to estimate and dispatch, rather than guessing a duration in command code. List/status/cancel/auto controls themselves do not require a model call. Result requests ask the main agent to retrieve and report the saved output, not rerun the task. These are Pi commands, not Telegram bot-menu entries.

Model-facing tools:

- **`background_dispatch`**: submit a self-contained task, title, estimate/reason, access, and optional context.
- **`background_tasks`**: list, inspect, paginate a saved result, or cancel within the current parent session.
- **`background_update_eta`**: revise remaining time with a reason; a worker may revise only its own task.

Manual requests always delegate. Automatic routing uses an honest upfront estimate and delegates when its upper bound is **strictly greater than 120 seconds**. Exactly 120 seconds stays inline. The model must make the estimate and follow the policy; this is not a stopwatch predicting unseen future work.

The tool's accepted response includes an internal task ID and estimated duration. Acknowledge the work naturally to the user with an honest duration, explicitly as an estimate; keep IDs internal unless genuinely necessary for clarity or troubleshooting, or explicitly requested. Avoid robotic job-ticket acknowledgments and fixed catchphrases; vary the wording naturally. IDs remain available for native controls, lookup, and correlation. Do not sleep, repeatedly poll, wait on a long tool promise, or duplicate the worker's work in the main chat. Completion/failure/overdue notifications become main-chat follow-ups when idle, never merged into active human work. With `pi-telegram` loaded, dispatch inside an authenticated Telegram request captures task-linked routing so later reports reach the originating private chat even after the acknowledgment settles. The main agent retrieves results and delivers attachments; workers never own transport. Local/TUI/RPC dispatch has no ambient Telegram target. Routing is ephemeral and revoked on navigation, session replacement or shutdown; uncertain or revoked delivery is not blindly replayed. Completion reserves its notification durably before routing, so a lost/revoked notice may require explicit status/result retrieval. Estimates can change with evidence; they are not guaranteed deadlines or invented progress percentages.

## Context and inheritance

A dispatch brief must contain the objective, completion criteria, paths, needed facts/decisions, authorization limits, deliverables, and verification. “Do the above” is not a complete handoff.

- **`brief`**, default: inherited instructions/tools plus the task; no earlier messages or tool results.
- **`selected`**: additionally supply nonblank `context_text`, up to 20,000 characters. Only that explicit reference is included; no automatic history extraction occurs.
- **`full`**: coherent currently projected conversation, only when the user explicitly asks to share history. It honors compaction/context edits and excludes unfinished dispatch/tool batches and raw abandoned archives.

`context_text` is accepted only in selected mode. The tool rejects conflicting fields rather than silently copying history. Brief/selected modes never call the history projector or add an extra summarizer request. Supply references through `context_text` only for selected mode; full mode requires an explicit request to share history.

Workers inherit effective system/project/memory instructions, skill descriptions and paths, callable tools, transport, thinking budgets, and provider request settings. Previously loaded skill bodies are not automatically copied in brief/selected modes; workers read relevant files themselves. Essential instructions and tool schemas still consume tokens. No percentage savings is promised.

Provider calls use the parent's model registry and request-time authentication. Tools use public `ctx.executeTool`, retaining validation, permission hooks, dynamic enablement, and redaction. Extensions are not loaded again, so no duplicate pollers, learners, or services are created. A running worker keeps its dispatch profile when the main chat changes models.

Deliberate exclusions include foreground `model-only`/hidden tools, recursive worker-spawning controls, and Telegram delivery. The main chat reviews results and sends requested attachments. Provider/header/context lifecycle behavior and AgentSession recovery are not a bit-for-bit clone of another foreground session.

## Safety and lifecycle

Default capacity is two workers, with one writer per canonical workspace. Cooperating instances sharing the same storage root and exact working directory use writer leases; foreground conflicting writes are conservatively blocked while its worker owns that lease.

`access: "read"` permits only known or annotated read-only tools. Shells and unknown side effects require write access. Tool annotations and workspace instructions are not OS-level isolation.

> [!WARNING]
> Workers share Pi's filesystem permissions and provider rate limits. This is not a sandbox. Other processes, uncoordinated hosts, overlapping directory hierarchies, or misleading tool annotations can bypass the cooperative writer boundary.

- Foreground cancellation leaves already accepted jobs running.
- Explicit worker cancellation aborts cooperating model/tool work; earlier effects are not rolled back.
- Quit, reload, session replacement, and process termination stop workers. Stuck tools receive bounded cleanup; writer leases are not prematurely released.
- Crash recovery marks uncertain work interrupted; it does not automatically replay effects or delivery.
- Tasks do **not** survive host termination. Review partial effects before retrying.
- Result failures and length stops are failures, not fabricated completion. Final worker claims still require main-chat verification.
- Worker model usage is accounted when a final result is retrieved, once only. Model/tool concurrency incurs ordinary cost and can contend with the foreground.

## Storage and options

Defaults:

```text
<cwd>/temp_files/pi-background-tasks/
├── sessions/<parent-session-hash>/
│   ├── bg-012345abcdef.json
│   └── bg-012345abcdef.md
└── locks/<canonical-cwd-hash>.json
```

Directories use `0700`; metadata/results use `0600`. Stored output is final visible text, not private reasoning or full worker transcripts. It may still contain sensitive task material; review it before sharing. Result reads and storage traversal reject symlinks.

- `--background-dir <path>`: choose private state/result storage.
- `--background-max-workers <N>`: default 2; allowed range 1–8.
- `--background-timeout-minutes <N>`: default 240; ETA changes do not extend this safety timeout.

Workers also have a 200-model-turn ceiling. Capacity and writer conflicts fail immediately instead of creating an invisible queue. Use durable approved artifact paths for requested deliverables, not disposable task scratch. Where `temp_files` is cleaned periodically, saved results are not permanent archives.

## Development

With dependencies available, from the monorepo root:

```sh
npm run link-host
npm --prefix packages/pi-background-tasks run verify
```

`PI_BACKGROUND_TEST_ROOT` selects isolated scratch for direct tests. Root verification configures it automatically. Tests exercise actual Pi SDK/loader behavior with an inert synthetic provider, context modes, tool guards, writer leases, cancellation, notifications, compaction, result accounting, and crash recovery.

See [AGENTS.md](AGENTS.md) for the module map and regression scope. Offline success is not a live-provider or production-delivery claim.

## Support and contact

If pi-background-tasks is useful to you, you can support its development on
[Ko-fi](https://ko-fi.com/rcsaquino).

<a href='https://ko-fi.com/rcsaquino' target='_blank'><img height='72' style='border:0px;height:72px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
