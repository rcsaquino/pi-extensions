/** Serialize async read-check-write operations per run key within this process. */
export function createRunLock() {
  const tails = new Map<string, Promise<void>>();
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
