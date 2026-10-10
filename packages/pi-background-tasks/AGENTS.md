# Working on @rcsaquino/pi-background-tasks

Read [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). The npm scope does not rename the source directory, task storage, commands, or tools. This package manages independent in-process Pi agents, not subprocess-hosted Telegram sessions or durable distributed jobs.

## Setup and verification

From the monorepo root:

```sh
npm --prefix packages/pi-background-tasks install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-background-tasks run check
npm --prefix packages/pi-background-tasks test
npm --prefix packages/pi-background-tasks run verify
```

Install dependencies only when needed. The package declares Node 22.19+ and Pi 1.x. Host packages stay peers; do not bundle another Pi runtime. Set `PI_BACKGROUND_TEST_ROOT` for isolated direct test scratch, or use the root runner.

## Architecture

- `index.ts`: distributable forwarding entry.
- `src/index.ts`: model-facing schemas, tools, `/bg`, flags, and lifecycle registration.
- `src/policy.ts`: ETA/context validation, routing, coherent history, read/staged-worker permission guards, and worker instructions.
- `src/effects.ts`: reviewed source-bound argument-aware effects and conservative path/cache normalization for read-worker permissions.
- `src/inspect.ts`: bounded Node-only filesystem inspection, with no shell/helper acquisition/output writes.
- `src/telemetry.ts`: closed metadata-only worker/request/usage events for cooperative trace isolation.
- `src/manager.ts`: bounded queue, captured-profile revalidation, capacity-only scheduling, staging/publication, admission, cancellation, notifications, ETA and once-only result bookkeeping.
- `src/files.ts`: Linux descriptor-anchored no-follow regular-file operations and ordinary atomic persistence. The former `src/resources.ts` workflow lease mechanism is removed, not replaced.
- `src/staging.ts`: explicit bounded regular-file snapshots, immutable references, owner file broker, manifest sealing, version-checked publication and rollback journals.
- `src/admission.ts`: foreground-priority local worker model and builtin subprocess admission, bounded waiting and aging; never provider-capacity guarantees.
- `src/web.ts`: independently implemented fixed-endpoint HTTPS lookup and owner-private bounded memory result cache; no original pi-web-access cache/workflows or credential commands.
- `src/worker.ts`: independent agent, inherited model/tool behavior, bounded execution, and compaction.
- `src/store.ts`: private atomic task metadata/results, report-only interruption recovery; no shared writer leases.
- `src/report.ts`: pure terminal validation, closed diagnostic sanitization and deterministic settlement reports.
- `src/types.ts`: dispatch, profile, runtime, and persisted-record contracts.

## Behavioral invariants

- Capture exact provider/model/thinking at dispatch. Revalidate the model definition and in-process provider implementation before start, without resolving credentials during preflight; include the captured selection in start permission hooks. Do not guess defaults or substitute a virtual router's physical model silently. Use the parent's public model registry and nested-tool APIs.
- Brief mode is the default and does not read/project parent history. Selected mode transmits only explicit bounded reference text. Full mode is opt-in projected history under an explicit user request; never use it to repair a vague brief.
- Preserve essential inherited instructions, advertised skills and callable tools without initializing extensions again. Necessary skill bodies are read by workers, not wholesale copied from earlier context.
- Require complete task/title/ETA/reason fields and valid uncertainty bounds. Automatic routing is strictly above 120 seconds; manual requests always delegate. Do not add a timer pretending to predict work.
- Accepted dispatch returns immediately. The main chat must remain usable; no sleep/poll loops, long foreground tool promise, or duplicate execution of accepted work.
- Keep a worker's abort signal independent of foreground cancellation. Explicit cancellation is cooperative and cannot roll back effects. Shutdown/session replacement cancels workers and handles stuck tools conservatively.
- No background-task workspace/resource read-write locks or conflict queues. Otherwise-authorized foreground/direct operations and workers may overlap on the same paths, including writes and opaque shell effects. Capacity/model/subprocess admission is independent and must not infer resource ownership. Keep host authorization hooks, read-worker restrictions, staged declarations and descriptor/hash/identity checks. Concurrent edits can overwrite each other, publication readers can see intermediate states and last-check/rename races remain possible. Legacy lock evidence is neither consulted nor mutated; source changes do not bypass an older loaded runtime. This is not an OS sandbox.
- Read-only workers cannot use mutating/unclassified tools. Tool annotations never authorize effects. Bind reviewed code contracts to exact host source identity and validate actual arguments, symlink/hardlink aliases and cache confinement. Original pi-web-access tools remain conservative. Only the actual reviewed narrow memory-only HTTPS implementation has source-bound contracts; enforce fixed HTTPS endpoints, verified TLS/public IPv4 DNS, reject redirects and command credentials, proxy/auth/media/download/extraction/workflow options and never use installed unsafe storage as a fallback. Hidden/model-only tools stay excluded; nested calls cannot recursively spawn workers, manage another job, or hijack Telegram delivery.
- Worker telemetry carries only allowlisted lifecycle/model/stream-kind/usage metadata. Preserve root ancestry, independent request IDs, once-only terminal/aggregate usage and error/cancellation finalization. Never emit prompts, messages, task titles/paths, arguments/results, reasoning, payloads, headers or raw errors.
- ETA updates are remaining duration plus elapsed time, with reasons and bounded uncertainty. They do not extend the runtime safety timeout. No invented percentages/deadlines.
- Persist output before queuing completion. Deliver through the main chat and do not blindly replay uncertain notifications after a crash.
- Accept worker prose only after a nonblank visible `stop` response without unfinished tool calls. Persist standalone deterministic fallbacks for other settlements; label failed partial prose unverified. No finalizer model calls or task/tool replay.
- Persist only closed diagnostic enums, validated counters/timestamps and known tool identities (`other` for unlisted identities). Preserve observed failure provenance, not guessed provider/preparation categories. Never copy reasoning, signatures, full transcripts, arguments/results, auth, raw errors or provider diagnostics. Visible prose itself still needs privacy review.
- Reject unsafe storage/result symlinks and traversal. A storage-failure fallback is bounded and process-local, explicitly non-durable; withhold completion reservation and retain once-only retrieval usage within that process.
- Report usage exactly once when results are fetched, including nested usage without double-counting reasoning. Pagination and notification delivery must not duplicate it.
- Failures, length stops, queue reasons/overflow and interrupted state remain explicit. Separate queued wait from execution ETA; revalidate the exact captured contract through host hooks before starting. Preserve original foreground links when queued workers start later. Never replay uncertain effects or copy full history automatically.
- Staged tools MUST use the owner-checked host broker, not parent-cwd builtins or direct execute functions. Enforce declared regular-file input/output/reference lists, private namespace identity, immutable input/base hashes and sealed output manifests. Publication is explicit, main-owned and authorization-reviewed, never a worker tool or automatic merge. Do not acquire target/temporary/recovery/reader workflow locks. Prepare every replacement first, roll back only unchanged owned replacement inodes (not merely equal content hashes), preserve recovery evidence and refuse automatic replay of that manifest. Once-only in-flight manifest checks are integrity, not cross-task resource ownership. Do not claim physical multi-file atomicity or ACL/xattr/OS isolation.

## Regression targets

- `policy.test.ts`, `effects.test.ts`: estimates, strict threshold, context/history boundaries, profile inheritance, source trust, malicious arguments, helper/shell denial, confined-cache concurrency, filesystem inspection, symlink/hardlink and parent-hook guards.
- `integration.test.ts`: actual Pi session responsiveness, context modes, permission forwarding, cancellation, model changes, usage, and shutdown.
- `manager.test.ts`: ETA revisions, overdue notification, cancellation, durable completion, and automatic routing state.
- `store.test.ts`: permissions, atomic output, context metadata/legacy records, corruption, independent cross-session persistence without leases, and interruption recovery.
- `reporting.test.ts`, `restore-reporting.test.ts`: strict terminal reporting, safe failure provenance, standalone fallbacks, secret exclusion, limits/shutdown and honest historical v1 lease diagnostics, storage faults, legacy restoration, notification durability and once-only paginated retrieval.
- `staging.test.ts`, `resource-race.test.ts`: real rooted file operations, concurrent writers/publications, immutable source versions, stale bases, alias swaps, rollback faults, once-only manifest integrity and independent managers ignoring untouched legacy lock/mutex evidence.
- `web.test.ts`, `web-fixture.ts`: actual memory adapter/configuration confinement, ownership/miss/collision/eviction behavior, safe credentials, unsupported variants and offline localhost TLS wire tests; never real credentials/provider calls.
- `admission.test.ts`: bounded local request/subprocess admission, foreground priority, aging and cancellation without preemption.
- `resume-safety.test.ts`: concurrent direct opaque effects without resource admission, nested ancestry identity, late web ownership, profile drift, bounded cancellation failures, storage aliases, rollback inode ownership and prepared-file races.
- `compaction.test.ts`: same-profile compaction and coherent tool-call/result retention.
- `loader.test.ts`: distributable entry point without starting runtime resources.

Use synthetic streams and private temporary roots. Tests must show real observable concurrency and inherited hooks, not just successful registration. Add race/fault cases when changing concurrency, settlement, persistence, notification, or cancellation. Run package verification, then shared verification for cross-package/API changes.

## Boundaries

This version requires long-lived TUI/RPC hosting and does not make jobs survive process exit. Provider lifecycle and AgentSession recovery are not fully duplicated; document intentional inheritance exceptions rather than promising a clone.

Creating documentation or code does not authorize global registration, turning automatic routing on/off in a live session, cancelling real jobs, changing runtime records, enabling another extension, or restarting Pi. Keep task archives and user deliverables private and outside Git. Do not commit, push, release, bump versions, or publish without explicit approval.
