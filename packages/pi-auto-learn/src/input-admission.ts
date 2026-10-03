import type { ExtensionAPI, InputEvent } from '@earendil-works/pi-coding-agent';
import { guestInput } from './observations.ts';

interface Receipt { id: string; expiresAt: number; valid: () => boolean }
interface Pending { text: string; sessionId: string; expiresAt: number; guest: boolean; human: boolean; receipt?: Receipt }
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text).join('\n') : '';
}
/** Admission requires BOTH an actual input event and a consumed user message.
 * Bus callbacks run synchronously. Executable extensions are trusted peers; text is not.
 */
export class InputAdmission {
  private pending: Pending[] = [];
  private current?: Pending;
  private generation = 0;
  private pi: ExtensionAPI;
  constructor(pi: ExtensionAPI) { this.pi = pi; }
  input(event: InputEvent, sessionId: string): void {
    this.current = undefined;
    this.pending = this.pending.filter(p => p.sessionId === sessionId && p.expiresAt > Date.now());
    let receipt: Receipt | undefined;
    if (event.source === 'extension') this.pi.events.emit('pi-telegram:claim-human-input:v1', {
      event, sessionId, accept: (value: Receipt) => { receipt = value; },
    });
    // Ambiguous identical pending inputs fail closed, rather than letting a replay steal a grant.
    const duplicate = this.pending.some(p => p.text === event.text);
    if (duplicate) this.pending = this.pending.filter(p => p.text !== event.text);
    if (this.pending.length >= 32) { this.pending = []; return; }
    this.pending.push({ text: event.text, sessionId, expiresAt: receipt?.expiresAt ?? Date.now() + 10 * 60_000,
      human: !duplicate && (event.source !== 'extension' || Boolean(receipt)), guest: guestInput(event.text), receipt });
  }
  consume(role: string, content: unknown, sessionId: string): void {
    if (role === 'custom') { this.current = undefined; return; }
    if (role !== 'user') return;
    const text = messageText(content);
    this.pending = this.pending.filter(p => p.sessionId === sessionId && p.expiresAt > Date.now());
    const index = this.pending.findIndex(p => p.text === text && p.sessionId === sessionId && p.expiresAt > Date.now());
    this.current = index < 0 ? undefined : this.pending.splice(index, 1)[0];
    if (this.current?.receipt && !this.current.receipt.valid()) this.current = undefined;
  }
  snapshot(sessionId: string, text: string): (admitGuests: boolean) => boolean {
    const p = this.current;
    const generation = this.generation;
    return admitGuests => Boolean(p && generation === this.generation && p.expiresAt > Date.now() &&
      p.sessionId === sessionId && p.text === text && p.human &&
      (!p.guest || admitGuests) && (!p.receipt || p.receipt.valid()));
  }
  clear(): void { this.generation++; this.pending = []; this.current = undefined; }
}
