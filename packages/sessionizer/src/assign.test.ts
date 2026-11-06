import { describe, expect, test } from "bun:test";
import { assignmentSlices, type Assignment } from "./assign";

function rows(count: number, sessionId = 1): Assignment[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, sessionId }));
}

describe("assignmentSlices", () => {
  test("keeps each message with its session and splits on the batch size", () => {
    const slices = assignmentSlices(
      [
        { id: 10, sessionId: 1 },
        { id: 11, sessionId: 1 },
        { id: 20, sessionId: 2 },
      ],
      2,
    );

    expect(slices.map((slice) => slice.rows)).toEqual([
      [
        { id: 10, session_id: 1 },
        { id: 11, session_id: 1 },
      ],
      [{ id: 20, session_id: 2 }],
    ]);
    expect(new Set(slices.map((slice) => slice.key)).size).toBe(2);
  });

  test("returns nothing for no assignments, and one slice when the batch is exact", () => {
    expect(assignmentSlices([], 2)).toEqual([]);
    const slices = assignmentSlices(rows(4), 4);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.rows).toHaveLength(4);
  });

  test("uses a key that depends only on the message ids in the slice", () => {
    const first = assignmentSlices([{ id: 7, sessionId: 1 }], 10);
    const sameIds = assignmentSlices([{ id: 7, sessionId: 99 }], 10);
    const otherIds = assignmentSlices([{ id: 8, sessionId: 1 }], 10);

    expect(first[0]?.key).toBe(sameIds[0]?.key);
    expect(first[0]?.key).not.toBe(otherIds[0]?.key);
  });

  test("rejects a batch size below 1", () => {
    expect(() => assignmentSlices(rows(1), 0)).toThrow();
  });
});
