import { describe, expect, test } from "bun:test";
import { createDb } from "@hec/db";
import { firstMessage, searchMessages } from "./keyword";

const database = process.env.DATABASE_URL;

describe.skipIf(!database)("keyword search against the database", () => {
  test("a phrase comes back in time order, without system lines", async () => {
    const sql = createDb(database, { max: 1 });
    try {
      const result = await searchMessages(sql, { text: "i love you", limit: 10 });
      expect(result.mode).toBe("phrase");
      expect(result.total).toBeGreaterThan(0);
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.every((hit) => hit.kind !== "system" && hit.kind !== "unsent")).toBe(true);
      expect(result.hits.every((hit) => hit.name.length > 0)).toBe(true);

      const times = result.hits.map((hit) => hit.sentAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));

      const earliest = result.hits[0];
      if (!earliest) throw new Error("expected a hit");
      const first = await firstMessage(sql, { text: "i love you" });
      expect(first.mode).toBe("phrase");
      expect(first.hit?.id).toBe(earliest.id);

      const byPerson = await searchMessages(sql, {
        text: "i love you",
        personId: earliest.personId,
        limit: 10,
      });
      expect(byPerson.hits.every((hit) => hit.personId === earliest.personId)).toBe(true);

      const before = await searchMessages(sql, { text: "i love you", until: earliest.sentAt, limit: 5 });
      expect(before.hits.every((hit) => hit.sentAt.getTime() < earliest.sentAt.getTime())).toBe(true);
    } finally {
      await sql.close();
    }
  });

  test("paging with the cursor returns every match exactly once, in order", async () => {
    const sql = createDb(database, { max: 1 });
    try {
      const first = await searchMessages(sql, { text: "i love you", limit: 100 });
      expect(first.mode).toBe("phrase");

      const seen: number[] = [];
      const times: number[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < 20; pages++) {
        const page = await searchMessages(sql, { text: "i love you", limit: 100, after });
        expect(page.total).toBe(first.total);
        for (const hit of page.hits) {
          seen.push(hit.id);
          times.push(hit.sentAt.getTime());
        }
        if (!page.next) break;
        after = page.next;
      }

      expect(seen.length).toBe(first.total);
      expect(new Set(seen).size).toBe(first.total);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    } finally {
      await sql.close();
    }
  });

  test("a one letter typo falls back to trigram, and nonsense matches nothing", async () => {
    const sql = createDb(database, { max: 1 });
    try {
      const typo = await searchMessages(sql, { text: "lovve", limit: 5 });
      expect(typo.mode).toBe("trigram");
      expect(typo.total).toBeGreaterThan(typo.hits.length);
      expect(typo.hits.length).toBeGreaterThan(0);

      const none = await searchMessages(sql, { text: "zzzzqqqqxxxxx" });
      expect(none).toEqual({ mode: "none", total: 0, hits: [], next: null });
    } finally {
      await sql.close();
    }
  });
});
