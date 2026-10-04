import type { Agent, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Model, Provider, Usage } from '@earendil-works/pi-ai';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Stage, StageSpec, OutputManifest } from './staging.ts';
import type { ResourceLease } from './resources.ts';

export type Status = 'queued' | 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ContextMode = 'brief' | 'selected' | 'full';
export type WorkerPhase = 'preparing' | 'compacting' | 'requesting' | 'tool' | 'finalizing' | 'unknown';
export type TerminalCategory = 'provider_or_stream_error' | 'request_preparation_error' | 'compaction_error'
  | 'output_limit' | 'deferred_response' | 'unfinished_tool_turn' | 'empty_report' | 'missing_report'
  | 'unsupported_terminal' | 'cancelled' | 'runtime_limit' | 'turn_limit' | 'shutdown' | 'interrupted'
  | 'lease_cleanup_error' | 'admission_error' | 'stage_validation_error' | 'queue_cancelled' | 'unknown' | 'complete';
export interface TerminalDiagnostics {
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred' | 'pending' | 'missing' | 'unknown';
  category: TerminalCategory;
  lastPhase: WorkerPhase;
  failurePhase?: WorkerPhase;
  visibleTextCharacters: number;
  hadToolCalls: boolean;
  lastToolOutcome?: 'completed' | 'error' | 'aborted';
  leaseCleanupFailed?: boolean;
}
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
  execution?: 'direct' | 'staged';
  stage?: StageSpec;
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
  queuedAt?: number;
  queueWaitMs?: number;
  waitingReason?: 'capacity' | 'resources' | 'admission';
  execution?: 'direct' | 'staged';
  manifest?: OutputManifest;
  publication?: 'ready' | 'published' | 'review-required';
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
  /** Allowlisted terminal summary only. Absent on old v1 records. */
  terminalDiagnostics?: TerminalDiagnostics;
  reportSource?: 'worker' | 'fallback';
}
export interface Job {
  record: RecordData;
  ctx?: ExtensionToolContext;
  rootCallId?: string;
  agent?: Agent;
  controller?: AbortController;
  done?: Promise<void>;
  finish?: () => void;
  settling?: boolean;
  release?: () => Promise<void>;
  resourceLease?: ResourceLease;
  stage?: Stage;
  starting?: boolean;
  pending?: { dispatch: NormalizedDispatch; profile: Profile };
  contextSnapshot?: AgentMessage[];
  /** Ephemeral observation, never a transcript or raw error. */
  progress?: {
    lastPhase: WorkerPhase;
    failurePhase?: WorkerPhase;
    failureCategory?: TerminalCategory;
    lastToolCallId?: string;
    lastToolOutcome?: TerminalDiagnostics['lastToolOutcome'];
    pendingTools: Set<string>;
    abortedTools: Set<string>;
  };
  abortCategory?: 'cancelled' | 'runtime_limit' | 'turn_limit' | 'shutdown';
  /** Bounded explicit-retrieval fallback when storage is unavailable. Not a durable result. */
  memoryReport?: string;
  storageFailed?: boolean;
  /** Ephemeral dispatch-captured transport capability. Never persisted or exposed to workers. */
  noticeRouter?: (noticeId: string, content: string) => boolean;
}
export interface Profile {
  model: Model<any>;
  thinking: ThinkingLevel;
  /** In-process provider implementation identity only, never serialized. Auth remains request-time. */
  providerRuntime?: Provider;
}
export const isActive = (status: Status): boolean => status === 'queued' || status === 'starting' || status === 'running' || status === 'cancelling';
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(total: Usage, next?: Usage): void {
  if (!next) return;
  const tokens = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const cost = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) total[key] = tokens(total[key] + tokens(next[key]));
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) total.cost[key] = cost(total.cost[key] + cost(next.cost?.[key]));
  if (tokens(next.reasoning)) total.reasoning = tokens((total.reasoning || 0) + tokens(next.reasoning));
  if (tokens(next.cacheWrite1h)) total.cacheWrite1h = tokens((total.cacheWrite1h || 0) + tokens(next.cacheWrite1h));
}
