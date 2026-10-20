import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir, readOpenRouterKey } from "./src/auth.ts";
import { generateImageBytes } from "./src/client.ts";
import { safeError } from "./src/errors.ts";
import { saveImage } from "./src/files.ts";
import { readReferenceImages, resolveOutputPath, validateModel, validatePrompt, validateSize } from "./src/validate.ts";

export default function piImage(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description: "Generate an image from a text prompt via the OpenRouter Images API (POST /api/v1/images/generations) using OPENROUTER_API_KEY from .env or the stored OpenRouter login. Optional inputPaths reference existing workspace images for image-to-image. Saves a verified PNG/JPEG under the Pi working directory (default artifacts/) and returns the saved path plus metadata only, never image bytes. Generation may spend OpenRouter credits.",
    promptGuidelines: ["When the user asks for an image, generate it with generate_image and report the saved file path. Image bytes never belong in chat text."],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 4000, description: "Text description of the desired image" }),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "OpenRouter image model id; defaults to openai/gpt-image-2.5-sunburst" })),
      inputPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 3, description: "Workspace-relative reference images (max 3, 20 MB each) for image-to-image" })),
      size: Type.Optional(Type.String({ description: "Output size like 1024x1024, a tier (1K, 2K, 4K), or auto" })),
      outputPath: Type.Optional(Type.String({ minLength: 1, description: "Workspace-relative output file or directory; defaults to artifacts/" })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const prompt = validatePrompt(params.prompt);
        const model = validateModel(params.model);
        const size = validateSize(params.size);
        const cwd = ctx.cwd;
        const references = await readReferenceImages(cwd, params.inputPaths);
        const output = await resolveOutputPath(cwd, params.outputPath);
        const key = await readOpenRouterKey(agentDir(), cwd);
        const generated = await generateImageBytes({ key, model, prompt, size, references, signal });
        const saved = await saveImage(output.directory, generated.data, prompt, output.filename);
        const summary = { path: saved.path, bytes: saved.bytes, mime: saved.mime, model, ...(size ? { size } : {}), references: references.length };
        return { content: [{ type: "text", text: JSON.stringify(summary) }], details: summary };
      } catch (error) {
        throw new Error(safeError(error));
      }
    },
  });
}
