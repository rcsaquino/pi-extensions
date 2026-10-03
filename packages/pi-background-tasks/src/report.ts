import type { RecordData, TerminalCategory, TerminalDiagnostics, WorkerPhase } from './types.ts';

const reasons = ['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred', 'pending', 'missing', 'unknown'] as const;
const categories = ['provider_or_stream_error', 'request_preparation_error', 'compaction_error', 'output_limit',
  'deferred_response', 'unfinished_tool_turn', 'empty_report', 'missing_report', 'unsupported_terminal',
  'cancelled', 'runtime_limit', 'turn_limit', 'shutdown', 'interrupted', 'lease_cleanup_error', 'unknown', 'complete'] as const;
const phases = ['preparing', 'compacting', 'requesting', 'tool', 'finalizing', 'unknown'] as const;
const outcomes = ['completed', 'error', 'aborted'] as const;
// A closed vocabulary, not provider-supplied or dynamically named tool identities.
const toolNames = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'memoria_add', 'memoria_edit',
  'memoria_delete', 'memoria_search', 'memoria_sessions', 'web_enable', 'web_search', 'source_check',
  'fetch_content', 'get_search_content', 'auto_learn_status', 'latency_query', 'background_update_eta']);
export function safeToolName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && toolNames.has(value) ? value : 'other';
}
function member<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}
export const safeCounter = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Reconstruct only approved fields. Never spread a provider/error/diagnostics object. */
export function safeDiagnostics(value: unknown): TerminalDiagnostics {
  const d = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  let category = member(d.category, categories, 'unknown');
  if (category === 'complete' && (d.stopReason !== 'stop' || d.hadToolCalls !== false ||
      typeof d.visibleTextCharacters !== 'number' || !Number.isSafeInteger(d.visibleTextCharacters) || d.visibleTextCharacters < 1 ||
      typeof d.lastPhase !== 'string' || !phases.includes(d.lastPhase as WorkerPhase) || d.leaseCleanupFailed === true)) category = 'unknown';
  return {
    stopReason: member(d.stopReason, reasons, 'unknown'), category,
    lastPhase: member(d.lastPhase, phases, 'unknown'),
    ...(d.failurePhase !== undefined ? { failurePhase: member(d.failurePhase, phases, 'unknown') } : {}),
    visibleTextCharacters: safeCounter(d.visibleTextCharacters), hadToolCalls: d.hadToolCalls === true,
    ...(d.leaseCleanupFailed === true ? { leaseCleanupFailed: true } : {}),
    ...(typeof d.lastToolOutcome === 'string' && outcomes.includes(d.lastToolOutcome as typeof outcomes[number])
      ? { lastToolOutcome: d.lastToolOutcome as typeof outcomes[number] } : {}),
  };
}

export interface TerminalView { stopReason: unknown; text: string; hadToolCalls: boolean; malformed?: boolean }
export function terminalCategory(view: TerminalView | undefined): TerminalCategory {
  if (!view) return 'missing_report';
  if (view.malformed) return 'unsupported_terminal';
  if (view.stopReason === 'error') return 'unknown'; // Provenance must be observed separately.
  if (view.stopReason === 'length') return 'output_limit';
  if (view.stopReason === 'deferred') return 'deferred_response';
  if (view.stopReason === 'aborted') return 'cancelled';
  if (view.hadToolCalls || view.stopReason === 'toolUse') return 'unfinished_tool_turn';
  if (view.stopReason !== 'stop') return 'unsupported_terminal';
  return view.text.trim() ? 'complete' : 'empty_report';
}

export function observeFailure(progress: { lastPhase: WorkerPhase; failurePhase?: WorkerPhase; failureCategory?: TerminalCategory }, category: TerminalCategory): void {
  progress.failurePhase ??= progress.lastPhase;
  progress.failureCategory ??= category;
}

const descriptions: Record<TerminalCategory, string> = {
  complete: 'A valid worker final report was received. Its claims still require verification.',
  provider_or_stream_error: 'A model request or its response stream failed. Raw provider details were not retained.',
  request_preparation_error: 'Request preparation failed before a usable final report.',
  compaction_error: 'Worker context compaction failed before a usable final report.',
  output_limit: 'The terminal model response reached an output limit and is not a complete report.',
  deferred_response: 'The terminal response was deferred, not a completed report.',
  unfinished_tool_turn: 'The worker ended on an incomplete tool turn, not a final report.',
  empty_report: 'The final response had no nonblank visible assistant text.',
  missing_report: 'No usable final assistant report was recorded.',
  unsupported_terminal: 'The terminal response was unsupported or malformed and was rejected.',
  cancelled: 'The worker was cancelled or aborted. Earlier effects are not rolled back.',
  runtime_limit: 'The worker reached the configured runtime limit.',
  turn_limit: 'The worker reached the 200-turn safety limit.',
  shutdown: 'Pi stopped or reloaded while the worker was running.',
  interrupted: 'The previous process ended before settlement was recorded. The exact terminal reason is unavailable.',
  lease_cleanup_error: 'Writer lease cleanup failed. Inspect runtime storage before starting another writer.',
  unknown: 'The exact failure reason is unavailable; no raw error details were retained.',
};
export function safeReason(category: TerminalCategory): string { return descriptions[category]; }
const legacyErrors = new Set([
  'Background task reached the configured runtime limit; effects may be partial.',
  'Worker did not produce a complete final response. Output may be partial; check the task and retry only after reviewing possible effects.',
  'Worker reached the 200-turn safety limit.',
  'Stopped because Pi is shutting down or reloading; effects may be partial.',
  'Worker failed. Effects may be partial; no automatic replay was performed.',
  'Writer lease cleanup failed; inspect runtime storage before starting another writer.',
  'Task result could not be saved. Review workspace effects before retrying.',
  'Pi stopped or reloaded before this task settled. Effects may be partial. It was NOT replayed.',
  'Runtime stopped before cancellation settled. Tool effects may be partial. No task replay was attempted.',
  ...Object.values(descriptions),
]);
export function safeStoredError(value: unknown): string | undefined {
  return value === undefined ? undefined : typeof value === 'string' && legacyErrors.has(value) ? value : descriptions.unknown;
}

/** Pure, deterministic reporting. It verifies neither tool effects nor worker claims and makes no model calls. */
export function buildSettlementReport(record: RecordData, visibleFinal = '', storageFailed = false): { source: 'worker' | 'fallback'; text: string } {
  const d = safeDiagnostics(record.terminalDiagnostics);
  if (!storageFailed && record.status === 'completed' && d.category === 'complete' && d.stopReason === 'stop' &&
      !d.hadToolCalls && !d.leaseCleanupFailed && d.visibleTextCharacters === visibleFinal.length && visibleFinal.trim()) return { source: 'worker', text: visibleFinal };
  const runtime = safeCounter(record.finishedAt) >= safeCounter(record.startedAt)
    ? Math.floor((safeCounter(record.finishedAt) - safeCounter(record.startedAt)) / 1000) : 0;
  // Title and optional partial prose are visible user/assistant material, not diagnostic payloads.
  const title = typeof record.title === 'string' ? record.title.replace(/[\r\n]/g, ' ').slice(0, 200) : 'Background task';
  const status = ['completed', 'failed', 'cancelled', 'interrupted'].includes(record.status) ? record.status : 'interrupted';
  const text = [`# Background task report: ${title}`, `Status: ${status}`, 'Report source: deterministic fallback', '',
    `Reason: ${safeReason(d.category)}`, `Terminal stop: ${d.stopReason}; last phase: ${d.lastPhase}${d.failurePhase ? `; failure phase: ${d.failurePhase}` : ''}.`,
    `Last recorded tool: ${safeToolName(record.lastTool) ?? 'not recorded'}; outcome: ${d.lastToolOutcome ?? 'not recorded'}.`,
    `Runtime: ${runtime}s; tool calls: ${safeCounter(record.toolCalls)}; assistant turns: ${safeCounter(record.turns)}.`, '',
    'Effects may have occurred. This fallback does NOT verify the work, tool effects, artifacts, or tests. A successful tool return alone does not prove task completion.',
    'No automatic replay was performed. Review workspace state and existing artifacts/checkpoints before retrying any writes.',
    ...(d.leaseCleanupFailed ? ['Writer lease cleanup failed; lease ownership may still be reserved.'] : []),
    d.category === 'lease_cleanup_error' || d.leaseCleanupFailed ? 'Next step: inspect the writer lease and ensure cooperating tools have settled before further work.'
      : 'Next step: independently verify the requested deliverables and possible partial effects; obtain authorization before any retry.',
    ...(storageFailed ? ['', 'Storage failure: the result could not be durably saved or retrieved. This bounded in-memory report is available only in this process; durable survival and usage bookkeeping are not guaranteed.'] : []),
    ...(visibleFinal.trim() ? ['', '## Partial worker prose (unverified, not a completion report)', visibleFinal] : []),
  ].join('\n');
  return { source: 'fallback', text };
}
