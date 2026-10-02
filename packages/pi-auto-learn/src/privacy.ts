export function containsSecret(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]{10,})\b|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret|authorization)\s*[:=]\s*["']?[^\s"']{8,}|\bBearer\s+[a-zA-Z0-9._-]{12,}/i.test(text);
}
export function sensitiveRecord(text: string): boolean {
  const clinical = /\b(?:surgical|operative|patients?|diagnosis|census|cases?\s+(?:for\s+)?tomorrow)\b/i.test(text);
  const rows = /\b\d{1,3}\s*(?:\/|-|\s)\s*(?:M|F|male|female)\b/i.test(text) || (text.match(/(?:^|\n)\s*\d+[.)]\s+[A-Za-z]/g)?.length ?? 0) >= 2;
  return (clinical && rows) || /\b(?:patient(?:\s+name|\s+id)?|medical record|MRN|date of birth|DOB|census|passport|social security)\s*[:=]|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:\+\d[\d ()-]{8,}\d)|\b(?:\d[ -]?){13,19}\b/i.test(text);
}
export function safeExcerpt(text: string, limit = 6000): string | undefined {
  if (containsSecret(text) || sensitiveRecord(text)) return undefined;
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '[omitted]').slice(0, limit).trim();
}
export function displaySafe(text: string, limit = 20_000): string {
  if (containsSecret(text) || sensitiveRecord(text)) return '[sensitive content omitted]';
  return text.slice(0, limit);
}
export function riskyAddition(before: string, after: string): boolean {
  const prior = new Set(before.split('\n'));
  const added = after.split('\n').filter(line => !prior.has(line)).join('\n');
  return /\bsudo\b|\brm\s+-[^\n]*r|curl[^\n]*\|\s*(?:ba)?sh|chmod\s+777|ignore (?:all |previous )?(?:safety|system|permission)|\b(?:send|upload|post|exfiltrate)\b[^\n]{0,100}\b(?:transcript|conversation|token|secret|credential|patient|private)\b|\b(?:dosage|administer|diagnostic criteria|billing code|case rate|ICD[- ]?10|PhilHealth|RVS)\b/i.test(added);
}
