import { describe, expect, test } from "bun:test";
import { splitChunks } from "./split";

describe("splitChunks", () => {
  test("returns nothing for an empty session", () => {
    expect(splitChunks([])).toEqual([]);
  });

  test("keeps a short session as one chunk", () => {
    const chunks = splitChunks([
      { id: 4, line: "a" },
      { id: 9, line: "b" },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ position: 0, firstMessageId: 4, lastMessageId: 9, messageCount: 2 });
    expect(chunks[0]?.transcript).toBe("a\nb");
  });

  test("overlaps the next chunk and still moves forward", () => {
    const lines = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, line: "x".repeat(10) }));
    const chunks = splitChunks(lines, { maxChars: 25, maxMessages: 10, overlap: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.lastMessageId).toBe(2);
    expect(chunks[1]?.firstMessageId).toBe(2);
    expect(chunks.at(-1)?.lastMessageId).toBe(5);
  });
});
