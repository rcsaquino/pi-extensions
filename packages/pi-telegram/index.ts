import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { readDeliveryLedger } from "./src/delivery-ledger.ts";
import { TelegramBridge } from "./src/bridge.ts";
import { DeliveryRefusal, loadConfig, safeError, SafeError } from "./src/config.ts";
import { telegramPromptGuidelines } from "./src/prompt-guidelines.ts";

export default function telegram(pi: ExtensionAPI): void {
  let bridge: TelegramBridge | undefined;
  let connecting: Promise<void> | undefined;
  const disconnected = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-telegram", ctx.ui.theme.fg("warning", "Telegram ○ disconnected"));
  };
  const connect = async (ctx: ExtensionContext) => {
    if (connecting) return connecting;
    if (bridge?.ownsConnection) return;
    connecting = (async () => {
      await bridge?.stop();
      bridge = undefined;
      try {
        bridge = new TelegramBridge(pi, ctx, await loadConfig(ctx.cwd));
        await bridge.start();
      } catch (error) {
        disconnected(ctx);
        if (ctx.hasUI) ctx.ui.notify(safeError(error), "warning");
      }
    })().finally(() => { connecting = undefined; });
    return connecting;
  };

  pi.registerFlag("telegram-off", { description: "Do not auto-connect pi-telegram", type: "boolean", default: false });
  pi.on("session_start", async (_event, ctx) => {
    if (!bridge?.ownsConnection) disconnected(ctx);
    if (!pi.getFlag("telegram-off") && ctx.mode !== "print" && ctx.mode !== "json") await connect(ctx);
  });
  pi.on("session_shutdown", async () => {
    await connecting;
    await bridge?.stop();
    bridge = undefined;
  });
  pi.on("session_before_switch", () => bridge?.invalidate());
  pi.on("session_before_fork", () => bridge?.invalidate());
  pi.on("session_before_tree", () => bridge?.invalidate());
  pi.on("before_agent_start", event => {
    if (!bridge?.ownsConnection) return;
    const telegram = event.messageType === "user" && Boolean(bridge.beforeStart(event.prompt, event.images));
    event.systemPromptOptions.promptGuidelines.push(...telegramPromptGuidelines(telegram));
  });
  pi.on("input", event => bridge?.input(event));
  pi.on("agent_start", () => bridge?.agentStart());
  pi.on("message_start", event => bridge?.userStart(event.message));
  pi.on("message_end", event => bridge?.assistantEnd(event.message));
  pi.on("agent_before_settle", event => { bridge?.boundary(event.outcome); });
  pi.on("agent_settled", async () => { await bridge?.settled(); });

  // No Pi/TUI slash commands and no Telegram transport slash-command handlers.
  pi.registerTool({
    name: "telegram_delivery_status", label: "Telegram delivery diagnostics", exposure: "codemode",
    description: "Read bounded credential-safe local delivery phases, optionally filtered by an opaque task/reply/notice/delivery ID. No network, replay, maintenance or alerts. API acknowledgment is not phone receipt. Missing records never prove non-delivery; this is a best-effort seven-day ring, not a complete audit.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      task: Type.Optional(Type.String({ pattern: "^bg-[a-f0-9]{12}$" })),
      reply: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$" })),
      notice: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$" })),
      delivery: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const view = await readDeliveryLedger(bridge?.ledger.path || resolve(getAgentDir(), "pi-telegram", "diagnostics"), { ...params, limit: params.limit || 20 });
      const details = { ...view, processDropped: bridge?.ledger.dropped ?? null, processPending: bridge?.ledger.pendingWrites ?? null };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: "telegram_send",
    label: "Send to Telegram",
    description: "Send an attachment, one album, or voice to the allowed Telegram user whose request or dispatch-linked background report is active. Provide exactly one of path, paths (1–10 compatible files), or speech. Files must be inside the working directory or Telegram downloads, including symlink targets. No captions. Speech uses the exact configured ElevenLabs voice/model and native OGG/Opus; use appropriate Eleven v4 square-bracket audio tags sparingly. Send voice only when the user explicitly requests it, never merely because their input was voice. Voice is the complete reply, with no chat afterward. Ordinary final text is delivered automatically. Never send credentials.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1, description: "One local attachment path" })),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10, description: "Send compatible attachments together in one Telegram album" })),
      kind: Type.Optional(Type.Union([Type.Literal("document"), Type.Literal("photo"), Type.Literal("video"), Type.Literal("voice")])),
      speech: Type.Optional(Type.String({ minLength: 1, description: "Spoken script with appropriate Eleven v4 tags, for example [warm, composed voice] Hello, sir. Voice only; no chat afterward." })),
    }),
    async execute(_id, params, signal) {
      try {
        if (!bridge) throw new DeliveryRefusal("TG_BRIDGE_STOPPED", { running: false, connected: false, context: "none", started: false, settling: false, cancelled: false, owned: false });
        await bridge.send(params, signal);
        const voice = Boolean(params.speech) || params.kind === "voice";
        return { content: [{ type: "text", text: voice ? "Delivered to Telegram. Voice replies are complete; no chat is needed." : "Delivered to Telegram." }], details: { sent: true },
          ...(voice ? { terminate: true } : {}) };
      } catch (error) { if (error instanceof SafeError) throw error; throw new SafeError(safeError(error)); }
    },
  });
}
