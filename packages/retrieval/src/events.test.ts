import { describe, expect, test } from "bun:test";
import { RetrievalError } from "./errors";
import { encodeEventCursor, eventStatement, parseEventCursor, prepareEventList } from "./events";

describe("listEvents input", () => {
  test("keeps the category in a parameter and only reads approved or edited rows", () => {
    const statement = eventStatement(prepareEventList({ category: "Conflict", limit: 10 }));
    expect(statement.sql).toContain("e.status in ('approved', 'edited')");
    expect(statement.sql).not.toContain("Conflict");
    expect(statement.params[0]).toBe("Conflict");
    expect(statement.params[5]).toBe(11);
  });

  test("rejects a limit above the cap, an unknown category, and a reversed range", () => {
    expect(() => prepareEventList({ limit: 101 })).toThrow(RetrievalError);
    expect(() => prepareEventList({ category: "Gossip" as "Conflict" })).toThrow(/category/);
    const from = new Date("2030-06-02T00:00:00.000Z");
    const until = new Date("2030-06-01T00:00:00.000Z");
    expect(() => prepareEventList({ from, until })).toThrow(/from is after until/);
  });

  test("round-trips a cursor and rejects a broken one", () => {
    const occurredAt = new Date("2030-06-01T04:30:00.000Z");
    const cursor = encodeEventCursor({ occurredAt, id: 4 });
    expect(parseEventCursor(cursor)).toEqual({ occurredAt, id: 4 });
    expect(() => parseEventCursor("not-a-cursor")).toThrow(RetrievalError);
  });
});
