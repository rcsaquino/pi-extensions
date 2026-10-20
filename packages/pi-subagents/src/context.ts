import type { AgentDefinition } from './types.ts';

/**
 * Body of the `<subagents>` system prompt section. Only definitions with a
 * description.md are listed; an undocumented subagent stays dispatchable but
 * is invisible to the model.
 */
export function renderSubagentsSection(definitions: AgentDefinition[]): string {
  return definitions
    .filter(definition => definition.description)
    .map(definition => `- ${definition.name}: ${definition.description}`)
    .join('\n');
}
