# Working on pi-skill-workshop

This package is a TypeScript Pi extension with one `skill_workshop` tool. README.md documents the product; this file documents how to change this package. Read the [monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [release process](https://github.com/rcsaquino/pi-extensions/blob/main/RELEASING.md) for shared tooling and authorized publication.

## Architecture

- `index.ts`: Pi factory, TypeBox schema, tool guidance and the foreground execution boundary.
- `src/config.ts`: environment paths derived from `PI_CODING_AGENT_DIR`; refuses relative overrides, symlinked roots, and state inside the managed root (lexically and canonically).
- `src/workshop.ts`: actions, snapshot orchestration, restore staging, archive/undo, change feed, usage and cleanup.
- `src/blobs.ts`: SHA-256 content-addressed blob store; private atomic writes and verified reads.
- `src/snapshots.ts`: manifest capture, validation, materialization and conservative blob garbage collection.
- `src/files.ts`: path containment, symlink refusal, private directories, legacy skill copying, atomic moves and view resolution.
- `src/validation.ts`: name/version/change-id formats, frontmatter and description checks, secret patterns, support paths and tree scans.
- `src/errors.ts`: expected `WorkshopError` failures.
- `tests/`: core behavior and a real Pi loader/SDK test using isolated roots.

## Commands

From this package directory; from the monorepo root, use `npm --prefix packages/pi-skill-workshop` before the same operation.

- `npm install --ignore-scripts --legacy-peer-deps --workspaces=false`: install package-local development dependencies.
- `npm run check`: strict TypeScript checking.
- `npm test`: core lifecycle, safety and loader tests against temporary directories.
- `npm run verify`: typecheck and tests.
- `npm pack --dry-run --ignore-scripts --workspaces=false`: inspect the distributable.

## Invariants

- Keep the surface to the documented actions. `write_file` handles both `SKILL.md` rewrites and support files; validation is automatic, not a separate action.
- The tool's `promptGuidelines` are the operating policy: purpose, learning bar, one-change-per-review, workflow and self-containment. The package must remain functional without workspace `AGENTS.md` or other project instruction files.
- Never add a background reviewer, timer, scheduled cleanup or startup filesystem mutation. `cleanup` runs only from the tool call.
- Snapshot an existing skill before every mutation. `create` is the only mutation without a previous tree. Validate support-file size/secrets before publishing; on any post-write tree/feed failure restore the snapshot and record nothing. `publish` and `rollbackVersion` are the only supported path for a file replacement.
- Keep at most 10 versions per skill and 500 change-feed entries (trim with bounded slack), and never let retention prune the version the snapshot call just wrote. Archive copies, versions, usage and the cleanup marker stay outside the managed root. Serialize the change-feed append/trim with the cross-process state lock and append rather than rewriting the feed; roll back a mutation if its record cannot be written (create, patch, write_file, remove_file, archive, restore, undo and cleanup cover this path).
- Version directories are empty `0700` marker directories at `<state>/versions/<skill>/<version>/`. The corresponding manifest lives outside every skill and version tree at `<state>/manifests/<skill>/<version>.json` (sorted paths, SHA-256, mode, size, schema and creation time), written atomically with mode `0600` and directories `0700`. No skill filename is reserved: a root-level `manifest.json` is ordinary content. Payload bytes live in the shared `blobs/` store, mode `0600`, written temp-file-then-rename and only when absent. Reject extra entries in a version marker during materialization.
- Legacy version directories with real files and no manifest in the store remain readable for view, restore and undo. Do not migrate them at load time, and do not write state during read-only actions.
- Restore by materializing the manifest into a private staging tree, verifying every blob hash and size, then swapping it into place; never write the live tree in place and never hardlink a blob into it.
- Prune blobs only after retention removes a version. Retention removes both the version marker and its manifest. Garbage collection scans `<state>/manifests/**` for references, removes manifests whose version directory no longer exists, and deletes only blobs nothing references. Skip the entire deletion pass if any manifest is unreadable or the manifest, version or blob store has unexpected entries or symlinks; an archived skill needs its own reference scan only if archive starts sharing the blob store.
- Refuse symlinks, absolute paths, `..` traversal and unsupported file types. Do not follow a symlink to decide containment.
- Enforce the 40,000-byte `SKILL.md` cap, 256 KiB support cap, description cap/advisory, frontmatter identity and literal-secret checks.
- Keep `pinned` skills out of cleanup and preserve the once-per-day marker.
- Use explicit `.ts` imports, strict types and Node built-ins. Do not add sibling imports, sibling dependencies, a build step, network calls or model calls.
- Tests must use temporary roots and state, never the live library or user settings.

## Verification

Run `npm run verify` before delivery. For cross-package changes or final verification, run the root `npm test`, `npm run check` and `npm run verify`. Report commands, counts and remaining gaps.

## Releasing

Follow the monorepo release process only after explicit approval. Version `0.1.0`, package name `pi-skill-workshop`, MIT, public access. Use a package-specific tag such as `pi-skill-workshop-v0.1.0`, not a root version tag. Commit, push, tag, GitHub release, npm publication, Pi registration, session reload and service restart remain separately authorized actions.
