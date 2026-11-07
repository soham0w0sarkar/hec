import { describe, expect, test } from "bun:test";
import { COUNTED_MESSAGE_KINDS } from "@hec/core";
import { encodeCursor, normalize, parseCursor } from "./keyword";

describe("normalize", () => {
  test("trims the text and treats several words as a phrase", () => {
    const query = normalize({ text: "  i love you  " });
    expect(query.text).toBe("i love you");
    expect(query.phrase).toBe(true);
    expect(query.order).toBe("asc");
    expect(query.limit).toBe(20);
    expect(query.kinds).toEqual([...COUNTED_MESSAGE_KINDS]);
    expect(query.after).toBeNull();
  });

  test("a single word stays an and-query unless phrase is forced", () => {
    expect(normalize({ text: "love" }).phrase).toBe(false);
    expect(normalize({ text: "love", phrase: true }).phrase).toBe(true);
    expect(normalize({ text: "i love you", phrase: false }).phrase).toBe(false);
  });

  test("rejects an empty query, a bad limit, an unknown person, and an inverted range", () => {
    expect(() => normalize({ text: "   " })).toThrow(/empty/);
    expect(() => normalize({ text: "love", limit: 0 })).toThrow(/limit/);
    expect(() => normalize({ text: "love", limit: 101 })).toThrow(/limit/);
    expect(() => normalize({ text: "love", personId: "nobody" as "person_1" })).toThrow(/person/);
    expect(() =>
      normalize({ text: "love", from: new Date("2026-02-01"), until: new Date("2026-01-01") }),
    ).toThrow(/from is after until/);
  });

  test("rejects a cursor it cannot read", () => {
    expect(() => normalize({ text: "love", after: "not-a-cursor" })).toThrow(/cursor/);
  });
});

describe("cursor", () => {
  test("round-trips the time and id", () => {
    const sentAt = new Date("2026-02-23T10:11:49.682Z");
    const cursor = parseCursor(encodeCursor({ sentAt, id: 312455 }));
    expect(cursor.sentAt.getTime()).toBe(sentAt.getTime());
    expect(cursor.id).toBe(312455);
  });

  test("rejects a bad time or id", () => {
    expect(() => parseCursor("2026-02-23T10:11:49.682Z|0")).toThrow(/cursor/);
    expect(() => parseCursor("nope|12")).toThrow(/cursor/);
    expect(() => parseCursor("2026-02-23T10:11:49.682Z|1.5")).toThrow(/cursor/);
  });
});
