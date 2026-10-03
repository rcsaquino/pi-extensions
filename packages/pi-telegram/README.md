<div align="center">

# @rcsaquino/pi-telegram

**Telegram messages, attachments, and explicit voice replies for your existing [Pi](https://github.com/earendil-works/pi) conversation.**

[Getting started](#getting-started) · [Configuration](#configuration) · [Messages](#message-behavior) · [Media and voice](#media-and-voice) · [Support](#support-and-contact)

</div>

The npm package is `@rcsaquino/pi-telegram`; the source directory and runtime paths remain `pi-telegram`. It is distinct from the unrelated unscoped npm package.

A transport, not a second agent. It uses the active Pi model and conversation, forwards only the settled final answer, and adds one model-facing tool: `telegram_send`. There is no webhook, streaming renderer, Telegram command menu, transport slash command, or extra formatting/enhancement LLM.

## Requirements

- Node.js **22.6+**, as declared by this package; the maintained offline suite uses Node 26.10.0 and Pi 1.0.0.
- A Node-based Pi host using the `@earendil-works` namespace.
- On Linux, util-linux-compatible **`flock --no-fork`** for exclusive bot ownership.
- **ffmpeg** only for assembling long generated speech, and for the corresponding offline tests.
- A Telegram bot token and explicit private-user allowlist. Optional Groq and ElevenLabs credentials enable speech features.

`marked` is the runtime dependency for local Markdown parsing. Pi supplies the declared host peers.

## Getting started

From the monorepo root, prepare local dependencies if needed:

```sh
npm --prefix packages/pi-telegram install --ignore-scripts --legacy-peer-deps --workspaces=false
```

Configure the private environment described below. After a release is published, npm installation is `pi install npm:@rcsaquino/pi-telegram`. Until then, install the reviewed local package:

```sh
pi install /absolute/path/to/pi-extensions/packages/pi-telegram
```

Run `/reload` in the owning idle Pi session when you intend to activate it. The local checkout remains a reference, not a copied package. Do not enable this alongside another consumer of the same bot or start a competing live poller as a test.

The extension connects on `session_start` in TUI/RPC mode. Print/JSON invocations do not auto-connect. `--telegram-off` disables automatic connection for that invocation. Removal uses `pi remove <installed-source>`; runtime data is retained.

## Configuration

Only known fields are read. Configuration uses the first existing file:

1. `TELEGRAM_ENV_FILE`, when explicitly set; a missing explicit file is an error.
2. Otherwise `<Pi working directory>/.env`.
3. Otherwise `<Pi agent directory>/.env`.

File values override inherited environment values, including explicitly empty values. Missing fields can come from the process environment. The generated `pi-telegram/` data directory is never searched for credentials.

```dotenv
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_ID=123456789
GROQ_API_KEY=your-optional-groq-key
ELEVENLABS_API_KEY=your-optional-elevenlabs-key
ELEVENLABS_VOICE_ID=your-selected-voice
ELEVENLABS_MODEL_ID=eleven_v4
```

[.env.example](.env.example) contains empty placeholders for these fields. Copy it to a private configuration path and fill it in locally; do not overwrite an existing environment file.

Keep real values private and out of the repository. On Unix, protect configuration with mode `0600`. Do not overwrite another extension's existing environment file to configure this one.

`TELEGRAM_ALLOWED_ID` accepts one positive numeric user ID, delimited IDs, or a JSON array. Empty values, wildcards, malformed IDs, groups, and bot senders are rejected. Authentication happens before downloading, transcribing, typing, or dispatching a request.

- Telegram token and allowlist: required for chat.
- Groq key: required only for incoming voice/audio transcription.
- ElevenLabs key, voice, and model: required only for synthesized replies. The exact configured voice/model is retained; it is never silently downgraded.

## Message behavior

Incoming text receives one leading `[ISO_8601]` timestamp representing Telegram's original instant in the host timezone. There is no user-ID label or trailing timestamp. Attachments appear in one `[Attachment/s]` path list; images also enter Pi as native image blocks. Voice/audio is transcribed under `[Transcription]`.

Albums are scoped to their originating private chat and collected until one second of quiet. Their paths, native images, and nonduplicate captions become one Pi request. A fragment arriving after dispatch cannot be retroactively added; unrelated messages are not merged.

During a Telegram run, the same chat's corrections use Pi **steering** at the next assistant/tool boundary. Prepared messages retain order; albums keep their debounce. Consumed corrections replace the earlier final. Other chats stay FIFO queued and cannot capture the active chat's reply target. Initial requests during local TUI work wait for idle.

> [!IMPORTANT]
> Allowlisted users and the local TUI share one Pi conversation. This is not isolated multi-user hosting. The input buffer and pending work are not a durable job queue.

When `pi-background-tasks` is loaded, accepted dispatch during an authenticated Telegram request captures that task's originating session/private chat in an ephemeral capability. Completion, ETA and overdue notices wait until Pi is idle with no pending messages or human request; the main agent then owns a separate task-linked report turn, including `telegram_send` attachments. Another chat or local TUI/RPC request cannot take its target. There is no last-chat fallback or broad forwarding of unrelated assistant finals. Navigation, shutdown/reload and session replacement revoke routing; routes expire after seven days and are not restored after process exit. Retrieve saved status/results explicitly if a revoked or ambiguous notice was not delivered. Workers still cannot send Telegram messages.

Authenticated incoming submissions also expose a one-use, async-scoped receipt to `pi-auto-learn` when present. This does not change Pi's `extension` input source, enable guests, or add a transcript marker. Generic extension input remains unauthenticated; executable extensions themselves are trusted peers.

Only the final answer after `agent_settled` is forwarded. Thinking, intermediate commentary, tool results, retry output, and streaming deltas are not delivered. Markdown becomes plain text plus native Telegram entities, not raw Markdown or `parse_mode`. Formatting handles UTF-16 offsets, emoji-safe splitting, non-overlapping code entities, and Telegram's 4,096-unit text limit. Tables become labeled rows; raw HTML stays literal.

## Media and voice

Model-facing examples:

```ts
telegram_send({ path: "artifacts/report.pdf" })
telegram_send({ paths: ["artifacts/one.png", "artifacts/two.png"] })
telegram_send({ paths: ["artifacts/a.txt", "artifacts/b.txt"], kind: "document" })
telegram_send({ speech: "[warm, composed voice] Here is the spoken answer. [pause]" })
```

Provide exactly one of `path`, `paths`, or `speech`. Files and resolved symlink targets must stay inside the Pi working directory or this transport's downloads directory. Secret paths and files containing configured credentials are rejected. These checks do not sandbox other tools.

- One file is selected as photo, video, voice, or document by supported type/size; use `kind: "document"` to retain original image bytes.
- Two to ten compatible files use one captionless Telegram album. Photos/videos may mix; documents group only with documents. Voice notes cannot be grouped.
- Captions are never added, including filenames. A file-only response can finish with an empty final. Any explanation belongs in separate final chat text.
- Downloads are limited to 20 MB. Photos are limited to 10 MB; document/video/voice uploads to 50 MB.

Incoming voice is **not** permission to reply with speech. Groq receives supported audio using `whisper-large-v3-turbo`; OGG/Opus `.oga` uploads are renamed to `.ogg` without changing bytes. Unsupported or empty audio fails safely.

Speech requires an **explicit request** and is the complete reply: no later acknowledgment or unsolicited transcript. Eleven v4 uses intentional, sparse square-bracket tags, no SSML or unsupported speed/style controls. A restrained opening tag is supplied when a configured v4 script has none. Existing tags are preserved.

ElevenLabs returns native `opus_48000_64`; OGG/Opus headers are validated. Long scripts are chunked without splitting tags/emoji and combined with ffmpeg into one voice note. Scratch is removed in `finally`. There is no separate enhancement model call.

## Storage, ownership, and privacy

`PI_CODING_AGENT_DIR` chooses the stable agent directory, normally `~/.pi/agent`. Runtime storage is independent of the working directory:

```text
<agent-dir>/pi-telegram/
├── downloads/<bot-hash>/
├── state/<bot-hash>/cursor.json
├── locks/
└── tmp/
```

Directories use `0700`; downloads and cursors use `0600` on Unix. Downloads persist until removed. The cursor is persistent polling state, not disposable scratch.

A kernel-backed lease is acquired before any Telegram API call. The first instance retains ownership, including during transient backoff; losing instances make no API calls or take over. Fatal failures and shutdown drain resources before release. Bot identity survives ordinary token rotation. Active webhooks are not deleted.

Never remove an ownership lock inode while an instance could use it. Empty lock files do not prove ownership. Instances must share the agent directory and compatible ownership implementation; other hosts/directories and legacy bridges remain subject to Telegram conflict rules.

Telegram chats are not end-to-end encrypted. Incoming audio goes to Groq and speech scripts go to ElevenLabs; provider charges and retention policies apply. Error messages redact configured secrets and never expose authenticated URLs or raw provider responses. An ambiguous outgoing network failure is not blindly retried; explicit rate-limit rejections receive bounded retries.

## Development

From the monorepo root, with development dependencies available:

```sh
npm --prefix packages/pi-telegram run typecheck
npm --prefix packages/pi-telegram test
```

`TELEGRAM_TEST_DIR` selects isolated scratch. Root `npm run verify` supplies this automatically. Tests use fake HTTP/providers plus real Pi loader/SDK checks (including the optional three-package integration), private fixtures, and local synthetic audio. They never require a second live poller or paid speech synthesis.

Read [AGENTS.md](AGENTS.md) for module boundaries, invariants, and targeted checks. Live Telegram/STT/TTS acceptance requires separate approval and is not implied by offline tests.

## Support and contact

If pi-telegram is useful to you, you can support its development on
[Ko-fi](https://ko-fi.com/rcsaquino).

<a href='https://ko-fi.com/rcsaquino' target='_blank'><img height='72' style='border:0px;height:72px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
