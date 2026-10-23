<div align="center">

# @rcsaquino/pi-image

**Text-to-image and image-to-image generation for your existing [Pi](https://github.com/earendil-works/pi) conversation, via the OpenRouter Images API.**

[Getting started](#getting-started) · [Configuration](#configuration) · [Tool](#tool) · [Limits](#limits-and-safety)

</div>

The npm package is `@rcsaquino/pi-image`; the source directory remains `pi-image`. It adds one model tool, `generate_image`, to the active Pi conversation. It does not create a second agent or provider.

## Requirements

- Node.js **22.6+**, as declared by this package; the maintained offline suite is exercised on Node 26.12.0.
- A Node-based Pi host using the `@earendil-works` namespace. The maintained offline baseline is Pi 1.3.0.
- An OpenRouter key, either `OPENROUTER_API_KEY` in a `.env` file or a login stored via Pi `/login` (`openrouter` entry in `<Pi agent directory>/auth.json`).

Pi supplies the declared host peers. There are no runtime dependencies.

## Getting started

From the monorepo root, prepare local dependencies if needed:

```sh
npm --prefix packages/pi-image install --ignore-scripts --legacy-peer-deps --workspaces=false
```

After a release is published, npm installation is `pi install npm:@rcsaquino/pi-image`. Until then, install the reviewed local package:

```sh
pi install /absolute/path/to/pi-extensions/packages/pi-image
```

Run `/reload` in the owning idle Pi session when you intend to activate it. The local checkout remains a reference, not a copied package.

## Configuration

Resolved in this order:

1. `OPENROUTER_API_KEY` in `<working directory>/.env`.
2. `OPENROUTER_API_KEY` in `<agent directory>/.env` (`PI_CODING_AGENT_DIR`, when explicitly set and absolute or `~/`-prefixed; otherwise `~/.pi/agent`).
3. `OPENROUTER_API_KEY` in the process environment.
4. The stored `/login` credential in `<agent directory>/auth.json`, entry `{ "openrouter": { "key": "..." } }`.

`.env` parsing is minimal: `KEY=VALUE` lines, optional `export`, `#` comments, and quoted values. A missing key fails closed: `generate_image` reports that the OpenRouter key is missing. The key never appears in errors, logs, or tool results; provider error messages are not echoed at all.

## Images API note

`pi-ai` `Models.generateImages()` sends image models through `chat/completions` and returns 404 for models such as `openai/gpt-image-2.5-sunburst` with a message to use the `/api/v1/images` endpoint. This extension therefore calls the Images API directly:

- `POST https://openrouter.ai/api/v1/images/generations` with `{ model, prompt, size?, input_references? }`.
- Reference images are sent as `input_references` entries (`{ type: "image_url", image_url: { url: "data:<mime>;base64,..." } }`), per the OpenRouter image-generation docs.
- Responses are read from `data[0].b64_json` (with `media_type` when supplied), falling back to `data[0].url`, which is downloaded without credentials.

The default model is `openai/gpt-image-2.5-sunburst`; any pattern-validated OpenRouter image model id may be passed as `model`. There is no models-listing tool; the OpenRouter dashboard remains the model catalogue.

## Tool

```ts
generate_image({ prompt: "a quiet harbor at dawn" })
generate_image({ prompt: "make it watercolor", inputPaths: ["artifacts/harbor.png"] })
generate_image({ prompt: "a red circle", size: "1024x1024", outputPath: "artifacts/circle.png" })
generate_image({ prompt: "a study in blue", outputPath: "album/" })
```

| Parameter | Required | Bounds |
|---|---|---|
| `prompt` | yes | 1–4000 chars |
| `model` | no | 1–128 chars, `^[A-Za-z0-9][A-Za-z0-9_./-]*$`; default `openai/gpt-image-2.5-sunburst` |
| `inputPaths` | no | max 3 workspace files, 20 MB each and 32 MB total, PNG/JPEG/WebP/GIF |
| `size` | no | `WIDTHxHEIGHT` (256–4096 per side), tier `1K`/`2K`/`4K`, or `auto` |
| `outputPath` | no | workspace-relative file, existing directory, or trailing-slash directory; must stay inside the Pi working directory; default `artifacts/`. An existing file is refused unless `overwrite: true`. |
| `overwrite` | no | replace an existing output file atomically after a complete write; default `false` |

The result is metadata only, never image bytes:

```json
{ "path": "<cwd>/artifacts/image-a-quiet-harbor-20261014-120000.png", "bytes": 12345, "mime": "image/png", "model": "openai/gpt-image-2.5-sunburst", "references": 0 }
```

## Limits and safety

- Prompts are user content and are sent to OpenRouter; generation may spend credits.
- Reference images must already exist inside the Pi working directory (symlink escapes refused); at most 3 files, 20 MB each and 32 MB in total.
- Outputs must stay inside the Pi working directory and default to `<cwd>/artifacts/`. A directory target receives a generated timestamped filename with a random suffix, so two generations in the same second do not collide; file targets keep their normalized name. An existing file is refused unless `overwrite: true`. Writes go to a private temporary file in the destination directory, are fsynced, then linked (new file) or renamed (explicit overwrite) into place, so a failure cannot truncate the previous image. Symlinked output parents and symlinked final files are refused, including a symlinked default `artifacts/` directory. The actual parent is re-resolved after creation and the final open uses `O_NOFOLLOW`.
- Saved bytes are verified as PNG/JPEG magic and must be at least 1 KB before the path is returned.
- Errors are credential-safe: fixed local status text only, never keys, prompt/provider text, raw bodies, or URLs. Provider messages are deliberately not echoed.
- A provider-supplied download URL must be HTTPS on the default port and must resolve only to public addresses; loopback, private, link-local, multicast, and unresolved hosts are refused. Redirects stay disabled, the `Authorization` header is never attached, and the response byte cap still applies.

## Development

From the monorepo root, with development dependencies available:

```sh
npm --prefix packages/pi-image run typecheck
npm --prefix packages/pi-image test
```

`PI_IMAGE_TEST_DIR` selects isolated scratch. Root `npm run verify` supplies shared scratch automatically. Tests use fake fetch transports plus a real Pi loader check; they never use live network, real keys, real sessions, or production cursors. Development/test files are checkout-only and are not included in the published tarball.

Read [AGENTS.md](AGENTS.md) for module boundaries, invariants, and targeted checks. Live generation acceptance requires separate approval and is not implied by offline tests.
