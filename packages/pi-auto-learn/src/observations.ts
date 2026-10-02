import type { Evidence } from './types.ts';
import { safeExcerpt } from './privacy.ts';
import { hash } from './filesystem.ts';

type Entry = { type: string; id: string; message?: { role: string; content?: unknown; stopReason?: string } };
function visibleText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
}
export function guestInput(text: string): boolean {
  return /^\[(?:telegram|[^\]]*thread)[^\]]*(?:guest:|from:(?!user(?:\||\])))[^\]]*\]/m.test(text);
}
export function capture(branch: readonly Entry[], sessionId: string, used: string[], failures: string[], now = Date.now()): Evidence | undefined {
  const recent = branch.slice(-120);
  let user: Entry | undefined;
  let assistant = '';
  let completed = false;
  for (const entry of recent) {
    if (entry.type !== 'message' || !entry.message) continue;
    if (entry.message.role === 'user') { user = entry; assistant = ''; completed = false; }
    else if (user && entry.message.role === 'assistant') {
      if (['error', 'aborted', 'pending', 'deferred'].includes(entry.message.stopReason ?? 'pending')) continue;
      assistant = visibleText(entry.message.content);
      completed = entry.message.stopReason === 'stop';
    }
  }
  if (!user || !completed) return undefined;
  const u = safeExcerpt(visibleText(user.message!.content));
  const a = safeExcerpt(assistant);
  if (!u || a === undefined) return undefined;
  if (!used.length && !failures.length && u.length < 35 && !/learn|skill|remember|repeat/i.test(u)) return undefined;
  return { id: hash(`${sessionId}:${user.id}`).slice(0, 32), sessionId, entryId: user.id, timestamp: now, user: u, assistant: a, used: [...new Set(used)].slice(0, 20), failures: [...new Set(failures)].slice(0, 20) };
}
