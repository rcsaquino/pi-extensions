import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { THINKING_LEVELS, type AgentConfig, type ThinkingLevel } from './types.ts';

export interface Selection {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  /** Passed as --provider only for a bare model id. */
  providerFlag?: string;
}

type AnyModel = Parameters<ModelRegistry['hasConfiguredAuth']>[0];

interface MainModel { id: string; provider: string }

export function resolveSelection(
  registry: ModelRegistry,
  main: MainModel | undefined,
  mainThinking: string | undefined,
  config: AgentConfig,
): Selection {
  if (!main) throw new Error('No active model; select a model before dispatching subagents');
  let chosen = main as unknown as AnyModel;
  let providerFlag: string | undefined = main.provider;

  if (config.model) {
    const spec = config.model;
    const slash = spec.indexOf('/');
    if (slash > 0) {
      const provider = spec.slice(0, slash);
      const id = spec.slice(slash + 1);
      const found = registry.find(provider, id);
      if (!found) throw new Error(`Unknown model "${spec}"`);
      chosen = found;
      providerFlag = undefined;
    } else {
      const matches = registry.getAll().filter(entry => entry.id === spec);
      if (matches.length === 1) {
        chosen = matches[0];
        providerFlag = chosen.provider;
      } else if (!matches.length) {
        throw new Error(`Unknown model "${spec}"`);
      } else {
        const listed = matches.map(entry => `${entry.provider}/${entry.id}`).join(', ');
        throw new Error(`Ambiguous model "${spec}"; use provider/id: ${listed}`);
      }
    }
  }

  if (!registry.hasConfiguredAuth(chosen)) {
    throw new Error(`No credentials configured for ${chosen.provider}/${chosen.id}`);
  }

  const thinking = (config.thinking ?? mainThinking ?? 'off') as ThinkingLevel;
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(`Unsupported thinking level "${thinking}"`);
  }
  return { provider: chosen.provider, model: chosen.id, thinking, ...(providerFlag ? { providerFlag } : {}) };
}
