import type { Config } from './types.ts';
export const DEFAULT_CONFIG: Config = {
  version: 1, enabled: true, debounceMs: 20_000, intervalMs: 300_000,
  timeoutMs: 180_000, cleanupIntervalMs: 86_400_000,
  hourlyBatches: 4, hourlyTokens: 200_000, answerTokens: 8192,
  observationDays: 7, unusedDays: 90, unusedRuns: 50, reviewGapDays: 7,
  maxChanges: 3, maxDeletes: 1, advertise: true, admitGuests: false,
  maxRetries: 2, backupRevisions: 20,
};
export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be an object');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`Unknown configuration field: ${key}`);
  const out = { ...DEFAULT_CONFIG, ...input } as Config;
  if (out.version !== 1) throw new Error('Unsupported configuration version');
  for (const [key, sample] of Object.entries(DEFAULT_CONFIG)) {
    const v = out[key as keyof Config];
    if (typeof v !== typeof sample || (typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0))) throw new Error(`Invalid configuration field: ${key}`);
  }
  if (out.maxChanges < 1 || out.maxChanges > 3 || out.maxDeletes > 1 || out.maxRetries > 2) throw new Error('Configuration exceeds immutable change/retry ceilings');
  if (out.timeoutMs < 1000 || out.timeoutMs > 600_000 || out.answerTokens < 1024 || out.answerTokens > 65_536) throw new Error('Unsafe request limits');
  if (out.hourlyTokens < 1024 || out.hourlyTokens > 2_000_000 || out.hourlyBatches > 20 || out.backupRevisions < 1 || out.backupRevisions > 100) throw new Error('Unsafe resource limits');
  return out;
}
