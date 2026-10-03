<div align="center">

# pi-auto-learn

**Let [Pi](https://github.com/earendil-works/pi) maintain a bounded skill library in the background, without rewriting its own kernel or touching unrelated skills.**

[Installation](#installation) · [How it works](#how-it-works) · [Controls](#controls) · [Safety](#safety-and-privacy) · [Support](#support-and-contact)

</div>

Creates, improves, and recoverably retires skills inside one configured directory. It uses the foreground model and effective thinking profile for separate, tool-free proposal and fresh-review requests. Every valid skill in that directory is eligible, whether added manually or generated; there are no ownership markers or management prefixes.

## Requirements

- Node.js **22.19+** and a Node-based Pi host using the `@earendil-works` packages.
- Declared coding-agent peer range: **`^0.99.2 || ^1.0.0`**. Pi 0.99.2 and 1.0.0 have been exercised offline; the manifest includes both supported host lines.
- A private writable managed-skill container and a separate state directory.

`yaml` is a runtime dependency. Pi supplies the host peers. An offline compatibility result is not a promise for every future API, provider, or long-running deployment.

## Installation

From the monorepo root, prepare dependencies if needed:

```sh
npm --prefix packages/pi-auto-learn install --ignore-scripts --legacy-peer-deps --workspaces=false
```

After a release is published, npm installation is `pi install npm:pi-auto-learn`. Until then, install only the reviewed local package:

```sh
pi install /absolute/path/to/pi-extensions/packages/pi-auto-learn
```

Use `/reload` in an idle Pi session when you intend to activate it. Keep the local checkout in place. Do not also copy the same extension into automatic discovery. `pi remove <installed-source>` removes registration, not managed skills or recovery archives.

> [!WARNING]
> Placing a skill inside the managed root enrolls it in the learning lifecycle. Keep manually maintained or imported skills outside that root when you do not want automatic improvement or retirement.

## How it works

```text
foreground settles
  -> bounded visible current-branch evidence
  -> idle/budget/shared-lease admission
  -> same-profile proposal, without tools
  -> deterministic validation
  -> fresh same-profile review, without tools
  -> final activity/profile/tree guards
  -> safe text update or recoverable retirement
```

Automatic learning runs in long-lived TUI/RPC hosts after `agent_settled`. Ordinary print/JSON prompts do not silently start inference; an explicit `/auto-learn run` can still request an eligible batch. New foreground input, model changes, navigation, and shutdown cancel this instance's worker.

Physical model selections retain their provider/model/thinking configuration. A virtual router uses the successful foreground response's physical model and effective level; a cheaper direct route is not substituted. Insufficient model context/output capacity defers work rather than lowering thinking.

The mutable `learning-policy/SKILL.md` and its references can improve through the same reviewed pipeline. Missing or structurally invalid policy files are rebuilt deterministically without a model call. Deleting the managed root recovers the container and policy, not previously deleted task skills. Pause/disable and unsafe state can defer repair.

There is no second extension-loaded Pi session, recursive worker toolset, foreground continuation, or automatic per-skill notification stream.

## Directories

Defaults are relative to Pi's agent directory, normally `~/.pi/agent`:

```text
<agent-dir>/
├── skills/auto-learn/
│   ├── learning-policy/SKILL.md
│   ├── learning-policy/references/
│   └── example-workflow/SKILL.md
└── auto-learn/
    ├── config.json
    ├── state.json
    ├── history/
    ├── proposals/
    ├── backups/
    ├── retired/
    ├── transactions/
    └── locks/
```

The skill container must **not** contain its own root `SKILL.md`: Pi would stop descending. Skills are directories containing `SKILL.md`, optionally nested. An omitted frontmatter name can use the directory's fallback name. Nested independent skills prevent whole-parent retirement.

Runtime state is private and separate from active skill discovery. Never publish it as repository source.

## Controls

These are native **Pi** commands, not Telegram bot commands. On a transport without native command routing, ask the main agent for the read-only `auto_learn_status` tool; that tool cannot approve or mutate proposals.

```text
/auto-learn status
/auto-learn list
/auto-learn history [skill-id]
/auto-learn diff <skill-id> [revision-id]
/auto-learn pause
/auto-learn resume
/auto-learn run
/auto-learn cleanup
/auto-learn pin <skill-id>
/auto-learn unpin <skill-id>
/auto-learn suppress <workflow text>
/auto-learn exclude-session
/auto-learn clear-evidence
/auto-learn retired
/auto-learn restore <retirement-id>
/auto-learn rollback <skill-id> <revision-id>
/auto-learn purge <retirement-id>
```

IDs are paths relative to the managed root, not necessarily frontmatter names. Inspect `list`/`history` before changing anything.

- **Pause** cancels work and stops automatic active-skill mutations; resume can recover core and reschedule.
- **Cleanup** requests an eligible cleanup opportunity, not forced deletion.
- **Pin** protects a managed skill from automatic updates and retirement.
- **Suppress** blocks recreation of a workflow; it is distinct from retirement.
- **Exclude-session** removes that session's queued evidence. Clear-evidence does not erase original Pi conversations.
- **Restore** requires a verified archive and vacant original slot. Rollback restores prior documents while preserving current scripts/assets.
- **Purge** permanently removes a selected retirement archive only after a confirmation-capable interactive client approves it. It never runs automatically and does not erase workflow tombstones.

Read-only tool actions are `status`, `list`, `history`, and `retired`.

## Configuration

The state directory's `config.json` is initialized with bounded defaults. Unknown fields, wrong types, and unsafe limits are rejected. Key defaults:

- `enabled: true`, `advertise: true`, `admitGuests: false`.
- Idle debounce: `debounceMs: 20000`; periodic scheduling: `intervalMs: 300000`.
- Request timeout: `timeoutMs: 180000`; cleanup interval: `cleanupIntervalMs: 86400000`.
- Hourly budget: `hourlyBatches: 4`, `hourlyTokens: 200000`.
- Answer allowance: `answerTokens: 8192`; inherited thinking can increase the total output reservation.
- Evidence retention: `observationDays: 7`.
- Unused-only review: `unusedDays: 90`, `unusedRuns: 50`, `reviewGapDays: 7`.
- Proposal ceilings: `maxChanges: 3`, `maxDeletes: 1`, `maxRetries: 2`.
- Retained verified backups per skill: `backupRevisions: 20`.

See [`src/config.ts`](src/config.ts) for the complete schema and bounds. Actual usage is recorded; cancelled or uncertain requests conservatively retain reservations. Reported costs are estimates, not a billing guarantee.

Startup flags:

- `--auto-learn-disabled`: disable learning and core repair for this process.
- `--auto-learn-no-advertise`: suppress managed prompt metadata integration.
- `--auto-learn-root <absolute-path>`: select the managed container.
- `--auto-learn-state <absolute-path>`: select separate private state; it must not overlap the skill root.

Normal `--no-skills`, exclusions, and forced prompts are respected. SDK hosts using a private resource-loader `noSkills` setting should also supply the no-advertise flag. Native skill-command completion may need a supported reload even when next-turn metadata has refreshed.

## Safety and privacy

- Automatic authoring is limited to `SKILL.md` and text references. Existing executable scripts/assets are preserved, never automatically generated or edited.
- Complete-tree hashes, pins, dependency checks, nested-skill boundaries, and final activity/profile guards protect commits from stale proposals and manual edits.
- Whole-skill retirement preserves files, modes, and empty directories in a verified archive. Cross-filesystem retirement verifies the copy before source removal; journals reconcile known outcomes without blindly replaying deletion.
- Unused-only retirement needs meaningful observation and two separated reviews. Age alone does not establish disuse. Broken/redundant/stale skills may qualify through other reviewed evidence.
- Risky additions remain pending for human inspection. A pending proposal is not approval.
- Symlinks, hard links, traversal, unsafe targets, oversized trees, and corrupt state fail closed. Cooperating workers share leases, budgets, heartbeats, and a short commit/admission gate.
- Evidence excludes hidden thinking, raw tool payloads, full transcripts, old abandoned branches, and unauthenticated guests. Secret/record filtering is **best-effort**, not complete de-identification.
- Extension-source input is excluded by default. When `pi-telegram` is also loaded, authenticated private human submissions carry a one-use, async-scoped in-process receipt. Admission also requires the exact corresponding user message to be consumed and its request to settle successfully. Initial/FIFO and steering inputs use the same path; timestamps or textual transport markers confer no trust. Generic extension inputs and notification-only task reports remain excluded even with `admitGuests: true`. Receipts expire after ten minutes and are revoked by navigation/shutdown; transformed, replayed or ambiguous inputs fail closed. The event bus assumes trusted executable extensions, not a sandbox against malicious extension code.

> [!IMPORTANT]
> Exclude a session, pause, or disable learning before sensitive patient, credential, or legal-record workflows. A manually authored sensitive skill can still be read by Pi independently of this extension. Same-model review is a separate checkpoint, not independent expert validation.

The fixed kernel does not rewrite itself. Editable policy cannot enlarge filesystem authority, bypass review, or remove the reserved core slot permanently. Recovery archives/history persist until authorized maintenance; no automatic permanent purge is provided.

## Development

With package dependencies available, from the monorepo root:

```sh
npm run link-host
npm --prefix packages/pi-auto-learn run verify
```

The shared host-link helper repairs missing/broken development links only. Tests use private local trees, synthetic providers, and actual Pi SDK/CLI fixtures, not real user skills or live providers.

See [AGENTS.md](AGENTS.md) for the module map, transaction/profile invariants, and regression targets. Historical plans and deployment reports describe their own checkpoints, not a claim of current production activation.

## Support and contact

If pi-auto-learn is useful to you, you can support its development on
[Ko-fi](https://ko-fi.com/rcsaquino).

<a href='https://ko-fi.com/rcsaquino' target='_blank'><img height='72' style='border:0px;height:72px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
