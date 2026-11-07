import { describe, expect, test } from "bun:test";
import { buildFinalEvents, toFinalEvent } from "./pipeline";
import type { MergedCandidate } from "./merge";
import { candidate } from "./test-helpers";
import { parseLocal } from "./time";
import type { FirstLookup } from "./firsts";

const at = (value: string) => parseLocal(value)!.instant;

describe("buildFinalEvents", () => {
  test("merges neighbours, verifies a first against the history, and keeps evidence", async () => {
    const lookup: FirstLookup = async () => ({ messageId: 1, sentAt: at("2030-01-05 18:00") });
    const events = await buildFinalEvents(
      [
        {
          sessionId: 1,
          windows: 1,
          candidates: [
            {
              ...candidate({
                isFirst: true,
                firstOf: "i love you",
                category: "Milestone",
                evidence: [{ messageId: 1, role: "primary" }],
              }),
              window: 0,
            },
          ],
        },
      ],
      lookup,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ isFirst: true, firstCheck: "verified", category: "Milestone", speakerId: null, quote: null });
  });

  test("a Saying carries its speaker and quote into the row", async () => {
    const events = await buildFinalEvents(
      [
        {
          sessionId: 1,
          windows: 1,
          candidates: [
            {
              ...candidate({
                category: "Saying",
                saying: { personId: "person_2", quote: "sab kuch" },
                evidence: [{ messageId: 2, role: "primary" }],
              }),
              window: 0,
            },
          ],
        },
      ],
      async () => null,
    );
    expect(events[0]).toMatchObject({ speakerId: "person_2", quote: "sab kuch" });
  });

  test("an unverified first is written as not first", async () => {
    const events = await buildFinalEvents(
      [{ sessionId: 1, windows: 1, candidates: [{ ...candidate({ isFirst: true, firstOf: "nothing" }), window: 0 }] }],
      async () => null,
    );
    expect(events[0]).toMatchObject({ isFirst: false, firstCheck: "unverified" });
  });
});

describe("toFinalEvent invariants", () => {
  const base: MergedCandidate = { ...candidate(), sessionIds: [1], mergedFrom: 1, firstCheck: null };

  test("a first claim that is not verified never reaches insert", () => {
    expect(() => toFinalEvent({ ...base, isFirst: true, firstCheck: "unverified" })).toThrow(/verified/);
  });

  test("a Saying needs a quote, and a non-Saying must not have one", () => {
    expect(() => toFinalEvent({ ...base, category: "Saying", saying: null })).toThrow(/quote/);
    expect(() => toFinalEvent({ ...base, saying: { personId: "person_1", quote: "x" } })).toThrow(/non-Saying/);
  });

  test("an end must come after the start", () => {
    const start = at("2030-01-05 18:00");
    expect(() => toFinalEvent({ ...base, occurredAt: start, endedAt: start })).toThrow(/ended_at/);
  });
});
