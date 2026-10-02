# Working on @rcsaquino/pi-telegram

Read this with [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). The npm scope does not rename the source directory, transport home, ownership locks, cursors, or tool. This package transports an existing Pi conversation; it does not create a second agent or provider.

## Architecture

- `index.ts`: distributable entry point.
- `src/bridge.ts`: lifecycle, polling, FIFO reply ownership, steering, final delivery, and `telegram_send`.
- `src/config.ts`: known-field environment loading, allowlist, safe errors, redaction, and input timestamps.
- `src/api.ts`: Telegram requests, downloads/uploads, and audio upload identification.
- `src/connection-lease.ts`: local kernel-backed bot ownership.
- `src/format.ts`: Markdown to native entities and safe text splitting.
- `src/voice.ts`: Groq transcription, exact ElevenLabs voice/model, audio tags, chunking, and Opus assembly.
- `tests/`: fake-transport regression tests and isolated real Pi loader/SDK checks.

## Setup and commands

From the monorepo root, install local development dependencies only when needed:

```sh
npm --prefix packages/pi-telegram install --ignore-scripts --legacy-peer-deps --workspaces=false
npm --prefix packages/pi-telegram run typecheck
npm --prefix packages/pi-telegram test
```

The package has no `verify` script; root `npm run verify` combines its typecheck/test commands. Use Node compatible with the package engine, Linux `flock --no-fork`, and ffmpeg for synthetic long-speech tests. Set `TELEGRAM_TEST_DIR` to approved isolated scratch when running tests directly. Keep real `.env` values out of tests, output, and model context.

## Non-negotiable behavior

- Authenticate private human-user messages before downloads, STT, typing, or agent dispatch. Invalid or missing allowlists fail closed.
- Acquire ownership before every startup API sequence. No losing-instance polling, webhook deletion, lock-inode replacement, or automatic takeover. Drain resources before releasing ownership.
- Keep state/downloads/locks under the stable agent-relative transport home. The polling cursor is persistent state, never cache.
- Use the first configured environment file with file-over-process precedence, including empty values. Never search the generated-data home for configuration or mutate the parent environment with credentials.
- Forward only the settled final, never thinking, tools, intermediate commentary, retry output, or partial streaming text.
- Keep replies pinned to the request's originating chat. Same-chat steering may supersede a consumed prior final; another chat cannot steer or capture it. Preserve album debounce, order, preparation cancellation, and exactly-once prepared-input dispatch within a run.
- Incoming voice/audio defaults to text. Only an explicit voice request authorizes speech; a voice reply has no follow-up acknowledgment/transcript.
- Never add captions. A compatible multi-file request is one album; invalid combinations fail before sending. Intentional silence and attachment-only empty finals are valid.
- Retain exact configured ElevenLabs voice/model and native OGG/Opus. Do not silently downgrade, transcode valid `.oga` inputs unnecessarily, or add enhancement model calls.
- Preserve secret-path/content checks, resolved-target boundaries, bounded media/text sizes, UTF-16 entity offsets, and emoji/tag-safe splitting.
- Never return raw provider response bodies, authenticated URLs, exception details, or configured secret values. Do not retry an ambiguous outgoing send as though it certainly failed.

## Testing and review

Add regression cases in the corresponding suite:

- `bridge.test.ts`: ordering, steering, albums, ownership/lifecycle, final/voice-only delivery.
- `connection-lease.test.ts`: cross-process ownership, cancellation, crashes, and no takeover.
- `core.test.ts`: config, authentication, redaction, media boundaries, transcription, and synthesis contracts.
- `format-voice.test.ts`: native entities, chunking, formats, tags, and long-audio assembly.
- `sdk.test.ts`: actual loader registration and synthetic end-to-end Pi behavior.

Mocks must inspect the intended API payload/ordering, not merely assert a fabricated success. Test resource shutdown, reload/session replacement, late network completion, and ambiguous send failures when changing asynchronous paths. Use synthetic audio and fake provider transports; live polls or paid STT/TTS calls are separate operator-approved checks.

## Deployment boundary

Pi loads TypeScript directly; there is no compile output to deploy. Retain the package's declared runtime dependency and relative `src/` layout. Do not patch Pi core or another Telegram bridge to make this package pass.

A source rewrite does not update the owning live runtime. Registration, reload/restart, migration of cursors, and lock-location changes require separate authorization. Preserve active lock inodes and historical download paths during an approved transition. Never start a second real poller as a deployment probe. Do not commit, push, release, publish, or change credentials without explicit approval.
