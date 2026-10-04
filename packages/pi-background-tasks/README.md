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
- **Linux with procfs** for this unreleased descriptor-safe resource/staging/configuration implementation. Unsupported platforms fail closed. The maintained offline environment is Node 26.10.0 and Pi 1.0.0.

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
- **`background_fs_inspect`**: bounded structured `ls`/`find`/literal-substring `grep`, without a shell, helper downloads or output files. It skips symlinks, nonregular/oversized content and obeys the parent permission hooks.
- **`background_web_search` / `background_web_result`**: narrow source-bound HTTPS lookup and owned result retrieval, with a bounded memory-only cache. Available during unrelated direct/staged workers after reload; these are not the original web tools.
- **`background_publish`**: main-chat-only explicit publication of reviewed completed staged outputs using the exact manifest hash. Never automatically publishes.
- `background_start_check` and `background_stage_file` are internal callable brokers, not worker-management shortcuts. All calls go through the host validation, permission and redaction pipeline.

Manual requests always delegate. Automatic routing uses an honest upfront estimate and delegates when its upper bound is **strictly greater than 120 seconds**. Exactly 120 seconds stays inline. The model must make the estimate and follow the policy; this is not a stopwatch predicting unseen future work.

The tool's accepted response includes an internal task ID and estimated duration. Acknowledge the work naturally to the user with an honest duration, explicitly as an estimate; keep IDs internal unless genuinely necessary for clarity or troubleshooting, or explicitly requested. Avoid robotic job-ticket acknowledgments and fixed catchphrases; vary the wording naturally. IDs remain available for native controls, lookup, and correlation. Do not sleep, repeatedly poll, wait on a long tool promise, or duplicate the worker's work in the main chat. Completion/failure/overdue notifications become main-chat follow-ups when idle, never merged into active human work. With `pi-telegram` loaded, dispatch inside an authenticated Telegram request captures task-linked routing so later reports reach the originating private chat even after the acknowledgment settles. The main agent retrieves results and delivers attachments; workers never own transport. Local/TUI/RPC dispatch has no ambient Telegram target. Routing is ephemeral and revoked on navigation, session replacement or shutdown; uncertain or revoked delivery is not blindly replayed. Completion reserves its notification durably before routing, so a lost/revoked notice may require explicit status/result retrieval. Estimates can change with evidence; they are not guaranteed deadlines or invented progress percentages.

## Context and inheritance

A dispatch brief must contain the objective, completion criteria, paths, needed facts/decisions, authorization limits, deliverables, and verification. “Do the above” is not a complete handoff.

- **`brief`**, default: inherited instructions/tools plus the task; no earlier messages or tool results.
- **`selected`**: additionally supply nonblank `context_text`, up to 20,000 characters. Only that explicit reference is included; no automatic history extraction occurs.
- **`full`**: coherent currently projected conversation, only when the user explicitly asks to share history. It honors compaction/context edits and excludes unfinished dispatch/tool batches and raw abandoned archives.

`context_text` is accepted only in selected mode. The tool rejects conflicting fields rather than silently copying history. Brief/selected modes never call the history projector or add an extra summarizer request. Supply references through `context_text` only for selected mode; full mode requires an explicit request to share history.

Workers inherit effective system/project/memory instructions, skill descriptions and paths, callable tools, transport, thinking budgets, and provider request settings. Previously loaded skill bodies are not automatically copied in brief/selected modes; workers read relevant files themselves. Essential instructions and tool schemas still consume tokens. No percentage savings is promised.

Provider calls use the parent's model registry and request-time authentication. Direct compatibility tools use public `ctx.executeTool`, retaining validation, permission hooks, dynamic enablement, and redaction. Staged built-in file declarations route through the owner-checked `background_stage_file` broker, not tools bound to the parent's cwd. Permission policies must explicitly authorize that broker's operation and declared path contract; a policy matching only the built-in name `write` must not assume it also approves the broker. Extensions are not loaded again, so no duplicate pollers, learners, or services are created. A running worker keeps its dispatch profile when the main chat changes models.

Deliberate exclusions include foreground `model-only`/hidden tools, recursive worker-spawning controls, and Telegram delivery. The main chat reviews results and sends requested attachments. Provider/header/context lifecycle behavior and AgentSession recovery are not a bit-for-bit clone of another foreground session.

## Safety and lifecycle

Default capacity is two workers and 32 queued tasks. Direct compatibility mode retains one writer per canonical workspace, plus resource-aware leases. Staged writers own disjoint private file workspaces and may run together. Cooperating instances must share the same runtime storage root to coordinate canonical ancestor/descendant resources; this is not distributed or OS isolation.

Queued admission returns without executing worker work. Status exposes `queued`, `starting`, `running` and terminal states, with capacity/resource reasons. Queue wait is separate from the execution estimate, which starts at resource admission and includes snapshot preparation. Model/provider/thinking and opt-in context are captured before waiting. Start re-enters host permission hooks with the captured access/file contract and provider/model/thinking selection; mutation/denial rejects it. The current model definition and in-process provider implementation identity are revalidated before snapshot/model work. A changed foreground selection does not silently replace the captured profile; changed/withdrawn provider definitions reject admission. Credentials still resolve through the parent public API at request time, not through a copied credential snapshot. Queued cancellation starts no worker/model/file-output effects. Restart/reload marks saved waiting or running work interrupted without replaying its brief, tools or uncertain delivery.

Oldest eligible work runs first; disjoint supported jobs can pass a conflict. After 30 seconds an older conflicting request reserves admission priority over younger work, without preempting live workers. Worker model requests are bounded by worker capacity; new requests defer to observed active foreground runs/compaction with 30-second aging. Built-in worker shell calls, including nested calls through the host pipeline, have one subprocess-tool admission lane. The foreground is never gated by this worker admission service. Running streams/tools are not silently aborted; these are local admission limits, not reserved provider/server capacity or latency guarantees. Opaque custom tools' internal subprocesses are not counted or sandboxed.

### Staged file contract and publication

Use `execution: "staged"`, `access: "write"`, and an explicit `stage` object:

```json
{
  "inputs": ["src/input.ts"],
  "outputs": ["src/result.ts"],
  "immutable_refs": ["/approved/read-only/reference.md"]
}
```

Paths in `inputs`/`outputs` are literal relative UTF-8 text-file paths under the dispatch cwd. Binary/NUL/invalid-UTF-8 data is rejected, not silently decoded or overwritten. At most 128 total files/references, 4,096 characters per path, 16 MiB of snapshot bytes and 4 MiB per file are supported. Output parents must already exist. Snapshot input versions, existing output bases and explicitly named immutable references are copied into private `input`/`output`/`references` state. Profile selection is recorded privately; parent authentication/model services remain shared, not cloned. Cache/temp directories are reserved private state; the supported web implementation uses separately owned worker memory namespaces instead of disk. No extensions or transports are initialized again.

Snapshot resources and the private workspace are acquired atomically, then input leases are narrowed away after copying. Staged `read`/`write`/`edit` declarations use the permission-checked broker with descriptor-anchored no-follow operations. Input-only files/references cannot be written. A path explicitly listed in both inputs and outputs has an immutable base copy and a writable staged output copy. Shells, arbitrary live-parent reads, undeclared paths, deletions, directories, binary workflows, recursive management and unreviewed extension effects are blocked. Changing a record cwd is not the isolation mechanism.

A completed worker seals a manifest of changed declared outputs. Review its authorization, paths and content, then call `background_publish` with `id` and `expected_manifest_hash`. The manifest is a constraint, **not new user permission**. Publication validates all immutable source/base hashes, ownership, parent identities and output hashes, and rejects stale versions rather than merging. Owned non-hardlinked UTF-8 text files with standard 0600/0644 modes are supported; executable/special-mode targets are rejected. A host umask that prevents preserving the requested mode fails closed rather than chmodding an alias or silently changing permissions. Publication replaces file inodes and is not an ACL/xattr/hardlink-preserving metadata merge; review such files outside this contract.

All target, temporary and recovery resources are locked together. Every backup/replacement is prepared before changing targets; each file is atomically renamed. Cooperating live readers hold shared leases through host tool completion, so they cannot observe a partial publication. **There is no physical multi-file filesystem transaction:** uncoordinated readers/processes can observe intermediate states. Ordinary failures roll back only unchanged owned replacement inodes, never an unrelated later edit, even when a replacement has identical bytes. Forward and rollback temporary paths are reserved in the same resource acquisition. Journals, backups and manifests remain for review. Failed rollback or a publication crash retains locks and requires explicit recovery review; journals are evidence, not authority for an automatic replay. Restored staged results remain readable, but are not automatically rehydrated/published.

Legacy direct writers/readers can still observe partial live-parent state. Their uncertain leases remain after a crash because a dead parent PID alone does not prove subprocess writers stopped. A safe idle reload is required; stuck tools retain ownership until they settle. An inspected dead resource mutex is never automatically unlinked: PID checks plus unlink cannot atomically prove ownership. A leftover `resources.mutex`, uncertain legacy/direct lease or publication journal requires explicit idle recovery review, not a retry loop or blanket lock-directory deletion. The resource table caps at 256 leases/1 MiB and rejects overflow before writing malformed state.

`access: "read"` permits only argument-validated **trusted effects**, not unverified `readOnlyHint` annotations. The shipped contracts cover host built-in `read`/`ls` and this package's structured inspection tool. Built-in `grep`/`find` remain conservative because Pi may acquire external helpers; use `background_fs_inspect` when those tools cannot be proven inert. Shells, mutating and unclassified tools require write access.

### Effect contracts (unreleased source stage)

`src/effects.ts` distinguishes filesystem reads, network reads with optional confined private cache writes, declared-path writes, external mutations and unknown effects. Contracts are reviewed code supplied to the manager, bound to an exact host-provided source identity and evaluated with actual arguments. They are **not** model parameters, tool annotations, an event-bus registration or an arbitrary tool-name allowlist. No public model-facing tool installs contracts.

Reads may continue during a writer. Declared writes are allowed through the lease gate only when their canonical resources are disjoint; this is **not** authorization to write outside the workspace and never skips the main permission hooks. Unresolved paths, dangling links, hardlinked write resources and ambiguous Pi path expansion remain unknown. Unknown/external effects remain blocked while a writer holds the lease, including an uncertain lease after bounded shutdown. Only the three exact manager controls remain available for inspection/cancellation/admission; arbitrary `background_*`, `memoria_*` or `telegram_*` prefixes do not exempt effects.

A trusted disk-caching network contract must prove every cache effect, including chmod, eviction and detached work, stays in a private owned directory disjoint from the writer's entire workspace, rejecting symlink/hardlink aliases throughout execution. The shipped web alternative has no disk cache. The registry cannot enforce an arbitrary implementation or remove filesystem races by declaration.

**The original pi-web-access tools remain conservative, not name-exempted.** Their command credentials, proxy subprocess/temp files, extraction/workflows, shared cache aliases and detached fetching are not repaired by this package.

The shipped narrow working alternative is `background_web_search` plus `background_web_result`. Independently implemented fixed-endpoint direct Node HTTPS supports Brave, Parallel, Tavily, Exa and Serper searches, reading the existing conventional `web-search.json` and literal/environment credentials without executing commands. An explicit configured unsupported provider fails clearly, without silently switching it; adapter `auto` selects only its supported available providers. Unsupported provider arrays, filters, proxy/custom endpoints, auth/cookies, downloads, media, extraction, include-content and model/curator workflows fail closed. The original package and global configuration are unchanged.

This is **search plus retrieval of the returned source snippets/excerpts**, not arbitrary URL/page fetching or a substitute for `fetch_content`/`source_check`. Transport permits only the five exact HTTPS search endpoints, verified TLS and public IPv4 DNS results; it rejects private/reserved/mixed DNS answers and every redirect. IPv6-only providers/networks are unsupported. It creates no shared agent/proxy/auth-cookie transport. Returned links are data, not automatically fetched, and credential-bearing links are excluded.

Results are projected/redacted and bounded in private session/worker **memory**, with owner-checked IDs, miss coalescing, collision-safe publication and bounded eviction. Shutdown clears/aborts ownership and prevents late pending results from repopulating the cache. Ownership follows validated nested host ancestry; a provider-issued foreground tool ID prefix cannot impersonate a worker. There is no disk response cache, chmod, pruning, temp file, alias traversal or detached content fetch to exempt. Configuration reads are descriptor-anchored, reject ancestor/final symlinks and regular hardlinks, and never chmod them. Original response IDs cannot be retrieved here; reload loses adapter results. This deliberate narrower design avoids copying the unsafe installed storage. It neither attests live credentials nor proves provider acceptance; verification uses synthetic configuration and localhost HTTPS only.

> [!WARNING]
> Workers share Pi's filesystem permissions and provider rate limits. This is not a sandbox. Other processes, uncoordinated hosts, overlapping directory hierarchies, custom host operations or dishonest trusted contract code remain outside the cooperative boundary. Tool hints alone cannot grant an exemption.

- Foreground cancellation leaves already accepted jobs running.
- Explicit worker cancellation aborts cooperating model/tool work; earlier effects are not rolled back.
- Quit, reload, session replacement, and process termination stop workers. Stuck tools receive bounded cleanup; writer leases are not prematurely released.
- Crash recovery marks uncertain work interrupted; it does not automatically replay effects or delivery.
- Tasks do **not** survive host termination. Review partial effects before retrying.
- Completion requires a supported `stop` response with nonblank visible assistant text and no unfinished tool calls. Empty, thinking-only, malformed, deferred, length and unfinished-tool terminal responses are not successful reports. Final worker claims still require main-chat verification.
- Normally settled failures, cancellations and interruptions save a standalone deterministic fallback. Failed partial prose is labeled unverified. The fallback records safe reasons/counters and any known last-tool outcome, but does **not** verify work, artifacts, tests or effects. A tool returning successfully does not prove completion.
- Report recovery makes no extra model calls and never replays original tasks or tool effects. Restored interrupted v1 records receive an honest fallback when needed, without inventing their lost terminal reason.
- Worker model usage is accounted when a final result is retrieved, once only. Model/tool concurrency incurs ordinary cost and can contend with the foreground.
- With the updated `pi-latency-analytics` source, metadata-only `background-tasks:telemetry:v1` events create independent linked worker traces. Host nested tools are routed by dispatch-root ancestry; worker model/compaction requests carry explicit generated IDs. Stream metadata never includes content, arguments, results, headers, errors or the task brief. Nested tool usage is emitted once as aggregate metadata, not invented individual model spans. This does not reduce or explain provider response latency.

## Storage and options

Defaults:

```text
<cwd>/temp_files/pi-background-tasks/
├── sessions/<parent-session-hash>/
│   ├── bg-012345abcdef.json
│   ├── bg-012345abcdef.md
│   └── bg-012345abcdef.stage/{input,output,references,profile,cache,temp,recovery}/
└── locks/{<canonical-cwd-hash>.json,resources.json,resources.mutex}
```

Directories use `0700`; metadata/results use `0600`. Stored output is a valid final visible worker report or a deterministic fallback, optionally with explicitly unverified partial visible prose. It may still contain sensitive task material; review it before sharing. Private storage uses descriptor-anchored ancestor checks; result/metadata reads reject symlinks, regular hardlinks and oversized files (4 MiB results, 1 MiB metadata).

Optional v1 metadata records `reportSource` (`worker` or `fallback`) and allowlisted `terminalDiagnostics`: fixed stop/category/phase enums, validated visible-text counts, tool-call presence, an observed last-tool outcome and lease-cleanup uncertainty. Unknown provenance stays unknown; finalizing does not replace the originating failure phase. Tool identities use a closed known-name vocabulary; other extension/MCP identities are recorded as `other`. No raw errors, provider diagnostic arrays/payloads/headers, credentials, arguments/results, private reasoning, signatures or worker transcripts are copied into diagnostic metadata. Valid model usage counters are preserved without counting reasoning twice.

Output is saved before completion notification reservation. If output/metadata storage fails, automatic completion notification is withheld and explicit result retrieval can return a bounded in-memory fallback with `reportDurable: false` and no saved output path. Usage is then reported once only within the current process, not durably across a restart. Read/recovery faults are explicit; this is not a guarantee of survival when both storage and the process fail, nor of zero delivery latency. An old completed record with a missing/blank result cannot substantiate completion and restores as failed with a fallback.

- `--background-dir <path>`: choose private state/result storage.
- `--background-max-workers <N>`: default 2; allowed range 1–8.
- `--background-timeout-minutes <N>`: default 240; ETA changes do not extend this safety timeout.

Workers also have a 200-model-turn ceiling. Capacity/resource conflicts enter the bounded observable queue; overflow rejects clearly without acceptance. `--background-max-queued <N>` selects 1–128 waiting tasks, default 32. Use durable approved artifact paths for requested deliverables, not disposable task scratch. Where `temp_files` is cleaned periodically, saved results are not permanent archives.

## Safe activation, smoke and rollback

Source verification is not activation. For existing local registrations, use the following only after authorization:

1. Retrieve the finished report and retain its source hashes/patches. Use `/bg list` and the host UI to ensure **all** jobs and nested tools have settled, including queued/cancelling/stuck work. Do not reload an active worker or clear its lease to force an idle state.
2. Issue `/reload` in the idle Pi session. The ordinary tool API has no documented command-context reload channel; the user may need to do this in TUI/RPC. Load the reviewed background and latency sources together. No new registration, credential/config edit, installation or service restart is required.
3. Check `/bg help` and `/latency status`, then use `background_fs_inspect` on approved scratch. A separately approved synthetic staged edit should leave the parent unchanged until its completed manifest is reviewed and `background_publish` receives the exact hash. Verify queued cancellation starts no model/file effects and main-chat questions remain usable.
4. Inspect `/latency recent`/`trace` for distinct foreground/worker links and retrieve the saved result once. A later **explicitly authorized** live lookup may use `background_web_search` and `background_web_result` only if the existing configured provider/credential is supported. Unsupported providers/options should fail clearly, not silently switch tools/providers. Offline source tests do not attest live authentication or provider acceptance.
5. For rollback, settle all work first, preserve runtime state and later source changes, and check the report's scoped reverse patch against the exact verified tree. Do not reset to Git HEAD or overwrite pre-existing work. Restore only reviewed task changes, then perform another authorized idle `/reload`. Never delete saved stage/recovery/result data as a code rollback.

Publication recovery is separate from code rollback. Preserve journals, owned backup/replacement files and retained lock tokens; establish that every cooperating host, nested tool and child writer has stopped before any explicitly authorized lock repair. A dead parent PID, restored `completed` record or matching manifest hash alone is not recovery authority. Never automatically replay an uncertain merge. There is no model-facing force-unlock/replay tool.

### Practical staged dispatch

A complete manual handoff still supplies the brief and ETA, for example:

```json
{
  "title": "Edit two approved text files",
  "task": "Edit only the declared text outputs, verify the staged changes, and return the manifest for main-chat review. Do not publish or touch other files.",
  "mode": "manual",
  "eta_seconds": 300,
  "estimate_reason": "Two bounded edits and offline verification; no installation or live network work.",
  "access": "write",
  "execution": "staged",
  "context_mode": "brief",
  "stage": { "inputs": ["src/reference.txt"], "outputs": ["src/one.txt", "src/two.txt"] }
}
```

Use direct mode instead only when the approved work requires shell/custom tools and its live-workspace risks are acceptable. Direct tools with escaping/opaque effects acquire conservative live resources beyond cwd, with owning ancestor capabilities, not a whole-job permission bypass. Compatibility foreground readers may still see partial direct state; safe memory-only web lookup stays independent of file leases. Staging is cooperative file-tool binding, not a subprocess/OS sandbox.

For supported lookup use `background_web_search` with one `query` or 1–4 `queries`, optional one supported provider and `numResults` 1–20. Omit provider to preserve configuration; explicit provider arrays/`auto`, filters, proxy/auth/fetch/workflow options are not in this tool schema. Retrieve its returned `safe-web-*` ID with `background_web_result` using `offset`/`limit` or a literal `findText`; original web IDs and page content are unavailable. At most eight lookup misses are in flight, two requests per query batch, 16 cached query groups and 32 result envelopes; responses/envelopes cap at 1 MiB, inline search at 24 KB, retrieval at 24,000 characters. Results expire on bounded eviction or reload.

## Development

With dependencies available, from the monorepo root:

```sh
npm run link-host
npm --prefix packages/pi-background-tasks run verify
```

`PI_BACKGROUND_TEST_ROOT` selects isolated scratch for direct tests. Root verification configures it automatically. Tests exercise actual Pi SDK/loader behavior with an inert synthetic provider, context modes, tool guards, writer leases, cancellation, notifications, compaction, result accounting, and crash recovery. Cross-package fixtures interleave workers with the foreground and verify tool/model/usage isolation. The new staged/queue fixtures exercise actual source registrations and the real direct HTTPS transport against synthetic localhost TLS endpoints only. Live network/provider calls are forbidden. Effect fixtures cover private-cache misses/collisions, malicious arguments, source spoofing, unsafe aliases and parent permission denial.

This is an unreleased, supported-contract source completion, **not runtime activation**. It implements the narrow safe web alternative, isolated regular-file staging/publication, bounded queues and local foreground-priority admission, retaining the first-stage effect/trace/privacy guards. Arbitrary staged shells, OS-enforced subprocess isolation, opaque extension internals, full provider parity, metadata-preserving merges and automatic crash recovery are not claimed. Package versions remain unchanged. Existing local registrations need only an idle Pi `/reload` after every worker/tool settles; no new registration, installation, global credential/cache/config edit or service restart is required for these tools. If the API interface has no documented reload command channel, run `/reload` in the idle Pi session yourself; source tests do not establish activation.

See [AGENTS.md](AGENTS.md) for the module map and regression scope. Offline success is not a live-provider or production-delivery claim.

## Support and contact

If pi-background-tasks is useful to you, you can support its development on
[Ko-fi](https://ko-fi.com/rcsaquino).

<a href='https://ko-fi.com/rcsaquino' target='_blank'><img height='72' style='border:0px;height:72px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
