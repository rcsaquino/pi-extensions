import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Job } from './types.ts';
import type { Usage } from '@earendil-works/pi-ai';

export const TELEMETRY_CHANNEL = 'background-tasks:telemetry:v1';
export function telemetry(pi: ExtensionAPI, job: Job, type: string, meta: Record<string, unknown> = {}): void {
  // All call sites pass only closed metadata. Never pass messages, errors, inputs,
  // results, system prompts, provider payloads/headers or task titles/paths.
  try { pi.events.emit(TELEMETRY_CHANNEL, { version: 1, type, taskId: job.record.id,
    sessionId: job.record.sessionId, rootCallId: job.rootCallId, ...meta }); } catch { /* Observers never block work. */ }
}
export function telemetryUsage(usage?: Usage): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'totalTokens'] as const) {
    const value = usage?.[key]; if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  return result;
}
