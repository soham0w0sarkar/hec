import { describe, expect, test } from "bun:test";
import { checkFirsts, type FirstLookup } from "./firsts";
import type { MergedCandidate } from "./merge";
import { candidate } from "./test-helpers";
import { parseLocal } from "./time";

const at = (value: string) => parseLocal(value)!.instant;

function merged(overrides: Parameters<typeof candidate>[0] = {}): MergedCandidate {
  return { ...candidate(overrides), sessionIds: [1], mergedFrom: 1, firstCheck: null };
}

function lookupFrom(table: Record<string, { messageId: number; sentAt: Date } | null>): FirstLookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = async ({ text }: { text: string }) => {
    calls.push(text);
    return table[text] ?? null;
  };
  return Object.assign(fn, { calls });
}

describe("checkFirsts", () => {
  test("events that never claimed a first are untouched and cause no search", async () => {
    const lookup = lookupFrom({});
    const input = [merged()];
    const [out] = await checkFirsts(input, lookup);
    expect(out).toBe(input[0]!);
    expect(lookup.calls).toEqual([]);
  });

  test("verified when the earliest match is in the event's own evidence", async () => {
    const lookup = lookupFrom({ "i love you": { messageId: 1, sentAt: at("2030-01-05 18:00") } });
    const [out] = await checkFirsts([merged({ isFirst: true, firstOf: "I love you" })], lookup);
    expect(out?.isFirst).toBe(true);
    expect(out?.firstCheck).toBe("verified");
    expect(lookup.calls).toEqual(["i love you"]);
  });

  test("refuted when an earlier message matches, well before the evidence", async () => {
    const lookup = lookupFrom({ "i love you": { messageId: 900, sentAt: at("2029-06-01 10:00") } });
    const [out] = await checkFirsts([merged({ isFirst: true, firstOf: "i love you" })], lookup);
    expect(out?.isFirst).toBe(false);
    expect(out?.firstCheck).toBe("refuted");
  });

  test("an earlier match within the tolerance still counts as verified", async () => {
    const lookup = lookupFrom({ cafe: { messageId: 900, sentAt: at("2030-01-05 08:00") } });
    const [out] = await checkFirsts([merged({ isFirst: true, firstOf: "cafe" })], lookup);
    expect(out?.firstCheck).toBe("verified");
  });

  test("unverified when nothing matches or there are no search words", async () => {
    const lookup = lookupFrom({});
    const out = await checkFirsts(
      [merged({ isFirst: true, firstOf: "nothing" }), merged({ isFirst: true, firstOf: null, evidence: [{ messageId: 2, role: "primary" }] })],
      lookup,
    );
    expect(out.map((e) => [e.isFirst, e.firstCheck])).toEqual([
      [false, "unverified"],
      [false, "unverified"],
    ]);
  });

  test("only the earliest event of a kind keeps is_first", async () => {
    const hit = { messageId: 1, sentAt: at("2030-01-05 18:00") };
    const lookup = lookupFrom({ "i love you": hit, "luv u": hit });
    const out = await checkFirsts(
      [
        merged({ isFirst: true, firstOf: "i love you", occurredAt: at("2030-01-09 18:00"), evidenceFrom: at("2030-01-09 18:00") }),
        merged({ isFirst: true, firstOf: "luv u", occurredAt: at("2030-01-05 18:00"), evidenceFrom: at("2030-01-05 18:00") }),
      ],
      lookup,
    );
    expect(out.map((e) => [e.isFirst, e.firstCheck])).toEqual([
      [false, "superseded"],
      [true, "verified"],
    ]);
  });

  test("the same earliest message in different categories are different kinds", async () => {
    const hit = { messageId: 1, sentAt: at("2030-01-05 18:00") };
    const lookup = lookupFrom({ x: hit });
    const out = await checkFirsts(
      [merged({ isFirst: true, firstOf: "x", category: "Milestone" }), merged({ isFirst: true, firstOf: "x", category: "Saying" })],
      lookup,
    );
    expect(out.every((e) => e.isFirst)).toBe(true);
  });

  test("the same words are searched once", async () => {
    const lookup = lookupFrom({ a: { messageId: 1, sentAt: at("2030-01-05 18:00") } });
    await checkFirsts([merged({ isFirst: true, firstOf: "A" }), merged({ isFirst: true, firstOf: "a " })], lookup);
    expect(lookup.calls).toEqual(["a"]);
  });
});
