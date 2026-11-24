// Session handoff after an idle compaction. The old session keeps its full
// history; the replacement starts with the summary and the retained tail.

const OMITTED_ROLES = new Set(['system', 'compactionSummary', 'branchSummary']);

export function captureCompaction(entry, ctx) {
  return {
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
    details: entry.details,
    usage: entry.usage,
    parentSession: ctx.sessionManager.getSessionFile(),
  };
}

export function compactedTail(ctx) {
  return ctx.sessionManager.buildSessionContext().messages.filter(message => {
    if (!message || typeof message !== 'object') return false;
    if (OMITTED_ROLES.has(message.role)) return false;
    if (message.role === 'bashExecution' && message.excludeFromContext) return false;
    return true;
  });
}

export function seedCompactedSession(sessionManager, rotation, tail) {
  // A null boundary keeps every message appended after the summary.
  sessionManager.appendCompaction(rotation.summary, null, rotation.tokensBefore,
    rotation.details, false, rotation.usage);
  for (const message of tail) sessionManager.appendMessage(message);
}
