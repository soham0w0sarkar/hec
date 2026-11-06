import { describe, expect, test } from "bun:test";
import { runPool } from "./pool";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runPool", () => {
  test("gives every item to exactly one worker and caps concurrency", async () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const handledBy = new Map<number, number[]>();
    let running = 0;
    let peak = 0;

    const results = await runPool(items, 4, async (item, worker) => {
      running += 1;
      peak = Math.max(peak, running);
      handledBy.set(item, [...(handledBy.get(item) ?? []), worker]);
      await tick(item % 3);
      running -= 1;
      return item * 2;
    });

    expect(results).toEqual(items.map((item) => item * 2));
    expect([...handledBy.values()].every((workers) => workers.length === 1)).toBe(true);
    expect(peak).toBe(4);
    expect(new Set([...handledBy.values()].flat())).toEqual(new Set([1, 2, 3, 4]));
  });

  test("lets the other workers finish before rethrowing", async () => {
    const done: number[] = [];
    const run = runPool([1, 2, 3, 4], 2, async (item) => {
      await tick(item);
      if (item === 1) throw new Error("boom");
      done.push(item);
      return item;
    });

    await expect(run).rejects.toThrow("boom");
    expect(done.sort()).toEqual([2, 3, 4]);
  });

  test("handles more workers than items, and no items", async () => {
    expect(await runPool([7], 8, async (item) => item)).toEqual([7]);
    expect(await runPool([], 4, async (item: number) => item)).toEqual([]);
  });
});
