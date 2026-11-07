/** Serialize async read-check-write operations per run key within this process. */
export function createRunLock() {
  const tails = new Map<string, Promise<void>>();
  // shortcut: one Pi process per parent session; add a lock file if two processes ever share a run directory.
  return function withRunLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    return previous.then(async () => {
      try {
        return await operation();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    });
  };
}
