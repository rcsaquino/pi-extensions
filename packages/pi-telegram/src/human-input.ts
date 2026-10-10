import { AsyncLocalStorage } from "node:async_hooks";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { InputEvent } from "@earendil-works/pi-coding-agent";

const TTL = 10 * 60_000;
interface Submission {
  text: string; images: ImageContent[]; sessionId: string; expiresAt: number; valid: () => boolean;
  owner: object; steering: boolean; admitted: boolean; prepared: boolean; running: boolean; consumed: boolean;
  queued: boolean;
}
/** One-use admission plus async run affinity. No marker or recipient enters the transcript.
 * Initial prompts retain their submission scope through before_agent_start, normalization,
 * and agent_start. Queued inputs are consumed in that run's scope, not their own scope;
 * Pi currently queues their original content without normalization.
 */
export class HumanInputScope {
  private scope = new AsyncLocalStorage<Submission>();
  private pending: Submission[] = [];
  private live(current: Submission, sessionId: string): boolean {
    return current.valid() && current.sessionId === sessionId;
  }
  private prune(): void {
    this.pending = this.pending.filter(item => !item.consumed && item.valid() && Date.now() < item.expiresAt);
  }
  matches(event: InputEvent, sessionId: string): boolean {
    const current = this.scope.getStore();
    const images = event.images || [];
    return Boolean(current && this.live(current, sessionId) && Date.now() < current.expiresAt &&
      event.source === "extension" && event.text === current.text && images.length === current.images.length &&
      images.every((image, index) => image === current.images[index]));
  }
  admit(event: InputEvent, sessionId: string, owner: object): boolean {
    const current = this.scope.getStore();
    if (!current || current.owner !== owner || current.admitted || !this.matches(event, sessionId)) return false;
    current.admitted = true;
    current.queued = Boolean(event.streamingBehavior);
    return true;
  }
  prepare(text: string, images: ImageContent[] | undefined, sessionId: string, owner: object): boolean {
    const current = this.scope.getStore();
    if (!current || current.owner !== owner || !current.admitted || current.consumed || current.prepared ||
      !this.matches({ type: "input", source: "extension", text, images }, sessionId)) return false;
    current.prepared = true;
    return true;
  }
  startRun(sessionId: string): void {
    const current = this.scope.getStore();
    if (current?.prepared && !current.consumed && this.live(current, sessionId)) current.running = true;
  }
  consume(content: unknown, sessionId: string, owner: object): { steering: boolean; text: string } | undefined {
    this.prune();
    const run = this.scope.getStore();
    if (!run || run.owner !== owner || !this.live(run, sessionId) || !run.running) return;
    // The host creates the first user message only after its trusted normalization.
    // Its text/images may change or be omitted. Authority is admission + this run,
    // not a permissive suffix matcher. This window can be consumed only once.
    let current = !run.consumed && run.admitted && run.prepared && this.pending.includes(run) ? run : undefined;
    if (!current && run.consumed) {
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter(block => block?.type === "text").map(block => block.text).join("\n") : "";
      const images = Array.isArray(content) ? content.filter(block => block?.type === "image") : [];
      current = this.pending.find(item => item.owner === owner && item.admitted && item.queued && this.live(item, sessionId) &&
        item.text === text && images.length === item.images.length && images.every((image, index) => image === item.images[index]));
    }
    if (!current) return;
    current.consumed = true;
    this.prune();
    return { steering: current.steering, text: current.text };
  }
  hasPending(owner: object): boolean { this.prune(); return this.pending.some(item => item.owner === owner); }
  hasPrompt(owner: object, text: string): boolean { this.prune(); return this.pending.some(item => item.owner === owner && item.text === text); }
  send(text: string, sessionId: string, valid: () => boolean, send: () => void,
    delivery?: { images: ImageContent[]; owner: object; steering: boolean }): void {
    const { images = [], owner = {}, steering = false } = delivery || {};
    this.prune();
    if (this.pending.length >= 128) throw new Error("Telegram input admission queue is full.");
    const current: Submission = { text, images, sessionId, owner, steering, valid, expiresAt: Date.now() + TTL,
      admitted: false, prepared: false, running: false, consumed: false, queued: false };
    this.pending.push(current);
    this.scope.run(current, send);
  }
  close(): void { this.pending = []; }
}
