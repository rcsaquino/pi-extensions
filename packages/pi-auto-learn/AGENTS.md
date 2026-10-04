# Working on pi-auto-learn

Read [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). This package owns one configured managed-skill container and a separate private state tree. Directory placement, not the skill's origin or an ownership marker, defines its mutation scope.

## Setup and checks

From the monorepo root:

```sh
npm --prefix packages/pi-auto-learn install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run link-host
npm --prefix packages/pi-auto-learn run check
npm --prefix packages/pi-auto-learn test
npm --prefix packages/pi-auto-learn run verify
```

Only install dependencies when needed. The root host-link helper preserves working dependency trees; do not hand-edit lockfiles or dependency source. Node 22.19+ is declared, and the maintained full suite uses Node 26.10.0. The declared coding-agent peer is `^0.99.2 || ^1.0.0`, matching the exercised host lines; do not broaden that policy during unrelated work.

## Module map

- `index.ts`: forwards the distributable root entry point to `src/index.ts`.
- `src/index.ts`: Pi lifecycle, commands/tool, scheduling, streaming, and prompt metadata.
- `model-profile.ts`: selected/dispatched model and thinking inheritance.
- `observations.ts`, `privacy.ts`: bounded visible evidence, eligibility, filtering, and safe displays.
- `tool-evidence.ts`: paired host-tool activity/task ancestry, late/cancelled boundaries and bounded originally admitted task diagnostics, separate from automatic foreground evidence.
- `learner.ts`: admission, budget reservation, proposal, and fresh critique.
- `validation.ts`, `skill-library.ts`: protocol/schema, inventory, names, dependencies, and retirement rules.
- `safe-writer.ts`, `filesystem.ts`: optimistic tree checks, snapshots, staged text changes, retirement, restore, and rollback.
- `state.ts`, `lock.ts`: private accounting, transactions, cross-process leases, and foreground admission.
- `bootstrap.ts`: structural-recovery seed, not an immutable replacement for healthy policy.

## Invariants

- Never mutate skills outside the configured managed root. Keep the container root free of `SKILL.md` and state separate/non-overlapping. Skills outside the container are not candidates, even if their topic matches an observation.
- Treat user-added and generated managed skills equally, preserving existing natural names. Do not introduce management prefixes, ownership markers, or implicit per-skill enrollment records.
- Proposal and fresh-review requests are tool-free and inherit the successful foreground physical profile, including virtual-router dispatch and effective thinking. Do not substitute a cheaper route, lower thinking, or silently truncate required capacity.
- Reject invented evidence references and stale branch/profile/tree snapshots. New foreground input, model/navigation changes, cancellation, and shutdown must prevent later publication.
- Keep automatic authoring text-only. Scripts/assets, file modes, empty directories, nested independent skills, pins, and incoming references require preservation and conservative boundary checks.
- Publish new versioned references before switching `SKILL.md`; do not overwrite existing referenced documents in place. Full-tree guards must detect unrelated manual script edits too.
- Preserve whole-skill retirement archives, verify cross-filesystem copies, and reconcile known journal outcomes rather than repeating uncertain effects. Restore needs a vacant slot; rollback must not overwrite new user asset edits.
- Keep the mutable policy genuinely editable through the reviewed pipeline. Bootstrap only missing/structurally invalid core; deletion recovers core/container, not previously removed task skills. Pause/disable/exclusion and unsafe targets may defer repair.
- Do not hold writer/state gates during model inference. Keep foreground admission and final automatic commits serialized through the short cooperative gate; never claim zero filesystem wait or OS-wide exclusion.
- Preserve budgets, bounded retries, uncertain reservations, bounded inputs/files, and explicit deferral. Editable policy cannot relax fixed kernel limits.
- Keep unused-only retirement evidence-based and separated by fresh reviews. Suppression, pins, tombstones, manual re-enrollment, and restoration have distinct semantics.
- Hidden thinking, raw tool payloads, abandoned branches, and unauthenticated guest evidence stay excluded. Privacy filtering and same-model review are not guarantees.

## Regression tests

- `entrypoint.test.ts`: packaging, root forwarding, and resource discovery without session startup.
- `learner.test.ts`: same-profile proposal/review, evidence, no-op, budgets, cancellation, and retirement.
- `lifecycle.test.ts`: policy recovery, foreground activity, managed/unmanaged boundaries, and restoration.
- `safety.test.ts`: schema, paths/links, inventory, privacy, and dependency/pin rules.
- `transactions.test.ts`: full-tree guards, journal recovery, archive copy, concurrent gates, and backup retention.
- `pi-integration.test.ts` and the isolated CLI fixture: actual Pi loading/model dispatch and mode behavior.

Fixtures live in ignored local `.test-tmp/` trees. Never point them at actual user skills/state or run a live provider as a test. Add meaningful fault-injection/race tests when touching transactions or admission. Run the package suite, then shared verification for integration/path changes.

## Operator and deployment boundaries

`auto_learn_status` is read-only; inspection cannot approve or execute proposals. Destructive purge needs an interactive confirmation-capable client, not an invented `confirm` argument. A command can request eligible work without bypassing safety or budgets.

Do not edit the live learning policy, pause/disable production, pin user skills, clear evidence, purge archives, deploy installed copies, or reload/restart the host merely to validate source changes. These are operator actions requiring explicit authorization. Keep runtime audit/proposal/backup/retirement data private and out of Git. No commit, push, version bump, release, or publication without approval.
