import { AsyncLocalStorage } from "node:async_hooks";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { InputEvent } from "@earendil-works/pi-coding-agent";

const TTL = 10 * 60_000;
interface Submission {
  text: string; images: ImageContent[]; sessionId: string; expiresAt: number; valid: () => boolean;
  owner: object; steering: boolean; admitted: boolean; prepared: boolean; running: boolean; consumed: boolean;
  queued: boolean; detached: boolean;
}
/** One-use admission plus async run affinity. No marker or recipient enters the transcript.
 * Initial prompts retain their submission scope through before_agent_start, normalization,
 * and agent_start. Queued inputs are consumed in that run's scope, not their own scope;
 * Pi currently queues their original content without normalization.
 */
export class HumanInputScope {
  private scope = new AsyncLocalStorage<Submission>();
  private pending: Submission[] = [];
  private detachedOwners = new WeakSet<object>();
  private live(current: Submission, sessionId: string): boolean {
    return current.valid() && current.sessionId === sessionId;
  }
  private prune(): void {
    this.pending = this.pending.filter(item => !item.consumed && item.valid() && Date.now() < item.expiresAt);
  }
  /** A deferred host start loses the submission's AsyncLocalStorage scope; only marked detached submissions may be matched without it. */
  private detached(owner: object, sessionId: string): Submission[] {
    this.prune();
    return this.pending.filter(item => item.owner === owner && item.detached && this.live(item, sessionId));
  }
  matches(event: InputEvent, sessionId: string, current = this.scope.getStore()): boolean {
    const images = event.images || [];
    return Boolean(current && this.live(current, sessionId) && Date.now() < current.expiresAt &&
      event.source === "extension" && event.text === current.text && images.length === current.images.length &&
      images.every((image, index) => image === current.images[index]));
  }
  admit(event: InputEvent, sessionId: string, owner: object): boolean {
    const scoped = this.scope.getStore();
    const current = scoped
      ? (scoped.owner === owner ? scoped : undefined)
      : this.detached(owner, sessionId).find(item => !item.admitted && this.matches(event, sessionId, item));
    if (!current || current.owner !== owner || current.admitted || !this.matches(event, sessionId, current)) return false;
    current.admitted = true;
    current.queued = Boolean(event.streamingBehavior);
    return true;
  }
  prepare(text: string, images: ImageContent[] | undefined, sessionId: string, owner: object): boolean {
    const scoped = this.scope.getStore();
    const event = { type: "input", source: "extension", text, images } as const;
    const current = scoped
      ? (scoped.owner === owner ? scoped : undefined)
      : this.detached(owner, sessionId).find(item => item.admitted && !item.consumed && !item.prepared && this.matches(event, sessionId, item));
    if (!current || current.owner !== owner || !current.admitted || current.consumed || current.prepared ||
      !this.matches(event, sessionId, current)) return false;
    current.prepared = true;
    return true;
  }
  startRun(sessionId: string, owner?: object): void {
    const scoped = this.scope.getStore();
    const current = scoped || (owner ? this.detached(owner, sessionId).find(item => item.prepared && !item.consumed) : undefined);
    if (current?.prepared && !current.consumed && this.live(current, sessionId)) current.running = true;
  }
  consume(content: unknown, sessionId: string, owner: object): { steering: boolean; text: string } | undefined {
    this.prune();
    const run = this.scope.getStore();
    if (run && (run.owner !== owner || !this.live(run, sessionId) || !run.running)) return;
    const pending = this.pending.filter(item => item.owner === owner && this.live(item, sessionId));
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(block => block?.type === "text").map(block => block.text).join("\n") : "";
    const images = Array.isArray(content) ? content.filter(block => block?.type === "image") : [];
    const exact = (item: Submission): boolean => item.text === text && images.length === item.images.length &&
      images.every((image, index) => image === item.images[index]);
    // The host creates the first user message only after its trusted normalization.
    // Its text/images may change or be omitted. Authority is admission + this run,
    // not a permissive suffix matcher. This window can be consumed only once.
    const current = run
      ? (!run.consumed && run.admitted && run.prepared && this.pending.includes(run) ? run : undefined)
      : pending.find(item => item.detached && item.running && item.admitted && item.prepared && !item.consumed);
    if (current) {
      if (!run) this.detachedOwners.add(owner);
      current.consumed = true;
      this.prune();
      return { steering: current.steering, text: current.text };
    }
    if (run ? !run.consumed : !this.detachedOwners.has(owner)) return;
    // Queued steering is consumed in the authenticated run's scope, not its own.
    const queued = pending.find(item => item.admitted && item.queued && !item.consumed && exact(item));
    if (!queued) return;
    queued.consumed = true;
    this.prune();
    return { steering: queued.steering, text: queued.text };
  }
  hasPending(owner: object): boolean { this.prune(); return this.pending.some(item => item.owner === owner); }
  hasPrompt(owner: object, text: string): boolean { this.prune(); return this.pending.some(item => item.owner === owner && item.text === text); }
  send(text: string, sessionId: string, valid: () => boolean, send: () => void,
    delivery?: { images: ImageContent[]; owner: object; steering: boolean }): void {
    const { images = [], owner = {}, steering = false } = delivery || {};
    this.prune();
    if (this.pending.length >= 128) throw new Error("Telegram input admission queue is full.");
    const current: Submission = { text, images, sessionId, owner, steering, valid, expiresAt: Date.now() + TTL,
      admitted: false, prepared: false, running: false, consumed: false, queued: false, detached: false };
    this.pending.push(current);
    this.scope.run(current, send);
    // Input handlers run synchronously when the host starts this submission. If they
    // did not, the host deferred the prompt past agent_settled and the scope is gone.
    if (!current.admitted) current.detached = true;
  }
  close(): void { this.pending = []; this.detachedOwners = new WeakSet(); }
}
