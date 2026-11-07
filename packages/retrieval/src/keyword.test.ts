import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { cacheKey, memoryRetrievalCache } from "./cache";
import { fuseByRank } from "./hybrid";
import { RetrievalError } from "./errors";
import { assertLocalTestDatabase } from "./guard";
import { encodeCursor, pageStatement, parseCursor, prepareSearch } from "./keyword";
import { walkStreaks } from "./stats";
import { formatIst, istDayKey, istDayStart } from "./time";

const HOSTED = "postgresql://postgres.example:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres";

describe("local database guard", () => {
  test("refuses a hosted database and a local database that is not a test database", () => {
    expect(() => assertLocalTestDatabase(HOSTED)).toThrow(RetrievalError);
    expect(() => assertLocalTestDatabase("postgres://postgres@127.0.0.1:5432/hec")).toThrow(/test/);
    expect(() => assertLocalTestDatabase("not a url")).toThrow(RetrievalError);
  });

  test("accepts localhost when the database name contains test", () => {
    expect(() => assertLocalTestDatabase("postgres://postgres@127.0.0.1:55432/hec_retrieval_test")).not.toThrow();
    expect(() => assertLocalTestDatabase("postgres://postgres@localhost:5432/retrieval_test")).not.toThrow();
  });

  test("the database suite never reads DATABASE_URL", () => {
    const source = readFileSync(new URL("./db.test.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\.env\.DATABASE_URL\b/);
    expect(source).toContain("RETRIEVAL_TEST_DATABASE_URL");
    expect(source).toContain("assertLocalTestDatabase");
  });
});

describe("display time", () => {
  test("23:50 IST stays on that calendar day", () => {
    const late = new Date("2030-06-01T18:20:00.000Z");
    expect(formatIst(late)).toBe("2030-06-01 23:50:00");
    expect(istDayKey(late)).toBe("2030-06-01");
    const nextDay = istDayStart("2030-06-02");
    expect(nextDay.toISOString()).toBe("2030-06-01T18:30:00.000Z");
    expect(late.getTime()).toBeLessThan(nextDay.getTime());
    expect(istDayKey(new Date("2030-06-01T18:40:00.000Z"))).toBe("2030-06-02");
  });

  test("rejects a day that is not real", () => {
    expect(() => istDayStart("2030-02-31")).toThrow(RetrievalError);
    expect(() => istDayStart("June 1")).toThrow(RetrievalError);
  });
});

describe("search input", () => {
  test("puts hostile text in parameters and not in the SQL", () => {
    const hostile = `a' & !b | (c:* <-> \\\\d) "e"`;
    const statement = pageStatement(prepareSearch({ text: hostile, mode: "phrase" }));
    expect(statement.sql).not.toContain(hostile);
    expect(statement.sql).not.toContain("'english'");
    expect(statement.sql).toContain("search_tsquery");
    expect(statement.sql).toContain("'phrase'");
    expect(statement.params).toContainEqual([hostile]);
  });

  test("rejects an empty query, a huge query, a bad limit, and an inverted range", () => {
    expect(() => prepareSearch({ text: "   ", mode: "phrase" })).toThrow(/empty/);
    expect(() => prepareSearch({ text: "x".repeat(301), mode: "phrase" })).toThrow(/too long/);
    expect(() => prepareSearch({ text: "love", mode: "phrase", limit: 0 })).toThrow(/limit/);
    expect(() => prepareSearch({ text: "love", mode: "phrase", limit: 101 })).toThrow(/limit/);
    expect(() => prepareSearch({ text: "love", mode: "phrase", personId: "nobody" as "person_1" })).toThrow(/person/);
    expect(() =>
      prepareSearch({ text: "love", mode: "any_word", from: new Date("2030-02-01"), until: new Date("2030-01-01") }),
    ).toThrow(/from is after until/);
    expect(() => prepareSearch({ text: "love", mode: "nope" as "phrase" })).toThrow(/mode/);
  });

  test("keeps caller variants and drops blanks and duplicates", () => {
    const query = prepareSearch({ text: "love", mode: "phrase", variants: [" love ", "", "LUV", "luv"] });
    expect(query.texts).toEqual(["love", "LUV"]);
    expect(query.kinds).toEqual(["text", "media", "call", "share"]);
    expect(query.includeEmpty).toBe(false);
  });
});

describe("cursor", () => {
  test("round-trips a source ref that contains a bar and a quote", () => {
    const sentAt = new Date("2030-06-01T18:20:00.000Z");
    const cursor = parseCursor(encodeCursor({ sentAt, source: "whatsapp", sourceRef: `file|1"\\` }));
    expect(cursor.sentAt.toISOString()).toBe(sentAt.toISOString());
    expect(cursor.source).toBe("whatsapp");
    expect(cursor.sourceRef).toBe(`file|1"\\`);
  });

  test("rejects a cursor it cannot read", () => {
    expect(() => parseCursor("not-a-cursor")).toThrow(/cursor/);
    expect(() => prepareSearch({ text: "love", mode: "phrase", after: "%%%" })).toThrow(/cursor/);
  });
});

describe("fusion and streaks", () => {
  test("a hit found both ways outranks a hit found once", () => {
    const fused = fuseByRank([
      { via: "keyword", weight: 1, ranked: [{ key: "m:1", rank: 1 }, { key: "m:2", rank: 2 }] },
      { via: "vector", weight: 1, ranked: [{ key: "m:2", rank: 1 }, { key: "c:9", rank: 2 }] },
    ]);
    expect(fused[0]?.key).toBe("m:2");
    expect(fused[0]?.via).toEqual(["keyword", "vector"]);
    expect(fused.map((row) => row.key)).toEqual(["m:2", "m:1", "c:9"]);
  });

  test("a gap ends a streak", () => {
    const streaks = walkStreaks(["2030-06-01", "2030-06-02", "2030-06-03", "2030-06-05"]);
    expect(streaks.longest).toBe(3);
    expect(streaks.current).toBe(1);
    expect(streaks.longestFrom).toBe("2030-06-01");
    expect(streaks.longestUntil).toBe("2030-06-03");
  });
});

describe("cache key", () => {
  test("changes when the data version or the query changes", () => {
    const first = cacheKey(1, "search", { text: "love" });
    expect(cacheKey(2, "search", { text: "love" })).not.toBe(first);
    expect(cacheKey(1, "search", { text: "luv" })).not.toBe(first);
    expect(cacheKey(1, "search", { text: "love" })).toBe(first);
    const cache = memoryRetrievalCache();
    expect(cache.reads).toBe(0);
  });
});
