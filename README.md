<div align="center">

# pi-extensions

**Independent extensions for [Pi](https://github.com/earendil-works/pi): memory, Telegram, skill learning, idle compaction, latency analytics, and background work.**

[![Node.js](https://img.shields.io/badge/full%20suite-Node.js%2026.10%2B-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Packages](#packages) · [Installation](#installation) · [Development](#development) · [Safety](#safety-and-runtime-data) · [Support](#support-and-contact)

</div>

One repository, six separately versioned Pi packages. Install only the extensions you need. The root is a private npm development workspace, not an all-in-one Pi extension or a published npm package.

## Packages

- **[pi-memoria](packages/pi-memoria/README.md)**: global startup rules, SQLite fact recall, and cited search across past conversations.
- **[@rcsaquino/pi-telegram](packages/pi-telegram/README.md)**: Telegram transport for the existing Pi conversation, with attachments, steering, and explicitly requested voice replies.
- **[pi-auto-learn](packages/pi-auto-learn/README.md)**: background creation, improvement, and recoverable retirement of skills inside one managed directory.
- **[pi-idle-compaction](packages/pi-idle-compaction/README.md)**: native compaction after an eligible idle period, with conservative background-work checks.
- **[pi-latency-analytics](packages/pi-latency-analytics/README.md)**: local, metadata-only traces of time spent inside Pi.
- **[@rcsaquino/pi-background-tasks](packages/pi-background-tasks/README.md)**: non-blocking same-model workers with compact task briefs and realistic duration estimates.

Each package owns its manifest, entry point, runtime dependencies, tests, README, and agent instructions. Versions and release readiness are independent; inclusion here does not imply npm publication or production activation.

## Requirements

For all packages and the complete test suite:

- **Node.js 26.10.x or newer within the 26.x line**: required by the current idle-compaction manifest. Other packages have lower minimums.
- A Node-based **Pi** installation using the `@earendil-works` packages. The combined suite has been exercised with Pi 1.0.0; see each package's declared peer range and compatibility notes.
- **npm** for development tooling.
- **ripgrep (`rg`)** for memoria session search and its tests.
- On Linux, util-linux-compatible **`flock --no-fork`** for Telegram ownership. **ffmpeg** is needed for long speech assembly and the corresponding offline tests.

> [!NOTE]
> Package peer ranges are not uniform. Some manifests retain 0.x development baselines even though this checkout passes offline checks on Pi 1.0.0. Read the package requirements before installing; a successful combined test run is not proof of every matching runtime or platform.

## Installation

Package folders retain their unscoped names; the two scoped npm names distinguish these implementations from unrelated public packages. After the corresponding release is published, npm installation uses its manifest name, for example `pi install npm:@rcsaquino/pi-telegram`. Prepared source is not a claim of an existing npm release.

From a reviewed local checkout, install a specific package:

```sh
pi install ./packages/pi-telegram
```

Or use a stable absolute path:

```sh
pi install /absolute/path/to/pi-extensions/packages/pi-background-tasks
```

Pi keeps local packages as references. Leave the checkout in place. Use `pi list` to inspect configured package declarations, then `/reload` in an idle Pi session when you intend to activate a change. Removing a package uses its installed source, for example:

```sh
pi remove /absolute/path/to/pi-extensions/packages/pi-background-tasks
```

Removal does not erase that extension's runtime data.

> [!IMPORTANT]
> Do not install the repository root expecting all six extensions to load. Do not register a package and a copied extension-directory entry for the same implementation. Cloning or editing files is not activation, and a service restart needs separate approval.

## Development

The shared scripts run package-local commands; they do not require dependency hoisting. Follow the package README for setup. For example, to install Telegram's development dependencies without installing every workspace:

```sh
npm --prefix packages/pi-telegram install --ignore-scripts --legacy-peer-deps --workspaces=false
```

Use the same pattern with another package directory. This checkout does not commit package lockfiles; package-local `npm ci` is appropriate only when a usable lockfile has deliberately been supplied. Do not replace or consolidate the existing dependency trees merely to make the root workspace uniform.

For development against an already installed Pi host:

```sh
npm run link-host
```

This helper links missing host peers and repairs dangling symlinks or a missing compiler bin link. It preserves working dependencies, does not install runtime packages, and does not rewrite lockfiles. Set `PI_HOST_PACKAGE_DIR` to the coding-agent package directory for a nonstandard installation. A working but incompatible physical peer is not automatically replaced.

Run checks from the repository root:

```sh
npm run check
npm test
npm run verify
```

The runner invokes each package's `check` or `typecheck` and `test` scripts sequentially. Root checks also run `npm run check:publication`, an offline regression suite for names, release metadata, distributable files, and documentation links. It sets `PI_OFFLINE=1`, `TMPDIR`, `PI_BACKGROUND_TEST_ROOT`, and `TELEGRAM_TEST_DIR` for isolated tests. Shared scratch defaults to ignored `temp_files/tests/`; override it with `PI_EXTENSIONS_TEST_ROOT`.

To focus on one package:

```sh
npm --prefix packages/pi-background-tasks run verify
npm --prefix packages/pi-telegram run typecheck
npm --prefix packages/pi-telegram test
```

There is no common compile step: Pi loads package TypeScript entry points directly. The root scripts are verification tooling, not production services.

## Release preparation

See [RELEASING.md](RELEASING.md) for independent package versions, npm names, dry-run checks, and the manual publication process. The root remains private. This checkout has no automatic CI or publication workflow; Git initialization, pushes, tags, GitHub releases, and npm publication are separate operator actions.

## Safety and runtime data

Extensions execute with Pi's OS permissions. They are not sandboxes, and in-process background work does not create a new security boundary.

- Keep credentials, real memory, conversation archives, analytics databases, Telegram downloads/cursors/locks, and learning state outside source control.
- Keep tests isolated from live providers, Telegram pollers, the real managed skill library, and global agent settings.
- Directory-scoped learning affects only its configured managed root. Put skills that must remain manually maintained outside that root.
- Background tasks incur normal model/tool usage and stop when their host exits. Idle compaction can incur a native summarization request when it runs.
- Optional background coordination covers reviewed integrations, not every OS process or remote job.
- Never delete an unknown active lock, automatically replay uncertain work, or describe an offline check as live acceptance.

On the maintained deployment, old workspace source names remain compatibility symlinks into `packages/`. Existing registrations and deployed copies were preserved during migration. Review dependent settings, lazy imports, and helper scripts before removing those aliases. Local history archives and private migration reports are not part of the shareable source tree.

See [AGENTS.md](AGENTS.md) for the repository's development and verification rules.

## Support and contact

If these extensions are useful to you, you can support their development on
[Ko-fi](https://ko-fi.com/rcsaquino).

<a href='https://ko-fi.com/rcsaquino' target='_blank'><img height='72' style='border:0px;height:72px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
