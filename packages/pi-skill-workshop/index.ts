import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { workshopPaths } from "./src/config.ts";
import { ACTIONS, SkillWorkshop, type WorkshopRequest } from "./src/workshop.ts";

const Action = Type.Union(
  ACTIONS.map((action) => Type.Literal(action)),
  { description: "Lifecycle action to perform." },
);

const Parameters = Type.Object({
  action: Action,
  name: Type.Optional(Type.String({
    description: "Skill directory name: 1-63 lowercase letters, digits or hyphens. Required for most actions; for changes, filters the feed.",
  })),
  version: Type.Optional(Type.String({
    description: "Saved version id, for example 20261021T130000Z-a1b2c3. Used by view and restore.",
  })),
  file: Type.Optional(Type.String({
    description: "File to view or patch, relative to the skill. Defaults to SKILL.md. For write_file/remove_file, path is preferred; file is accepted as an alias.",
  })),
  path: Type.Optional(Type.String({
    description: "Support-file path under references/, templates/, scripts/ or assets/. write_file defaults to SKILL.md when omitted; file is accepted as an alias.",
  })),
  content: Type.Optional(Type.String({
    description: "Inline content for create or write_file. Do not combine with content_path.",
  })),
  content_path: Type.Optional(Type.String({
    description: "Path to a file containing content for create or write_file. Do not combine with content.",
  })),
  old: Type.Optional(Type.String({
    description: "Exact text to replace for patch. Must occur once. Do not combine with old_file.",
  })),
  new: Type.Optional(Type.String({
    description: "Replacement text for patch. Do not combine with new_file.",
  })),
  old_file: Type.Optional(Type.String({
    description: "Path to a file containing the exact old text for patch. Do not combine with old.",
  })),
  new_file: Type.Optional(Type.String({
    description: "Path to a file containing replacement text for patch. Do not combine with new.",
  })),
  reason: Type.Optional(Type.String({
    description: "Short reason recorded in the change feed. Recommended for every mutation.",
  })),
  absorbed_into: Type.Optional(Type.String({
    description: "Skill that absorbed this one, for archive.",
  })),
  id: Type.Optional(Type.String({
    description: "12-character change id from changes, for undo.",
  })),
  days: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 3650,
    description: "Idle threshold for cleanup. Defaults to 30 days.",
  })),
  dry_run: Type.Optional(Type.Boolean({
    description: "For cleanup, report what would be archived without changing anything.",
  })),
  force: Type.Optional(Type.Boolean({
    description: "For cleanup, ignore today's once-per-day marker.",
  })),
  archived: Type.Optional(Type.Boolean({
    description: "For list, include archived skill names.",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 500,
    description: "For changes, return at most this many entries, newest first. Defaults to 20.",
  })),
  skill: Type.Optional(Type.String({
    description: "For changes, only show entries for this skill name.",
  })),
});

export default function skillWorkshop(pi: ExtensionAPI) {
  // The factory only registers the tool. No timers, background model calls or
  // filesystem writes happen until a foreground invocation asks for them.
  pi.registerTool({
    name: "skill_workshop",
    label: "Skill workshop",
    executionMode: "sequential",
    description:
      "Manage learned skills under the managed Skill Workshop root. Use list and view before changing anything, create only when no existing skill covers the task class, and review at most one skill per pass. Mutations snapshot the previous tree, validate SKILL.md, refuse symlinks and traversal, and record a reason in the change feed. write_file rewrites SKILL.md or writes a support file under references/, templates/, scripts/ or assets/. cleanup is manual: it runs only when this action is invoked, archives skills idle for 30 days by default, and exempts pinned skills. No background reviewer, timers or automatic cleanup run.",
    promptSnippet: "Inspect, create, patch, archive, restore, or clean up learned skills.",
    promptGuidelines: [
      "Skill Workshop turns durable lessons into skills, so recurring work is not re-derived and corrected mistakes stay corrected. Learned skills are procedures, not facts: facts belong in memoria, and repository conventions belong in that repository's AGENTS.md.",
      "Run a review at the end of substantial multi-step work or when the user explicitly asks to learn or undo. Each review may change at most one skill. Report each change in one line.",
      "Learn only from a correction to a method that will recur, a hard-won procedure likely to be reused, or an existing skill that proved misleading. Never from one-off details, user facts, repository conventions, transient failures, guesses or secrets.",
      "Use skill_workshop for every skill read and write; never edit managed skill files directly. List and view first, patch the skill that covers the task class, and create only when none covers it. Merge duplicates into the survivor and archive the rest.",
      "Keep every skill self-contained: scripts, references, templates and assets live inside the skill directory beside SKILL.md and are referenced by relative path, never by absolute path or from outside the skill.",
      "Do not run cleanup unless the user asks; it archives skills idle for 30 days by default, except pinned skills.",
    ],
    parameters: Parameters,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const paths = workshopPaths();
      return withFileMutationQueue(paths.root, async () => {
        signal?.throwIfAborted();
        const workshop = new SkillWorkshop(paths);
        const text = workshop.execute(params.action, params as WorkshopRequest);
        signal?.throwIfAborted();
        return {
          content: [{ type: "text" as const, text }],
          details: { action: params.action },
        };
      });
    },
  });
}
