export const SCHEMA_VERSION = 1;

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write'] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'orphaned';
export type NoticeState = 'pending' | 'sent' | 'failed';
export type Disposition = 'queued' | 'started' | 'settled' | 'rejected';

export interface AgentConfig {
  extensions: string[];
  skills: string[];
  excludeTools: BuiltinTool[];
  model?: string;
  thinking?: ThinkingLevel;
  timeoutSeconds: number;
  maxTurns: number;
}

export interface AgentDefinition {
  name: string;
  dir: string;
  promptPath: string;
  /** One-line summary from description.md; absent when the file is missing. */
  description?: string;
}

export interface Discovery {
  definitions: AgentDefinition[];
  warnings: string[];
}

/** Run record. Written only by the extension; unknown keys are preserved. */
export interface RunRecord {
  schemaVersion: number;
  id: string;
  agent: string;
  title: string;
  cwd: string;
  sessionId: string;
  sessionFile: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  provider: string;
  model: string;
  thinking: string;
  timeoutSeconds: number;
  maxTurns: number;
  pid?: number;
  pgid?: number;
  workerPid?: number;
  workerPgid?: number;
  workerStartTicks?: number;
  bootId?: string;
  startTicks?: number;
  exitCode?: number;
  reason?: string;
  reportBytes?: number;
  steerCount: number;
  deniedDialogs: number;
  notice?: NoticeState;
  noticeAttempts?: number;
  noticeAt?: string;
  [key: string]: unknown;
}

export interface ReadyInfo {
  supervisorPid: number;
  supervisorPgid: number;
  workerPid: number;
  workerPgid: number;
  workerStartTicks: number;
  startedAt: string;
}

export interface DispatchInput {
  agent: string;
  title: string;
  brief: string;
  cwd: string;
}
