import type { RunMeta } from "./store.ts";
import { formatDuration } from "./store.ts";

export const NOTICE_EXCERPT = 1200;
export const DEFAULT_ETA_MINUTES = 10;

/** Explicit kills settle silently; every other settled run still reports. */
export function shouldNotify(meta: Pick<RunMeta, "status">): boolean {
  return meta.status !== "killed";
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}\n[truncated]`;
}

export type ReminderState = "none" | "remind" | "missing";

/** What a running task is owed right now: nothing, a reminder, or an ETA error. */
export function reminderState(
  meta: Pick<RunMeta, "status" | "startedAt" | "etaMinutes" | "etaFrom" | "reminders" | "lastReminderAt" | "etaPending">,
  now = Date.now(),
): ReminderState {
  if (meta.status !== "running") return "none";
  const eta = meta.etaMinutes;
  if (!eta || !Number.isFinite(eta) || eta <= 0) return "none";
  const base = Date.parse(meta.etaFrom ?? meta.startedAt);
  if (!Number.isFinite(base) || now < base + eta * 60_000) return "none";
  const sent = meta.reminders ?? 0;
  if (sent === 0) return "remind";
  const last = meta.lastReminderAt ? Date.parse(meta.lastReminderAt) : NaN;
  if (!Number.isFinite(last)) return "remind";
  if (now - last < eta * 60_000) return "none";
  // A reminder that was never answered is a failure, not another reminder.
  return meta.etaPending ? "missing" : "remind";
}

/** Facts only. Wording and voice belong to the agent, not to the transport. */
export function buildEtaReminder(meta: RunMeta): string {
  const eta = meta.etaMinutes ?? DEFAULT_ETA_MINUTES;
  return [
    "[Background task still running]",
    `Title: ${meta.title}`,
    `Run: ${meta.id}`,
    "The report file stays empty until the run ends.",
    "",
    `Task exceeded its ${eta}m ETA. Tell the user. Record the new estimate with background_eta(${JSON.stringify(meta.id)}, eta_minutes) so the next check follows it.`,
  ].join("\n");
}

/** Raised when a reminder turn ended without recording a revised estimate. */
export function buildEtaMissing(meta: RunMeta): string {
  const eta = meta.etaMinutes ?? DEFAULT_ETA_MINUTES;
  return [
    "[Background task ETA missing]",
    "Error: no revised estimate was recorded after the last reminder.",
    `Title: ${meta.title}`,
    `Run: ${meta.id}`,
    "",
    `Task exceeded its ${eta}m ETA. Record one with background_eta(${JSON.stringify(meta.id)}, eta_minutes), or kill the run with background_kill.`,
  ].join("\n");
}

export function buildNotice(meta: RunMeta, report: string | undefined): string {
  const status = meta.status === "running" ? "unknown" : meta.status;
  const lines = [
    "[Background task finished]",
    `Title: ${meta.title}`,
    `Run: ${meta.id}`,
    `Status: ${status}${meta.exitCode === null || meta.exitCode === undefined ? "" : ` (exit ${meta.exitCode})`}`,
    `Duration: ${formatDuration(meta.startedAt, meta.finishedAt)}`,
    `Working directory: ${meta.cwd}`,
  ];
  const body = report?.trim();
  if (body) {
    lines.push("Report excerpt:", "---", truncate(body, NOTICE_EXCERPT), "---");
  } else {
    lines.push("The worker produced no report output. Read the log with background_result.");
  }
  lines.push(`Full report: background_result("${meta.id}")`);
  return lines.join("\n");
}
