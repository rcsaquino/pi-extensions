import { randomUUID } from "node:crypto";
import { migrateRecords, persistRecords, readRecords } from "./delivery-ledger-storage.ts";
export { LEDGER_SLOTS, LEDGER_RECORD_BYTES, LEDGER_RETENTION_MS, LEDGER_BYTES } from "./delivery-ledger-storage.ts";
export const phases = ["task_captured", "notice_queued", "notice_suppressed", "report_submitted", "report_started", "generated", "settled", "cancelled", "suppressed", "send_attempt", "api_attempt", "api_ack", "api_rejected", "api_failed", "sent", "send_failed"] as const;
export const operations = ["reply", "warning", "attachment", "voice", "notice", "incoming", "service"] as const;
export const outcomes = ["not_applicable", "pending", "acknowledged", "rejected", "unknown", "suppressed"] as const;
export const reasons = ["foreign_input", "unowned_user_start", "custom_interruption", "context_revoked", "owner_session_or_allowlist_changed", "outcome_unknown", "navigation_or_shutdown", "route_expired", "queue_full", "start_failed", "start_watchdog", "voice_only", "empty_final", "agent_aborted", "agent_error", "local_refusal", "local_failure"] as const;
export const methods = ["sendMessage", "sendDocument", "sendPhoto", "sendVideo", "sendVoice", "sendMediaGroup", "getUpdates", "getMe", "getWebhookInfo", "deleteMyCommands", "sendChatAction", "getFile", "download", "transcribe", "generateSpeech", "other"] as const;
export const transportCodes = ["TG_TRANSPORT_CANCELLED", "TG_TRANSPORT_TIMEOUT", "TG_TRANSPORT_FAILED", "TG_TRANSPORT_RESPONSE"] as const;
export const causeCodes = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "unknown"] as const;
export type CauseCode = typeof causeCodes[number];
export interface DeliveryRecord {
  v: 1; at: number; event: string; writer?: string; sequence?: number; phase: typeof phases[number]; operation: typeof operations[number]; outcome: typeof outcomes[number];
  reply?: string; delivery?: string; parent?: string; notice?: string; task?: string; revision?: number;
  kind?: "eta" | "overdue" | "settled" | "unknown";
  status?: "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
  method?: typeof methods[number]; attempt?: number; chunk?: number; chunks?: number; album?: number;
  reason?: typeof reasons[number]; code?: typeof transportCodes[number]; cause?: CauseCode;
  rejection?: "rate_limit" | "authentication" | "access" | "conflict" | "other";
}
export type DeliveryContext = Pick<DeliveryRecord, "reply" | "delivery" | "parent" | "notice" | "task" | "revision" | "operation" | "kind" | "status">;
export type DeliveryEvent = Omit<DeliveryRecord, "v" | "at" | "event" | "writer" | "sequence">;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const taskId = /^bg-[a-f0-9]{12}$/;
const allowedKeys = new Set(["v", "at", "event", "writer", "sequence", "phase", "operation", "outcome", "reply", "delivery", "parent", "notice", "task", "revision", "kind", "status", "method", "attempt", "chunk", "chunks", "album", "reason", "code", "cause", "rejection"]);
const enums: Record<string, readonly string[]> = { phase: phases, operation: operations, outcome: outcomes, kind: ["eta", "overdue", "settled", "unknown"], status: ["completed", "failed", "cancelled", "interrupted", "unknown"], method: methods, reason: reasons, code: transportCodes, cause: causeCodes, rejection: ["rate_limit", "authentication", "access", "conflict", "other"] };
/** Strict projection is shared by writes and reads. Never stringify caller objects or raw exceptions. */
function record(value: unknown): DeliveryRecord {
  if (!value || typeof value !== "object") throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.has(key) || !("value" in descriptor)) throw new Error();
    const item = descriptor.value;
    if (item === undefined) continue;
    if (enums[key]) { if (typeof item !== "string" || !enums[key].includes(item)) throw new Error(); }
    else if (["reply", "delivery", "parent", "notice", "event", "writer"].includes(key)) { if (typeof item !== "string" || !uuid.test(item)) throw new Error(); }
    else if (key === "task") { if (typeof item !== "string" || !taskId.test(item)) throw new Error(); }
    else if (key === "v") { if (item !== 1) throw new Error(); }
    else if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0 || (!["at", "sequence"].includes(key) && item > 1_000_000)) throw new Error();
    out[key] = item;
  }
  for (const key of ["v", "at", "event", "phase", "operation", "outcome"]) if (!(key in out)) throw new Error();
  return out as unknown as DeliveryRecord;
}

/** Inspect only own data properties, at most eight causes. Getters/proxies fail closed; no messages/stacks/URLs. */
export function transportCause(error: unknown): CauseCode {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && error && (typeof error === "object" || typeof error === "function") && !seen.has(error); depth++) {
    seen.add(error);
    try {
      const code = Object.getOwnPropertyDescriptor(error, "code");
      if (code && "value" in code && typeof code.value === "string" && causeCodes.includes(code.value as CauseCode)) return code.value as CauseCode;
      const cause = Object.getOwnPropertyDescriptor(error, "cause");
      error = cause && "value" in cause ? cause.value : undefined;
    } catch { return "unknown"; }
  }
  return "unknown";
}

export interface LedgerQuery { task?: string; reply?: string; notice?: string; delivery?: string; limit?: number }
export interface LedgerView { state: "ok" | "missing" | "unavailable"; records: DeliveryRecord[]; skipped: number; truncated: boolean; auditComplete: false }
export async function readDeliveryLedger(path: string, query: LedgerQuery = {}, now = Date.now()): Promise<LedgerView> {
  const view: LedgerView = { state: "ok", records: [], skipped: 0, truncated: false, auditComplete: false };
  try {
    for (const key of ["task", "reply", "notice", "delivery"] as const) {
      const value = query[key]; if (value !== undefined && !(key === "task" ? taskId : uuid).test(value)) throw new Error();
    }
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error();
    const result = await readRecords(path, record, now);
    view.records = result.records.filter(item => !["task", "reply", "notice", "delivery"].some(key => query[key as keyof LedgerQuery] !== undefined && query[key as keyof LedgerQuery] !== item[key as keyof DeliveryRecord]));
    view.skipped = result.skipped;
    view.truncated = result.truncated || view.records.length > limit; view.records = view.records.slice(-limit);
  } catch (e) { view.state = (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable"; view.records = []; }
  return view;
}

/** Explicit operator-only offline migration; never called by a tool, reader or live writer. */
export async function migrateDeliveryLedger(path: string, options: { writersStopped: true; now?: number }): Promise<{ retained: number; removed: number }> {
  return migrateRecords(path, record, options);
}

/** Best effort bounded JSONL. Private ledger lock only, never delivery authority or a global lock. */
export class DeliveryLedger {
  private writes: Promise<void> = Promise.resolve();
  private pending = 0;
  private queued: DeliveryRecord[] = [];
  private running = false;
  private sequence = 0;
  private writer = randomUUID();
  dropped = 0;
  constructor(readonly path: string) {}
  append(event: DeliveryEvent): Promise<void> {
    let item: DeliveryRecord;
    try {
      // Do not invoke getters while constructing the closed projection.
      item = record(Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(event),
        v: { value: 1 }, at: { value: Date.now() }, event: { value: randomUUID() }, writer: { value: this.writer }, sequence: { value: ++this.sequence },
      }));
    }
    catch { this.dropped++; return Promise.resolve(); }
    if (this.pending >= 256) { this.dropped++; return Promise.resolve(); }
    this.pending++; this.queued.push(item);
    if (!this.running) {
      this.running = true;
      this.writes = Promise.resolve().then(() => this.drain());
    }
    return this.budget(this.writes);
  }
  private budget(task: Promise<void>, milliseconds = 50): Promise<void> {
    return new Promise(done => {
      const timer = setTimeout(done, milliseconds);
      void task.then(() => { clearTimeout(timer); done(); }, () => { clearTimeout(timer); done(); });
    });
  }
  async flush(milliseconds = 50): Promise<void> { await this.budget(this.writes, milliseconds); }
  get pendingWrites(): number { return this.pending; }
  private async drain(): Promise<void> {
    while (this.queued.length) {
      // Batch observations already waiting during I/O, sharing one descriptor/lock/sync cycle.
      // The pending cap includes both this batch and everything still queued.
      const batch = this.queued.splice(0);
      try { await this.persist(batch); } catch { this.dropped += batch.length; }
      finally { this.pending -= batch.length; }
    }
    this.running = false;
  }
  private async persist(batch: DeliveryRecord[]): Promise<void> {
    await persistRecords(this.path, batch, record);
  }
}
