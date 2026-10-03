# Releasing independent packages

The repository root is a private development workspace. Release individual package directories, never the root or every workspace implicitly. Preparing manifests, running tests, or creating a GitHub release does not publish a package.

The only automated publication path is `pi-memoria` through `.github/workflows/publish-pi-memoria.yml`; every other package is released manually. Git initialization, commits, pushes, tags, GitHub releases, npm authentication, and publication each require the operator's approval, and pushing a `pi-memoria-v<version>` tag is the publication authorization for that package. Do not deploy or reload the running Pi host during release verification.

## Package identities

Prepared versions are independent and are not claims of publication:

- `packages/pi-auto-learn`: `pi-auto-learn` **0.1.0**.
- `packages/pi-background-tasks`: `@rcsaquino/pi-background-tasks` **0.1.0**.
- `packages/pi-idle-compaction`: `pi-idle-compaction` **0.1.0**.
- `packages/pi-latency-analytics`: `pi-latency-analytics` **0.1.0**.
- `packages/pi-memoria`: `pi-memoria` **0.3.2**, the patch after public 0.3.1.
- `packages/pi-telegram`: `@rcsaquino/pi-telegram` **0.2.0**.

The scoped identities avoid unrelated unscoped npm packages. The source folder, Pi entry point, tool/command names, and private runtime paths do not change with an npm scope. All packages declare public publication access; the root remains private.

## Preparation and dry runs

From the monorepo root, follow [README.md](README.md) and the target package's setup instructions. The complete suite requires Node `>=26.10.0 <27`, npm, a Node-based Pi host, rg, flock, and ffmpeg. Install package-local dependencies with lifecycle scripts disabled; do not hoist or update the host as a release side effect.

No package lockfile is currently committed. Use the documented package-local `npm install --ignore-scripts --legacy-peer-deps --workspaces=false` commands. If a usable lockfile is deliberately introduced later, generate/update it through npm and review it before choosing `npm ci`.

Run:

```sh
npm run verify
```

This checks all package types/tests and the offline publication regressions. For a focused metadata/documentation check, use `npm run check:publication`.

Choose exactly one package for tarball and publication dry runs, for example:

```sh
PACKAGE=packages/pi-memoria
(
  cd "$PACKAGE"
  npm pack --dry-run --ignore-scripts --workspaces=false
  npm publish --dry-run --ignore-scripts --access public --workspaces=false
)
```

Review the tarball's exact name/version, Pi manifest, complete runtime import tree, README, AGENTS.md, LICENSE, and intended configuration examples. Reject secrets, transcripts, databases, runtime state, fixtures, caches, or physical host packages. `--ignore-scripts` prevents lifecycle side effects. Dry runs neither reserve names nor verify npm write permissions.

Before an approved release, query the public npm registry for the exact name and version. A 404 for an unpublished name/version is expected, but is not an ownership reservation. Never replace an existing version. A patch must advance the existing public release; do not reset memoria to 0.1.0 or accidentally move its `latest` tag backward.

## Automated pi-memoria publication

`packages/pi-memoria` is the only package with an automated publication path. Pushing a `pi-memoria-v<version>` tag that points at a commit on `main` runs `.github/workflows/publish-pi-memoria.yml`, which:

1. Requires the tag to match `packages/pi-memoria/package.json` exactly and the tagged commit to be an ancestor of `main`.
2. Refuses a version that is already published or that does not advance the published `latest`.
3. Installs every package's dependencies through the documented package-local commands, then runs the full `npm run verify` gate (types/tests plus offline publication regressions).
4. Publishes from `packages/pi-memoria` with `npm publish --ignore-scripts --access public --workspaces=false`, using npm trusted publishing (OIDC) and automatically generated provenance. No npm token is stored in the repository.
5. Confirms the new version, tarball, and dist-tags from the public registry.

One-time npm configuration is required before the first run. In the `pi-memoria` package settings on npmjs.com, add a GitHub Actions trusted publisher:

- Organization or user: `rcsaquino`
- Repository: `pi-extensions`
- Workflow filename: `publish-pi-memoria.yml` (filename only, including the extension)
- Environment name: leave blank unless a matching GitHub environment gate is added
- Allowed actions: include **`npm publish`**. Newer npm configurations default to `npm stage publish` only, so direct publishing must be enabled explicitly. This deliberately skips the 2FA approval step: a tag push publishes unattended. To add a human approval gate later, configure the trusted publisher as stage-only and switch the workflow to `npm stage publish` plus a maintainer `npm stage approve` step.

The old trusted publisher for the standalone `rcsaquino/pi-memoria` repository does not apply. npm does not verify these fields when saving, so double-check them; a mismatch only surfaces as an authentication failure during a tagged publish. Strongly recommended afterwards: restrict the package's publishing access to 2FA without tokens, and add a tag protection rule for `pi-memoria-v*`.

If the workflow fails after a successful publish (for example during the confirmation step), do not re-run it: the version guard refuses the already-published version. Confirm the registry state manually and prepare a new patch version if another publish is required.

## Source history and tags

After Git has deliberately been initialized, review the intended diff and commit only authorized source files. Use package-specific tags, for example:

- `pi-memoria-v0.3.2`
- `pi-telegram-v0.2.0`
- `pi-background-tasks-v0.1.0`

The folder identifier keeps tag names distinct even for scoped npm packages. Do not create an ambiguous root `vX.Y.Z` tag for independently versioned packages. Do not recreate deleted Git history automatically.

A GitHub release may describe that package's reviewed tag and changes. Publishing the release does not itself publish to npm; for `pi-memoria`, creating a release that pushes a new `pi-memoria-v<version>` tag does trigger the automated workflow. Do not describe a package as published until the registry confirms it.

## Authorized npm publication

The account must control the selected name or scope and satisfy npm's current authentication and 2FA requirements. Use a secure operator terminal; never put credentials in command arguments, source, logs, or model context. `npm whoami` can confirm the signed-in account but does not by itself establish every package's write permission.

Only after publication is expressly authorized, run from the selected package directory:

```sh
npm publish --ignore-scripts --access public --workspaces=false
```

For `pi-memoria`, the tag-driven workflow above is the preferred path; this manual command remains an approved fallback.

Public access is explicit for the scoped packages. Do not use a root `npm publish --workspaces` command. Keep first publications, version bumps, and changes to dist-tags deliberate and package-specific.

After publication, confirm the exact version, dist-tag, and downloadable tarball from the public registry. For memoria, for example:

```sh
npm view pi-memoria@0.3.2 version dist.tarball
npm view pi-memoria dist-tags
```

Allow for registry processing before declaring success. Test installation from the public registry only after separate approval to change a Pi installation.

## Adding automation for other packages

CI and trusted publishing are per-package configuration, not prerequisites silently performed by this guide. The `pi-memoria` workflow covers only `pi-memoria`; it must not be extended to publish other packages implicitly, and `pi-memoria` must not be added to a workflow that publishes another package.

If another package is later automated, add a reviewed package-specific workflow that repeats the same guards: exact tag-to-manifest match, tagged commit on `main`, an unpublished version that advances `latest`, the full `npm run verify` gate, `npm publish --ignore-scripts --access public --workspaces=false` from that package directory, and a post-publish registry check. Configure that package's own trusted publisher on npm with the exact `rcsaquino/pi-extensions` repository and workflow filename, and verify the configuration explicitly before promising automatic publication.
