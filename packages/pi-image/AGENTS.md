# Working on @rcsaquino/pi-image

Read this with [the monorepo instructions](https://github.com/rcsaquino/pi-extensions/blob/main/AGENTS.md) and [README.md](README.md). The npm scope does not rename the source directory or the tool. This package adds image generation to the existing Pi conversation; it does not create a second agent or provider.

## Architecture

- `index.ts`: distributable entry point; registers `generate_image` only.
- `src/auth.ts`: `.env`/environment key resolution (`.env` first, then process environment), stored OpenRouter login (`openrouter` entry in `<agent-dir>/auth.json`) as fallback, Images endpoint and default model constants.
- `src/errors.ts`: credential-safe `SafeError`, `safeError`, and `redactKey`.
- `src/validate.ts`: prompt/model/size bounds, workspace-contained reference reads, workspace-contained output resolution.
- `src/client.ts`: direct `POST /api/v1/images/generations` calls with an injectable fetch transport, capped bodies, `input_references` encoding, `b64_json`/`url` handling, and redacted status errors.
- `src/files.ts`: PNG/JPEG magic detection, lowercase-hyphenated filenames, verified saves.
- `tests/`: fake-transport regression tests and an isolated real Pi loader/SDK check.

## Setup and commands

From the monorepo root, install local development dependencies only when needed:

```sh
npm --prefix packages/pi-image install --ignore-scripts --legacy-peer-deps --workspaces=false
npm --prefix packages/pi-image run typecheck
npm --prefix packages/pi-image test
```

The package has no `verify` script; root `npm run verify` combines its typecheck/test commands. Use Node compatible with the package engine. Set `PI_IMAGE_TEST_DIR` to approved isolated scratch when running tests directly. Keep real keys, `auth.json` contents, and generated images out of tests, output, and model context.

## Non-negotiable behavior

- Resolve credentials in this order: `OPENROUTER_API_KEY` in `<cwd>/.env`, then `<agent-dir>/.env`, then `process.env.OPENROUTER_API_KEY`, then the stored `/login` credential in `<agent-dir>/auth.json`. No key logging. Missing credentials fail closed with a hint covering both `.env` and `/login`.
- Call the Images API directly (`POST /api/v1/images/generations`). Never route image models through `pi-ai` chat/completions; that path 404s with a message to use `/api/v1/images`.
- Keep `generate_image` the only tool. No models-listing tool, no captions concept, no participation in tool-calling loops beyond this tool.
- Validate everything twice: schema bounds plus code validation. Prompt 1–4000 chars; at most 3 reference images at 20 MB each; output always inside the working directory.
- Resolve reference and output paths against the tool-call `ctx.cwd` with realpath containment (refuse `..` and symlink escapes). Downloads default to `<cwd>/artifacts/`.
- Verify PNG/JPEG magic and a minimum byte size before returning a path. Return metadata only, never image bytes.
- Fetch provider `url` results without the `Authorization` header.
- Errors contain statuses plus a short redacted provider message only. Never keys, raw bodies, request URLs, or prompt echoes.

## Testing and review

Add regression cases in the corresponding suite:

- `generate.test.ts`: txt2img request shape, `input_references` encoding, `url` fallback, credential precedence and auth-missing closed failure, prompt/model/size/reference/output bounds, PNG/JPEG verification, redaction, and response caps.
- `sdk.test.ts`: actual loader registration of `generate_image` with no commands, plus the full offline tool flow through fake fetch with an isolated agent dir.

Mocks must inspect the intended API payload (URL, method, auth, body fields), not merely assert a fabricated success. Use fake fetch transports and isolated temp dirs; live network, real keys, real sessions, and production cursors are never test fixtures.

## Deployment boundary

Pi loads TypeScript directly; there is no compile output to deploy. Retain the package's relative `src/` layout and keep host Pi packages as peers. Do not patch Pi core or another extension to make this package pass.

A source change does not register, enable, reload, or restart anything. Registration, reload, and any live generation check require separate authorization. Do not commit, push, release, publish, or change credentials without explicit approval.
