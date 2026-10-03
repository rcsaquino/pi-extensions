import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";

const TTL = 10 * 60_000;
interface Submission { text: string; sessionId: string; expiresAt: number; valid: () => boolean; claimed: boolean }
/** Private, synchronous bus query. No marker, chat ID, or credential enters the transcript.
 * Async scope binds the claim to this sendUserMessage call, even across slow input hooks.
 * The receiver must also witness the corresponding user message being consumed.
 */
export class HumanInputScope {
  private scope = new AsyncLocalStorage<Submission>();
  private off: () => void;
  constructor(pi: ExtensionAPI) {
    this.off = pi.events.on("pi-telegram:claim-human-input:v1", data => {
      const query = data as { event?: InputEvent; sessionId?: string; accept?: (receipt: unknown) => void };
      const current = this.scope.getStore();
      if (!current || current.claimed || !current.valid() || Date.now() > current.expiresAt ||
        query.sessionId !== current.sessionId || query.event?.source !== "extension" ||
        query.event.text !== current.text || typeof query.accept !== "function") return;
      current.claimed = true;
      query.accept({ id: randomUUID(), expiresAt: current.expiresAt, valid: current.valid });
    });
  }
  matches(event: InputEvent, sessionId: string): boolean {
    const current = this.scope.getStore();
    return Boolean(current && current.valid() && Date.now() < current.expiresAt &&
      current.sessionId === sessionId && event.source === "extension" && event.text === current.text);
  }
  send(text: string, sessionId: string, valid: () => boolean, send: () => void): void {
    this.scope.run({ text, sessionId, expiresAt: Date.now() + TTL, valid, claimed: false }, send);
  }
  close(): void { this.off(); }
}
