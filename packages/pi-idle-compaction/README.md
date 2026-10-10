<div align="center">

# pi-idle-compaction

**Native [Pi](https://github.com/earendil-works/pi) compaction after an eligible idle period, with conservative background-work admission.**

[Installation](#installation) · [Behavior](#when-it-compacts) · [Coordination](#background-coordination) · [Development](#development) · [Support](#support-and-contact)

</div>

A standalone extension using Node built-ins and the public Pi API. No runtime npm dependencies, required subagent package, extra model provider, or child agent. It calls Pi's native compaction rather than replacing the summarization prompt or retention policy.

## Requirements

- **Node.js `>=26.10.0 <27`**, as declared by this package.
- Pi coding-agent peer **`^0.99.2 || ^1.0.0`**.
- Maintained offline baseline: Linux x64, Node 26.10.0, Pi 1.1.0. Other platforms and future APIs require their own checks.

Production does not need a package-local `node_modules` directory. Development tests need only this package's tools and the Pi host.

## Installation

After a release is published, npm installation is `pi install npm:pi-idle-compaction`. Until then, install the reviewed local package:

```sh
pi install /absolute/path/to/pi-extensions/packages/pi-idle-compaction
```

Keep the local source in place. Use `/reload` in an idle session when you intend to activate the new runtime. Do not also retain another copied entry for the same extension in automatic discovery.

To remove registration, use `pi remove <installed-source>` and safely reload. This does not remove other packages, skills, or runtime state. The package does not uninstall pi-subagents, alter another extension, edit settings, or restart the host automatically.

## When it compacts

All of the following must be true:

1. A **60-minute idle timer** has elapsed in a TUI/RPC host.
2. Estimated context is at least **100,000 tokens**.
3. New user/assistant history exists since the last compaction, and this history leaf has not already been attempted.
4. The parent is idle, with no pending messages.
5. Supported background admission checks are healthy and idle.
6. Those conditions still hold after asynchronous checks.

Input, agent/tool starts, dialogs, history navigation, compaction, and shutdown invalidate or suspend admission. Busy or unknown supported background state defers another full idle period. The same unchanged history is not retried after an attempt or failure. Print/JSON child or batch sessions do not run idle timers.

Compaction uses only `ctx.compact({ onComplete, onError })`. Pi's normal model selection, summarization instructions, reserve/retention budgets, and compaction settings remain in control. A real compaction may incur its normal model request/cost.

Native Pi controls:

```text
/idle-compact status
/idle-compact on
/idle-compact off
```

On/off is session-local and in memory. A fresh extension runtime defaults to enabled; reapply an intentional `off` after reload. These are Pi commands, not Telegram bot-menu commands.

## Background coordination

### Optional subagents and providers

When legacy `subagent`, `subagents_enable`, `subagent_supervisor`, or `bg_wait` tools are present, their same-session ping/fleet-idle RPC must be healthy. Missing/error replies remain unsafe. If those tools are absent, no subagent RPC is required or called.

The guard can read reviewed process-local v1 background registries. Unknown versions, malformed items, throwing providers, asynchronous results, duplicates, and same-session active work defer compaction.

Other extensions can explicitly use `registerBackgroundWorkProvider()` from `background.mjs` with neutral key `idle-compaction.background-work.v1`. Providers return bounded synchronous items containing only `id` and `sessionId`; optional reconciliation/wake metadata must follow that contract. Old disposers cannot unregister a replacement provider.

> [!IMPORTANT]
> This is not an OS-wide job supervisor. Arbitrary shell processes, remote jobs, and private extension state are invisible. Co-installing a background-capable package, including `@rcsaquino/pi-background-tasks`, does not automatically register a provider or prove that its work is covered. Review status and admission integration before relying on coordination.

Provider snapshots are observations, not exclusion leases. They are rechecked after asynchronous RPC admission, but cannot prevent unregistered or newly starting work.

## Development

From the monorepo root, prepare package-local development dependencies if needed:

```sh
npm --prefix packages/pi-idle-compaction install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-idle-compaction run verify
```

The shared host-link helper repairs missing/broken links only. A working but different host peer is not silently replaced. Use `PI_HOST_PACKAGE_DIR` for a nonstandard host.

Runtime modules:

- `index.ts`: Pi lifecycle/command adapter and optional RPC.
- `controller.mjs`: timers, thresholds, history invalidation, and lease lifetime.
- `background.mjs`: bounded provider snapshots and optional RPC admission, without foreign runtime files.

Tests use fake timers/compaction, private local fixtures, and the actual Pi loader. A test-only preload forbids network operations. The isolated loader check requires no runtime `node_modules` or subagent package. Its host-version gate follows the declared stable peer branches (0.99.x from 0.99.2, or 1.x), not a pinned validation minor; actual public loading, registration, commands, and cleanup must still pass. A matching version alone does not establish compatibility.

Read [AGENTS.md](AGENTS.md) for race/recovery regression requirements. Passing tests does not prove a paid compaction, a real 60-minute idle soak, or activation in a running host.

## Operational boundaries

Editing source is not hot activation. An approved deployment must preserve other extensions, settings, credentials, state, and unknown locks. Back up an existing installed copy outside automatic discovery before replacing it; never leave old and new entry directories discoverable together.

Use supported reload in an idle session, or a separately approved controlled restart. Do not inject terminal input or force live compaction merely to demonstrate installation. Restore reviewed backups only while the affected runtime is safely unloaded, retaining any dependencies an old version requires.

## Support and contact

If pi-idle-compaction is useful to you, you can support its development on
[Ko-fi](https://ko-fi.com/rcsaquino).

<a href='https://ko-fi.com/rcsaquino' target='_blank'><img height='72' style='border:0px;height:72px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
