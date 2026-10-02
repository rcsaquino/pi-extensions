# Releasing independent packages

The repository root is a private development workspace. Release individual package directories, never the root or every workspace implicitly. Preparing manifests, running tests, or creating a GitHub release does not publish a package.

There is **no automatic CI or npm publication workflow** in this checkout. Git initialization, commits, pushes, tags, GitHub releases, npm authentication, and publication each require the operator's approval. Do not deploy or reload the running Pi host during release verification.

## Package identities

Prepared versions are independent and are not claims of publication:

- `packages/pi-auto-learn`: `pi-auto-learn` **0.1.0**.
- `packages/pi-background-tasks`: `@rcsaquino/pi-background-tasks` **0.1.0**.
- `packages/pi-idle-compaction`: `pi-idle-compaction` **0.1.0**.
- `packages/pi-latency-analytics`: `pi-latency-analytics` **0.1.0**.
- `packages/pi-memoria`: `pi-memoria` **0.3.2**, the prepared patch after public 0.3.1.
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

## Source history and tags

After Git has deliberately been initialized, review the intended diff and commit only authorized source files. Use package-specific tags, for example:

- `pi-memoria-v0.3.2`
- `pi-telegram-v0.2.0`
- `pi-background-tasks-v0.1.0`

The folder identifier keeps tag names distinct even for scoped npm packages. Do not create an ambiguous root `vX.Y.Z` tag for independently versioned packages. Do not recreate deleted Git history automatically.

A GitHub release may describe that package's reviewed tag and changes. It does **not** trigger npm publication in this repository. Do not describe a package as published until the registry confirms it.

## Authorized npm publication

The account must control the selected name or scope and satisfy npm's current authentication and 2FA requirements. Use a secure operator terminal; never put credentials in command arguments, source, logs, or model context. `npm whoami` can confirm the signed-in account but does not by itself establish every package's write permission.

Only after publication is expressly authorized, run from the selected package directory:

```sh
npm publish --ignore-scripts --access public --workspaces=false
```

Public access is explicit for the scoped packages. Do not use a root `npm publish --workspaces` command. Keep first publications, version bumps, and changes to dist-tags deliberate and package-specific.

After publication, confirm the exact version, dist-tag, and downloadable tarball from the public registry. For memoria, for example:

```sh
npm view pi-memoria@0.3.2 version dist.tarball
npm view pi-memoria dist-tags
```

Allow for registry processing before declaring success. Test installation from the public registry only after separate approval to change a Pi installation.

## If automation is added later

CI and trusted publishing are separate configuration work, not prerequisites silently performed by this guide. An old trusted publisher for `rcsaquino/pi-memoria` does not authorize `rcsaquino/pi-extensions`.

If GitHub Actions/OIDC is chosen later, add a reviewed root workflow, validate the package-specific tag/version/directory, and configure each npm package's exact `rcsaquino/pi-extensions` repository/workflow identity in npm's settings. Use the supported npm CLI, required OIDC permissions, and appropriate protections. Verify that configuration explicitly before promising automatic publication.
