const time = ms => ms === null || ms === undefined ? 'unknown' : `${(ms / 1000).toFixed(3)}s`;
export function formatReport(action, value) {
  if (action === 'status') return `Latency analytics: ${value.collector?.state || 'ready'}\nCoverage: Pi lifecycle only; Telegram transport is unmeasured.\nTraces: ${value.traces ?? 'unknown'}; spans: ${value.spans ?? 'unknown'}; dropped records: ${Math.max(value.dropped_records || 0, value.collector?.dropped_records || 0)}`;
  if (!value.length) return 'No completed matching Pi activity has been recorded yet.';
  return value.map(trace => {
    const lines = [
      `Pi activity: ${time(trace.duration_ms)} (${trace.status})`,
      `Trace: ${trace.trace_id}`,
      `Observed input(s): ${trace.input_count}; boundaries: ${trace.complete ? 'complete' : 'incomplete'}`,
    ];
    if (trace.phase_totals_ms) {
      const p = trace.phase_totals_ms;
      lines.push(`Preparation ${time(p.pre_agent)}; model ${time(p.model)}; tools ${time(p.tool)}`);
      lines.push(`Compaction ${time(p.compaction)}; UI wait ${time(p.ui_wait)}; unattributed ${time(p.unattributed)}`);
    }
    for (const tool of trace.tools) lines.push(`Tool ${tool.name}: ${tool.calls} call(s), ${time(tool.work_ms)} work (may overlap), ${tool.errors} error(s)`);
    if (action === 'trace') {
      for (const span of (trace.spans || []).slice(0, 50)) lines.push(`Span ${span.kind}/${span.name}: ${time(span.start_ms)} -> ${time(span.end_ms)}, ${span.status}${span.parent_span_id ? ' (nested)' : ''}`);
      if (trace.details_truncated || (trace.spans || []).length > 50) lines.push('Detail display is truncated; the read-only query tool provides additional bounded detail.');
    }
    for (const caveat of trace.caveats) lines.push(`Note: ${caveat}`);
    return lines.join('\n');
  }).join('\n\n');
}
