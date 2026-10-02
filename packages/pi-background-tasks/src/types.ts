import type { Agent, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Model, Usage } from '@earendil-works/pi-ai';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';

export type Status = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ContextMode = 'brief' | 'selected' | 'full';
export interface Dispatch {
  task: string;
  title: string;
  eta_seconds: number;
  eta_max_seconds?: number;
  estimate_reason: string;
  mode?: 'auto' | 'manual';
  access?: 'read' | 'write';
  context_mode?: ContextMode;
  context_text?: string;
}
export interface NormalizedDispatch extends Dispatch {
  eta_max_seconds: number;
  mode: 'auto' | 'manual';
  access: 'read' | 'write';
  context_mode: ContextMode;
}
export interface RecordData {
  version: 1;
  id: string;
  title: string;
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  status: Status;
  access: 'read' | 'write';
  /** Absent on legacy 0.1.0 tasks, which copied projected history by default. */
  contextMode?: ContextMode;
  startedAt: number;
  finishedAt?: number;
  etaSeconds: number;
  etaMaxSeconds: number;
  estimateReason: string;
  lastActivityAt: number;
  lastTool?: string;
  toolCalls: number;
  turns: number;
  usage: Usage;
  usageReported: boolean;
  notification: 'pending' | 'queued' | 'read';
  overrunNotified: boolean;
  error?: string;
}
export interface Job {
  record: RecordData;
  ctx?: ExtensionToolContext;
  rootCallId?: string;
  agent?: Agent;
  controller?: AbortController;
  done?: Promise<void>;
  settling?: boolean;
  release?: () => Promise<void>;
}
export interface Profile {
  model: Model<any>;
  thinking: ThinkingLevel;
}
export const isActive = (status: Status): boolean => status === 'running' || status === 'cancelling';
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(total: Usage, next?: Usage): void {
  if (!next) return;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) total[key] += next[key] || 0;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) total.cost[key] += next.cost?.[key] || 0;
  if (next.reasoning) total.reasoning = (total.reasoning || 0) + next.reasoning;
  if (next.cacheWrite1h) total.cacheWrite1h = (total.cacheWrite1h || 0) + next.cacheWrite1h;
}
