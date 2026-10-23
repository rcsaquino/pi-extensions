# pi-skill-workshop

A foreground-only Skill Workshop extension for Pi. It manages learned skills under one managed root, snapshots every change to an existing skill, records why each change happened, and keeps versions, archives and usage outside the skills root so archived copies are never discovered as live skills. Snapshots are content-addressed: each distinct file content is stored once in a SHA-256 blob store, each version is an empty marker directory, and its manifest lives in a workshop-owned `manifests/` store.

The extension carries its own operating guidelines for the model, including the learning bar, the one-change-per-review rule, and self-containment. It does not require workspace `AGENTS.md` text or any other project instructions to function.

No reviewer model runs in the background. There are no timers, automatic reviews or scheduled cleanup: every operation, including idle cleanup, happens only when the `skill_workshop` tool is invoked.

## Install

After publication, or from a reviewed local checkout:

```sh
pi install npm:pi-skill-workshop
pi install /absolute/path/to/pi-extensions/packages/pi-skill-workshop
```

Pi loads `index.ts` directly. The package has no runtime dependencies beyond the Pi host and `typebox` peer packages.

## Tool

One tool, `skill_workshop`, exposes these actions:

| Action | What it does |
| --- | --- |
| `list` | List live skills with age and description. Set `archived` to include archived names. |
| `view` | Return one file's exact content. Defaults to `SKILL.md`; pass `version` to read a snapshot. Live views record usage. |
| `create` | Validate and create a new skill. Refuses an existing name. |
| `patch` | Replace one exact occurrence of `old` with `new` in `SKILL.md` or a support file. |
| `write_file` | Rewrite `SKILL.md` (full validation) or write a support file under `references/`, `templates/`, `scripts/` or `assets/`. Snapshot first. |
| `remove_file` | Remove a support file. Snapshot first. |
| `archive` | Snapshot, then move the skill to the archive. Requires `reason` or `absorbed_into`. |
| `restore` | Restore an archived skill, or a saved version when `version` is supplied. |
| `undo` | Undo the newest change, or the change named by `id`. Handles create, archive and versioned changes; archive undo removes the archive copy. |
| `changes` | Read the change feed newest first. `limit` defaults to 20; `name` filters by skill. |
| `cleanup` | Archive idle skills, 30 days by default. Pinned skills are exempt. Supports `dry_run` and a once-per-day marker. |

Validation is automatic, not a separate action: `create`, `patch` of `SKILL.md`, and `write_file` of `SKILL.md` return blocking errors or non-blocking advisories.

### Examples

```json
{ "action": "list" }
{ "action": "view", "name": "release-notes", "file": "references/checklist.md" }
{ "action": "create", "name": "release-notes", "content_path": "/tmp/SKILL.md", "reason": "learned release checklist" }
{ "action": "patch", "name": "release-notes", "old": "old step", "new": "new step", "reason": "corrected order" }
{ "action": "write_file", "name": "release-notes", "path": "references/checklist.md", "content": "- verify tags\n" }
{ "action": "archive", "name": "release-notes", "absorbed_into": "release-process", "reason": "merged" }
{ "action": "restore", "name": "release-notes" }
{ "action": "undo", "id": "a1b2c3d4e5f6" }
{ "action": "changes", "name": "release-notes", "limit": 10 }
{ "action": "cleanup", "days": 30, "dry_run": true }
```

### Arguments

- `name`: skill directory name, 1-63 lowercase letters, digits or hyphens, starting alphanumeric.
- `version`: saved version id, `YYYYMMDDTHHMMSSZ-xxxxxx`.
- `file`: file to view or patch, relative to the skill; defaults to `SKILL.md`. Also accepted as an alias for `path`.
- `path`: support-file path; `write_file` defaults to `SKILL.md` when omitted.
- `content` / `content_path`: inline text or a file to read. Exactly one for `create` and `write_file`.
- `old` / `old_file`, `new` / `new_file`: exactly one from each pair for `patch`.
- `reason`, `absorbed_into`: change-feed context; `absorbed_into` is archived with the change.
- `id`: 12-character change id for `undo`.
- `days`, `dry_run`, `force`: cleanup threshold, preview, and marker override.
- `archived`: include archived names in `list`.
- `limit`, `name` or `skill`: change-feed page size and skill filter.

## Paths and state

Defaults are derived from the Pi agent directory (`PI_CODING_AGENT_DIR`, expanded and normalized, otherwise `~/.pi/agent`):

- Managed root: `<agent-dir>/skills/skill-workshop`
- State: `<agent-dir>/skill-workshop`

`PI_CODING_AGENT_DIR` must be absolute (or start with `~/`); a relative override is rejected. Both paths are configurable for isolated tests:

```sh
PI_SKILL_WORKSHOP_ROOT=/tmp/skills PI_SKILL_WORKSHOP_STATE=/tmp/state pi ...
```

The state root must stay outside the managed root, both lexically and after symlink resolution, and neither configured root may itself be a symlink or a non-directory. The resolved paths are checked before any write. State contains `versions/`, `manifests/`, `blobs/`, `archive/`, `changes.jsonl`, `usage/` and the `last-cleanup` marker. Pre-existing directories are never chmodded; directories created by the workshop are `0700`. Archived skills are never under the managed root. A current-format version is an empty `0700` marker directory at `versions/<skill>/<version>/`; its manifest is stored separately at `manifests/<skill>/<version>.json`, mode `0600`, and file bytes live once under `blobs/<sha256[0:2]>/<sha256>`, mode `0600`. Manifests are written atomically.

## Safety properties

- Every change to an existing skill snapshots the previous tree before mutation. `create` has no previous tree to snapshot.
- A snapshot stores each file's bytes once, addressed by its SHA-256, and records path, mode and size in a sorted manifest under `manifests/`. Unchanged files are not duplicated across versions.
- The newest 10 versions per skill are kept and the snapshot just written is never pruned; the change feed keeps the newest 500 entries. Pruning removes the version marker and its manifest. Blobs referenced by no remaining version manifest are deleted, and orphan manifests whose version directory no longer exists are removed. Garbage collection is skipped entirely if any manifest is unreadable or the manifest, version or blob store has unexpected entries.
- Existing legacy full-copy version directories, which contain real files and have no manifest in the store, remain readable by `view`, `restore` and `undo`; there is no bulk migration. Version and archive views write nothing; a live `view` records usage under the state root, as the tool description says.
- Restores rebuild the tree from the manifest, verify every blob's SHA-256, then stage a complete copy beside the live tree and swap it into place atomically. A missing or mismatched blob refuses the restore before the live tree is touched.
- No skill filename is reserved. A root-level `manifest.json` is ordinary skill content and is snapshotted, viewed, restored and undone like any other file.
- Symlinks are refused in live and version trees, on paths between a file and its trusted root, and when resolving view targets. Absolute paths and `..` traversal are refused.
- `SKILL.md` is capped at 40,000 bytes; support files at 256 KiB. Support-file `patch` and `write_file` validate size and literal-secret patterns before publishing, then scan the whole tree. A post-write failure restores the snapshot and records no change, so a rejected edit cannot persist a secret or an oversized file.
- Frontmatter name, description and size are validated. Common private-key and token patterns are rejected in skill and support text.
- The change feed appends one durable line under a cross-process lock and trims only beyond a small slack above 500 entries. A mutation whose feed record fails is rolled back, and no version/archive state is silently left as the only trace.
- The version, manifest and archive trees are private (`0700`); manifests are `0600`, and live and restored skills are `0755`.
- Pinned skills (`pinned: true`, `yes` or `1`) are exempt from cleanup.
- Cleanup writes a once-per-day marker; `dry_run` writes nothing. `force` bypasses only the marker.
- The extension registers a tool only. The factory creates no files, timers, processes or model calls.

## Development

From this package directory:

```sh
npm install --ignore-scripts --legacy-peer-deps --workspaces=false
npm run check
npm test
npm run verify
npm pack --dry-run --ignore-scripts --workspaces=false
```

Tests use temporary roots and state only; they never read or write the live Skill Workshop library. See [AGENTS.md](AGENTS.md) for architecture and invariants.

## Release

Package version `0.1.0`, MIT, public npm access. Publication, registration in Pi settings, and session/service restarts are separate operator actions. See the repository [RELEASING.md](https://github.com/rcsaquino/pi-extensions/blob/main/RELEASING.md).
