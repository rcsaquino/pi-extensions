import { randomUUID } from "node:crypto";
import { ExpectedError } from "./errors.ts";
import { HOT_LIMIT } from "./text.ts";

export interface HotMemory {
  id: string;
  content: string;
  priority: number;
  position: number;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface HotSnapshot {
  text: string;
  entries: HotMemory[];
  characters: number;
  remaining: number;
  archived: HotMemory[];
}

export interface HotAddResult extends HotSnapshot { memory: HotMemory; created: boolean; note?: string }
export interface HotEditResult extends HotSnapshot { memory: HotMemory }
export interface HotDeleteResult extends HotSnapshot { deleted: HotMemory }

/** The prompt sees rules only. IDs and priorities remain storage metadata. */
export function renderHotMemory(entries: Pick<HotMemory, "content">[]): string {
  return entries.map((entry) => `- ${entry.content}`).join("\n");
}

export function buildHotSnapshot(entries: HotMemory[], archived: HotMemory[] = []): HotSnapshot {
  const text = renderHotMemory(entries);
  return { text, entries, characters: text.length, remaining: HOT_LIMIT - text.length, archived };
}

export function newHotId(): string {
  return `h_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

interface CapacityEntry { id: string; priority: number; characters: number; content: string }

function described(entry: HotMemory): CapacityEntry {
  return { id: entry.id, priority: entry.priority, characters: `- ${entry.content}`.length, content: entry.content };
}

/**
 * Evict the lowest-priority eligible entries until the rendered rules fit.
 * With a target, only strictly lower-priority entries are eligible. Without
 * one (migration), every entry is eligible, lowest priority first.
 */
export function fitHotMemory(entries: HotMemory[], target?: HotMemory): { kept: HotMemory[]; evicted: HotMemory[] } {
  const kept = entries.slice();
  const evicted: HotMemory[] = [];
  while (renderHotMemory(kept).length > HOT_LIMIT) {
    const candidates = kept
      .filter((entry) => entry.id !== target?.id && (!target || entry.priority < target.priority))
      .sort((a, b) => a.priority - b.priority || a.position - b.position);
    const victim = candidates[0];
    if (!victim) break;
    kept.splice(kept.indexOf(victim), 1);
    evicted.push(victim);
  }
  return { kept, evicted };
}

/**
 * Exact capacity diagnostics for a refused hot operation. `current` is the
 * pre-change list, `proposed` includes the requested add/edit, and `entry` is
 * the proposed or duplicated rule.
 */
export function hotCapacityDetails(reason: string, operation: string, current: HotMemory[], proposed: HotMemory[], entry: HotMemory) {
  const currentCharacters = renderHotMemory(current).length;
  const proposedCharacters = renderHotMemory(proposed).length;
  const eligible = current
    .filter((item) => item.id !== entry.id && item.priority < entry.priority)
    .sort((a, b) => a.priority - b.priority || a.position - b.position)
    .map(described);
  const eligibleIds = new Set(eligible.map((item) => item.id));
  const afterEligibleEviction = renderHotMemory(proposed.filter((item) => !eligibleIds.has(item.id))).length;
  return {
    reason,
    operation,
    limit: HOT_LIMIT,
    current_characters: currentCharacters,
    proposed_characters: proposedCharacters,
    over_by: Math.max(0, proposedCharacters - HOT_LIMIT),
    remaining: Math.max(0, HOT_LIMIT - currentCharacters),
    proposed_entry: described(entry),
    entries: current.map(described),
    eligible,
    eligible_characters: eligible.reduce((sum, item) => sum + item.characters, 0),
    shortfall_after_eligible_eviction: Math.max(0, afterEligibleEviction - HOT_LIMIT),
    unchanged: true,
    next_actions: [
      "Shorten the rule or delete lower-value hot rules.",
      "Save the fact in long-term SQLite memory instead.",
      "Raise the priority only when the new rule genuinely outranks the rules it displaces.",
    ],
  };
}

export function hotCapacityError(reason: string, operation: string, current: HotMemory[], proposed: HotMemory[], entry: HotMemory): ExpectedError {
  const details = hotCapacityDetails(reason, operation, current, proposed, entry);
  const prefix = reason === "rule_too_large"
    ? `A single hot rule renders to ${details.proposed_entry.characters} characters, over the ${HOT_LIMIT}-character total limit.`
    : `Hot memory would still be ${details.shortfall_after_eligible_eviction} characters over the ${HOT_LIMIT}-character limit after evicting every eligible lower-priority rule.`;
  return new ExpectedError("hot_capacity", `${prefix} The transaction was rolled back and no rows changed. Shorten the rule, delete a hot rule, use long-term memory, or adjust priority.`, details);
}
