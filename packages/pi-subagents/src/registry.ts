import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  BUILTIN_TOOLS, THINKING_LEVELS, type AgentConfig, type AgentDefinition,
  type BuiltinTool, type Discovery, type ThinkingLevel,
} from './types.ts';

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BUILTIN_EXTENSION = /^builtin:[a-z0-9][a-z0-9._-]*$/i;
const PROMPT_MIN = 1;
const PROMPT_MAX = 16 * 1024;
const SUBAGENT_PROMPT = 'prompt.md';
const DESCRIPTION = 'description.md';
const DESCRIPTION_READ_MAX = 4 * 1024;
const DESCRIPTION_RENDER_MAX = 400;

/** Normalize PI_CODING_AGENT_DIR like memoria: expand ~ and refuse a relative path. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return resolve(homedir(), '.pi', 'agent');
  const expanded = configured === '~' ? homedir()
    : configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
  if (!expanded || !isAbsolute(expanded)) {
    throw new Error('PI_CODING_AGENT_DIR must be an absolute path (or start with ~/).');
  }
  return resolve(expanded);
}

export function subagentsRoot(): string {
  return join(agentDir(), 'subagents');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function stringArray(value: unknown, key: string, check: (item: string) => string | undefined): string[] {
  if (!Array.isArray(value)) throw new Error(`agent.json: "${key}" must be an array of strings`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.length) throw new Error(`agent.json: "${key}[${index}]" must be a non-empty string`);
    const problem = check(item);
    if (problem) throw new Error(`agent.json: "${key}[${index}]": ${problem}`);
    return item;
  });
}

/** Validate agent.json. Absence yields the documented defaults. */
export function parseConfig(raw: unknown): AgentConfig {
  if (raw === undefined) {
    return { extensions: [], skills: [], excludeTools: [], timeoutSeconds: 14400, maxTurns: 300 };
  }
  if (!isRecord(raw)) throw new Error('agent.json must be an object');
  const allowed = new Set(['extensions', 'skills', 'excludeTools', 'model', 'thinking', 'timeoutSeconds', 'maxTurns']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`agent.json: unknown key "${key}"`);
  }
  const extensions = raw.extensions === undefined ? [] : stringArray(raw.extensions, 'extensions', item => {
    if (!isAbsolute(item)) return BUILTIN_EXTENSION.test(item) ? undefined : 'must be an absolute path or builtin:<name>';
    return existsSync(item) ? undefined : 'path does not exist';
  });
  const skills = raw.skills === undefined ? [] : stringArray(raw.skills, 'skills', item => {
    if (!isAbsolute(item)) return 'must be an absolute path';
    return existsSync(item) ? undefined : 'path does not exist';
  });
  const excludeTools = raw.excludeTools === undefined ? [] : stringArray(raw.excludeTools, 'excludeTools', item =>
    (BUILTIN_TOOLS as readonly string[]).includes(item) ? undefined : 'must be one of read, bash, edit, write') as BuiltinTool[];

  let model: string | undefined;
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !raw.model.trim()) throw new Error('agent.json: "model" must be a non-empty string');
    model = raw.model.trim();
    if (/[\s*?]/.test(model)) throw new Error('agent.json: "model" must be an exact id or provider/id, without patterns');
    const suffix = /:([a-z]+)$/.exec(model);
    if (suffix && (THINKING_LEVELS as readonly string[]).includes(suffix[1])) {
      throw new Error('agent.json: "model" must not carry a :thinking suffix; use "thinking"');
    }
  }

  let thinking: ThinkingLevel | undefined;
  if (raw.thinking !== undefined) {
    if (typeof raw.thinking !== 'string' || !(THINKING_LEVELS as readonly string[]).includes(raw.thinking)) {
      throw new Error(`agent.json: "thinking" must be one of ${THINKING_LEVELS.join(', ')}`);
    }
    thinking = raw.thinking as ThinkingLevel;
  }

  const bounded = (key: 'timeoutSeconds' | 'maxTurns', fallback: number, min: number, max: number): number => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw new Error(`agent.json: "${key}" must be an integer from ${min} to ${max}`);
    }
    return value as number;
  };

  return {
    extensions, skills, excludeTools,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    timeoutSeconds: bounded('timeoutSeconds', 14400, 60, 604800),
    maxTurns: bounded('maxTurns', 300, 1, 1000),
  };
}

function promptFile(dir: string): string | undefined {
  const path = join(dir, SUBAGENT_PROMPT);
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    if (stat.size < PROMPT_MIN || stat.size > PROMPT_MAX) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

/** One-line summary for the system prompt; absent when the file is missing, empty or too large. */
function descriptionFile(dir: string): string | undefined {
  const path = join(dir, DESCRIPTION);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > DESCRIPTION_READ_MAX) return undefined;
    const text = readFileSync(path, 'utf8').replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    if (text.length <= DESCRIPTION_RENDER_MAX) return text;
    // Keep the ellipsis inside the advertised 400-code-point budget.
    const cut = text.slice(0, DESCRIPTION_RENDER_MAX - 1);
    const boundary = cut.lastIndexOf(' ');
    return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
  } catch {
    return undefined;
  }
}

/** Discovery runs on every dispatch; nothing is cached. */
export function discover(root = subagentsRoot()): Discovery {
  const warnings: string[] = [];
  const definitions: AgentDefinition[] = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return { definitions, warnings }; }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'runs') continue;
    const dir = join(root, entry.name);
    if (!NAME.test(entry.name)) {
      warnings.push(`${entry.name}: invalid agent name (expected ${NAME.source})`);
      continue;
    }
    const promptPath = promptFile(dir);
    if (!promptPath) {
      warnings.push(`${entry.name}: missing a regular ${SUBAGENT_PROMPT} of 1 byte to 16 KiB`);
      continue;
    }
    const description = descriptionFile(dir);
    definitions.push({ name: entry.name, dir, promptPath, ...(description ? { description } : {}) });
  }
  return { definitions, warnings };
}

export function findDefinition(name: string, root = subagentsRoot()): AgentDefinition {
  const { definitions } = discover(root);
  const found = definitions.find(definition => definition.name === name);
  if (!found) {
    const available = definitions.map(definition => definition.name);
    throw new Error(`Unknown subagent "${name}". Available: ${available.length ? available.join(', ') : 'none'}`);
  }
  return found;
}

export function loadConfig(dir: string): AgentConfig {
  const path = join(dir, 'agent.json');
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig(undefined);
    throw new Error(`agent.json could not be read: ${(error as Error).message}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (error) { throw new Error(`agent.json is not valid JSON: ${(error as Error).message}`); }
  return parseConfig(raw);
}

export function promptText(path: string): string {
  const text = readFileSync(path, 'utf8');
  if (text.length === 0) throw new Error(`${SUBAGENT_PROMPT} is empty`);
  if (Buffer.byteLength(text, 'utf8') > PROMPT_MAX) throw new Error(`${SUBAGENT_PROMPT} exceeds 16 KiB`);
  return text;
}
