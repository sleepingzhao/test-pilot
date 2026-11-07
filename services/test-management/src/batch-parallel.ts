/** Concurrency for multi-test regression (default 2, clamped 1–4). */
export function maxParallelFromEnv(): number {
  const raw = process.env.TESTPILOT_MAX_PARALLEL?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 2;
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(4, Math.max(1, parsed));
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** Serializes work sharing one remote session (the pilot logs in with one account). */
export function createMutex() {
  let tail: Promise<void> = Promise.resolve();
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
