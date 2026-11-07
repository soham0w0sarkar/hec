import { describe, expect, test } from "bun:test";
import type { MessageSource, PersonId } from "@hec/core";
import { DEDUPE_WINDOW_MS, withoutDuplicates } from "./dedupe";
import type { ResolvedMessage } from "./resolve";

function row(text: string, minute: number, source: MessageSource = "instagram", personId: PersonId = "person_1"): ResolvedMessage {
  return {
    personId,
    senderRaw: personId,
    text,
    sentAt: new Date(Date.UTC(2026, 0, 1, 0, minute)),
    source,
    sourceRef: `${source}:${minute}`,
    kind: "text",
    extras: {},
  };
}

describe("withoutDuplicates", () => {
  test("skips a copy already stored from the same app, and keeps empty text", () => {
    const incoming = [row("hello", 3), row("hello", 4), row("", 5), row("", 5)];
    expect(withoutDuplicates(incoming, [row("hello", 2)])).toHaveLength(2);
  });

  test("keeps a repeated line when nothing stored matches it", () => {
    expect(withoutDuplicates([row("photo", 1), row("photo", 2)], [])).toHaveLength(2);
  });

  test("skips a copy the other app already stored, whichever is earlier", () => {
    const storedLater = [row("hello", 6, "whatsapp")];
    const storedEarlier = [row("hello", 1, "whatsapp")];
    expect(withoutDuplicates([row("hello", 3)], storedLater)).toHaveLength(0);
    expect(withoutDuplicates([row("hello", 3)], storedEarlier)).toHaveLength(0);
  });

  test("ignores surrounding whitespace", () => {
    expect(withoutDuplicates([row("hello\n", 3)], [row("  hello", 3, "whatsapp")])).toHaveLength(0);
  });

  test("keeps it when the other copy is outside the window or from the other person", () => {
    const farMinute = 3 + DEDUPE_WINDOW_MS / 60_000 + 1;
    expect(withoutDuplicates([row("hello", 3)], [row("hello", farMinute, "whatsapp")])).toHaveLength(1);
    expect(withoutDuplicates([row("hello", 3)], [row("hello", 3, "whatsapp", "person_2")])).toHaveLength(1);
  });
});
