/** Expected, user-correctable failures. Unexpected filesystem errors pass through. */
export class WorkshopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkshopError";
  }
}

export function fail(message: string): never {
  throw new WorkshopError(message);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
