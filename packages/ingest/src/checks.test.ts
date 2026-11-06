import { describe, expect, test } from "bun:test";
import { assertNoLargeReversal, assertNotFuture, smallReversals } from "./checks";
import type { ParsedMessage } from "./types";

function message(minute: number): ParsedMessage {
  return {
    senderRaw: "Contact A",
    sentAt: new Date(Date.UTC(2026, 6, 4, 12, minute)),
    text: "x",
    source: "whatsapp",
    sourceRef: `_chat.txt:${minute}-${minute}`,
    kind: "text",
    extras: {},
  };
}

describe("date checks", () => {
  test("a short inversion is a warning", () => {
    const later = message(60);
    const earlier = message(13);
    expect(smallReversals([later, earlier], "_chat.txt")).toHaveLength(1);
    expect(() => assertNoLargeReversal([later, earlier], "_chat.txt")).not.toThrow();
  });

  test("a jump of more than a day fails", () => {
    const first = message(0);
    const wayEarlier = { ...message(0), sentAt: new Date(first.sentAt.getTime() - 2 * 24 * 60 * 60 * 1000) };
    expect(() => assertNoLargeReversal([first, wayEarlier], "_chat.txt")).toThrow(/more than a day/);
  });

  test("a future timestamp fails", () => {
    const future = { ...message(0), sentAt: new Date(Date.UTC(2099, 0, 1)) };
    expect(() => assertNotFuture([future], new Date(Date.UTC(2026, 10, 7)), "_chat.txt")).toThrow(/future/);
  });
});
