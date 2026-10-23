import { readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fail } from "./errors.ts";

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MAX_SKILL_BYTES = 40_000;
export const MAX_SUPPORT_BYTES = 256 * 1024;
export const KEEP_VERSIONS = 10;
export const KEEP_CHANGES = 500;
export const IDLE_DAYS = 30;
export const SUPPORT_DIRS = ["references", "templates", "scripts", "assets"] as const;
export const VERSION_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
export const CHANGE_ID_RE = /^[0-9a-f]{12}$/;

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
];

/** Python's splitlines() drops one trailing empty line; this keeps parity. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};
  const meta: Record<string, string> = {};
  for (const line of splitLines(text.slice(4, end))) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return meta;
}

export function bodyOf(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  return end === -1 ? text : text.slice(end + 4);
}

export function secretLines(text: string): number[] {
  const found: number[] = [];
  for (const [index, line] of splitLines(text).entries()) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(line))) found.push(index + 1);
  }
  return found;
}

export interface ValidationResult {
  errors: string[];
  advisories: string[];
}

export function validate(name: string, text: string): ValidationResult {
  const errors: string[] = [];
  const advisories: string[] = [];
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) errors.push(`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`);
  const meta = parseFrontmatter(text);
  if (Object.keys(meta).length === 0) errors.push("missing YAML frontmatter");
  if (meta.name !== name) {
    errors.push(`frontmatter name '${meta.name ?? ""}' does not match directory '${name}'`);
  }
  const description = meta.description ?? "";
  if (!description) {
    errors.push("missing description");
  } else {
    const bytes = Buffer.byteLength(description);
    if (bytes > 1024) errors.push("description exceeds 1024 bytes");
    else if (bytes > 160) advisories.push(`description is ${bytes} bytes; aim for about 160`);
    if (description.toLowerCase().startsWith("this skill")) {
      advisories.push("description opens with 'This skill'; lead with the trigger instead");
    }
  }
  const body = bodyOf(text);
  if (splitLines(body).length > 250) {
    advisories.push("body exceeds 250 lines; consider splitting reference material out");
  }
  if (/^(?:updated|changelog|version)\s*:/im.test(body)) {
    advisories.push("body contains update notes or dates; history belongs in the change feed");
  }
  for (const line of secretLines(text)) errors.push(`possible literal secret at line ${line}`);
  return { errors, advisories };
}

/** Support-file paths only. SKILL.md uses the full validation path. */
export function safeRel(rel: string): string {
  const parts = rel.split(/[\\/]/);
  if (isAbsolute(rel) || parts.includes("..")) fail(`unsafe path: ${rel}`);
  const normalized = normalize(rel);
  if (normalized === "." || normalized === "" || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    fail(`unsafe path: ${rel}`);
  }
  const components = normalized.split(sep);
  const first = components[0];
  if (!first || !(SUPPORT_DIRS as readonly string[]).includes(first)) {
    fail(`support files must live under ${SUPPORT_DIRS.join("/, ")}/`);
  }
  if (basename(normalized) === "SKILL.md") fail("use write_file for SKILL.md");
  return normalized;
}

/** Detect symlinks, nested SKILL.md files and literal secrets in a skill tree. */
export function scanTree(path: string, root: string, skillRoot: string = path): string[] {
  const problems: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const item = join(path, entry.name);
    const display = relative(root, item);
    if (entry.isSymbolicLink()) {
      problems.push(`symlink refused: ${display}`);
      continue;
    }
    if (entry.isDirectory()) {
      problems.push(...scanTree(item, root, skillRoot));
      continue;
    }
    if (!entry.isFile()) continue;
    if (basename(item) === "SKILL.md" && path !== skillRoot) {
      problems.push(`nested SKILL.md: ${display}`);
    }
    let text: string;
    try {
      text = readFileSync(item, "utf8");
    } catch {
      continue;
    }
    for (const line of secretLines(text)) {
      problems.push(`possible literal secret: ${display}:${line}`);
    }
  }
  return problems;
}

export function requireName(name: string): string {
  if (!NAME_RE.test(name)) {
    fail("name must be 1-63 lowercase letters, digits or hyphens, starting alphanumeric");
  }
  return name;
}

export function requireVersion(version: string): string {
  if (!VERSION_RE.test(version)) fail(`invalid version id: '${version}'`);
  return version;
}

export function requireChangeId(changeId: string): string {
  if (!CHANGE_ID_RE.test(changeId)) fail(`invalid change id: '${changeId}'`);
  return changeId;
}
