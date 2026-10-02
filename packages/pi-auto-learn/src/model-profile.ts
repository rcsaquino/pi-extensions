import type { ExtensionContext, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { Profile } from './types.ts';
import { hash } from './filesystem.ts';

export function selectionKey(ctx: ExtensionContext, pi: ExtensionAPI): string {
  const settings = pi.getSettings();
  return JSON.stringify([ctx.model?.provider, ctx.model?.id, ctx.thinkingLevel ?? pi.getThinkingLevel(), settings.thinkingBudgets ?? {}, settings.transport ?? 'auto']);
}
export function resolveProfile(ctx: ExtensionContext, pi: ExtensionAPI, dispatched?: { selectedKey: string; message: AssistantMessage }): Profile | undefined {
  const selected = ctx.model;
  if (!selected) return undefined;
  const selectedLevel = (ctx.thinkingLevel ?? pi.getThinkingLevel()) as ModelThinkingLevel;
  let model = selected;
  let level = selectedLevel;
  if (dispatched && dispatched.selectedKey === selectionKey(ctx, pi)) {
    const m = dispatched.message;
    const found = ctx.modelRegistry.find(m.provider, m.model);
    if (!found || String(found.api) === 'pi-virtual') return undefined;
    if (String(selected.api) === 'pi-virtual' && !m.thinkingLevel) return undefined;
    model = found;
    level = m.thinkingLevel ?? selectedLevel;
  } else if (String(selected.api) === 'pi-virtual') return undefined;
  const settings = pi.getSettings();
  const options = {
    thinkingBudgets: settings.thinkingBudgets ? { ...settings.thinkingBudgets } : undefined,
    transport: settings.transport ?? 'auto',
    websocketConnectTimeoutMs: settings.websocketConnectTimeoutMs,
    maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs,
  };
  const chosen = `${selected.provider}/${selected.id}`;
  return { selected: chosen, selectedLevel, model, level, options, fingerprint: hash(JSON.stringify([chosen, selectedLevel, model.provider, model.id, level, options])) };
}
export function outputBudget(profile: Profile, answerTokens: number, inputTokens: number): { maxTokens: number; reserveTokens: number } {
  const defaults = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
  const budgetLevel = profile.level === 'xhigh' || profile.level === 'max' ? 'high' : profile.level;
  const thinking = budgetLevel === 'off' ? 0 : (profile.options.thinkingBudgets?.[budgetLevel] ?? defaults[budgetLevel]);
  const maxTokens = Math.min(profile.model.maxTokens, Math.max(answerTokens, thinking + 1024));
  if (maxTokens < thinking + 1024) throw new Error('Model output ceiling cannot preserve the inherited thinking budget');
  const reserveOutput = Math.min(profile.model.maxTokens, maxTokens + thinking);
  if (profile.model.contextWindow > 0 && inputTokens + reserveOutput + 4096 > profile.model.contextWindow) throw new Error('Learning context cannot preserve inherited reasoning; defer');
  return { maxTokens, reserveTokens: inputTokens + reserveOutput };
}
