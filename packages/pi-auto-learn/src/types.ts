import type { Api, Model, ModelThinkingLevel, SimpleStreamOptions } from '@earendil-works/pi-ai';

export const CORE = 'learning-policy';
export const DAY = 86_400_000;
export interface Config {
  version: 1; enabled: boolean; debounceMs: number; intervalMs: number;
  timeoutMs: number; cleanupIntervalMs: number; hourlyBatches: number;
  hourlyTokens: number; answerTokens: number; observationDays: number;
  unusedDays: number; unusedRuns: number; reviewGapDays: number;
  maxChanges: number; maxDeletes: number; advertise: boolean;
  admitGuests: boolean; maxRetries: number; backupRevisions: number;
}
export interface Evidence {
  id: string; sessionId: string; entryId: string; timestamp: number;
  user: string; assistant: string; used: string[]; failures: string[];
}
export interface SkillStats {
  firstSeen: number; lastActivity: number; lastUse: number | null;
  hash: string; qualifyingRuns: number; cleanupReviews: number[];
}
export interface SkillFile { path: string; content: Buffer; mode: number; directory?: boolean }
export interface SkillRecord {
  id: string; name: string; description: string; markdown: string;
  hash: string; files: SkillFile[]; valid: boolean;
  disableModelInvocation: boolean; issue?: string;
}
export interface ProposedFile { path: string; content: string }
export interface CreateChange {
  operation: 'create'; skillId: string; baseHash: null; reason: string;
  files: ProposedFile[]; workflow: string; reopens?: string; resolution?: string;
}
export interface UpdateChange {
  operation: 'update'; skillId: string; baseHash: string; reason: string;
  files: ProposedFile[];
}
export type RetirementReason = 'unused' | 'stale' | 'bad' | 'redundant' | 'superseded';
export interface DeleteChange {
  operation: 'delete'; skillId: string; baseHash: string; reason: string;
  retirement: { reasonCode: RetirementReason; replacementSkillId?: string };
}
export type Change = CreateChange | UpdateChange | DeleteChange;
export interface Proposal { protocolVersion: 1; decision: 'noop' | 'change'; evidenceIds: string[]; changes: Change[] }
export interface Review { protocolVersion: 1; verdict: 'approve' | 'reject' | 'pending'; reason: string }
export interface Revision {
  id: string; skillId: string; operation: Change['operation'] | 'restore' | 'rollback' | 'bootstrap';
  timestamp: number; reason: string; beforeHash: string | null; afterHash: string | null;
  evidenceIds: string[]; archive?: string; proposal?: string; profile?: string; status: 'committed' | 'rejected' | 'pending';
}
export interface Tombstone { skillId: string; name: string; workflow: string; reason: string; hash: string; timestamp: number }
export interface BudgetRecord { id: string; sessionId: string; timestamp: number; reserved: number; tokens: number; cost: number; uncertain: boolean }
export interface Activity { pid: number; expires: number }
export interface State {
  version: 1; paused: boolean; excluded: string[]; pins: string[]; suppressed: string[];
  seen: string[]; evidence: Evidence[]; skills: Record<string, SkillStats>;
  tombstones: Tombstone[]; history: Revision[]; budget: BudgetRecord[];
  active: Record<string, Activity>; lastBatches: Record<string, number>;
  lastCleanup: number; lastError?: string;
}
export interface Profile {
  selected: string; selectedLevel: ModelThinkingLevel; model: Model<Api>;
  level: ModelThinkingLevel; options: Pick<SimpleStreamOptions, 'thinkingBudgets' | 'transport' | 'websocketConnectTimeoutMs' | 'maxRetryDelayMs'>;
  fingerprint: string;
}
export interface ModelReply { text: string; tokens: number; cost: number }
export interface Host {
  sessionId: string; branchIds: Set<string>; mode: 'tui' | 'rpc' | 'json' | 'print';
  isIdle(): boolean; hasPending(): boolean; profile(): Profile | undefined;
  external: { name: string; description: string }[];
  complete(system: string, input: unknown, profile: Profile, signal: AbortSignal, maxTokens: number): Promise<ModelReply>;
}
export interface Transaction {
  version: 1; revision: Revision; operation: Revision['operation']; skillId: string;
  beforeHash: string | null; afterHash: string | null; activeMarkdownHash?: string;
  phase: 'prepared' | 'committed' | 'aborted'; staging?: string;
}
