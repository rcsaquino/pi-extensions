/** Stable codes for expected, recoverable failures. Unexpected errors pass through untouched. */
export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "duplicate_hot_content"
  | "hot_capacity"
  | "store_unavailable"
  | "hot_locked";

export type ErrorDetails = Record<string, unknown>;

export class ExpectedError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "ExpectedError";
    this.code = code;
    this.details = details;
  }
}

function record(error: unknown): { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown } {
  return error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
}

/** Extract the SQLite error code/string without losing the original message. */
export function sqliteInfo(error: unknown): { code?: string; errcode?: number; errstr?: string; message: string } {
  const value = record(error);
  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.errcode === "number" ? { errcode: value.errcode } : {}),
    ...(typeof value.errstr === "string" ? { errstr: value.errstr } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

/** True when an error came from the SQLite driver, including a closed connection. */
export function isSqliteError(error: unknown): boolean {
  const code = record(error).code;
  return typeof code === "string" && (code.startsWith("ERR_SQLITE") || code === "ERR_INVALID_STATE");
}

/** Classify a known database access failure. Passes through already classified errors. */
export function storeUnavailable(operation: string, path: string, error: unknown): ExpectedError {
  if (error instanceof ExpectedError) return error;
  const info = sqliteInfo(error);
  return new ExpectedError("store_unavailable", `SQLite is unavailable for ${operation} (${path}): ${info.message}`, {
    operation,
    path,
    sqlite: info,
  });
}
