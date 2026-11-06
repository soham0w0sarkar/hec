/**
 * Runs `handler` over `items` with at most `workers` in flight. Each item goes to exactly one
 * worker. Every worker finishes before an error is rethrown.
 */
export async function runPool<T, R>(
  items: T[],
  workers: number,
  handler: (item: T, worker: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const count = Math.max(1, Math.min(Math.floor(workers), items.length));
  let next = 0;

  const settled = await Promise.allSettled(
    Array.from({ length: count }, async (_, worker) => {
      while (next < items.length) {
        const index = next++;
        results[index] = await handler(items[index] as T, worker + 1);
      }
    }),
  );

  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}
