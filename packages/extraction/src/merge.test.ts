import { describe, expect, test } from "bun:test";
import type { WindowedCandidate } from "./extract";
import { mergeCandidates, wordOverlap } from "./merge";
import { candidate } from "./test-helpers";
import { parseLocal } from "./time";

const at = (value: string) => parseLocal(value)!.instant;

function wc(window: number, overrides: Parameters<typeof candidate>[0] = {}): WindowedCandidate {
  return { ...candidate(overrides), window };
}

describe("mergeCandidates", () => {
  test("windows of one session: same category, close date, shared evidence merge into one", () => {
    const merged = mergeCandidates([
      {
        sessionId: 1,
        windows: 2,
        candidates: [
          wc(0, { evidence: [{ messageId: 1, role: "primary" }, { messageId: 2, role: "supporting" }] }),
          wc(1, { title: "Cafe date", evidence: [{ messageId: 2, role: "primary" }, { messageId: 3, role: "supporting" }] }),
        ],
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.mergedFrom).toBe(2);
    expect(merged[0]?.evidence.map((e) => e.messageId).sort()).toEqual([1, 2, 3]);
    expect(merged[0]?.evidence.find((e) => e.messageId === 2)?.role).toBe("primary");
  });

  test("no shared evidence in the same session means two events", () => {
    const merged = mergeCandidates([
      {
        sessionId: 1,
        windows: 2,
        candidates: [
          wc(0, { evidence: [{ messageId: 1, role: "primary" }] }),
          wc(1, { evidence: [{ messageId: 9, role: "primary" }] }),
        ],
      },
    ]);
    expect(merged).toHaveLength(2);
  });

  test("different category never merges", () => {
    const merged = mergeCandidates([
      {
        sessionId: 1,
        windows: 2,
        candidates: [wc(0, { category: "Plan" }), wc(1, { category: "Meetup" })],
      },
    ]);
    expect(merged).toHaveLength(2);
  });

  test("dates too far apart do not merge", () => {
    const merged = mergeCandidates([
      {
        sessionId: 1,
        windows: 2,
        candidates: [wc(0), wc(1, { occurredAt: at("2030-03-05 18:00") })],
      },
    ]);
    expect(merged).toHaveLength(2);
  });

  test("windows two apart do not merge, even with shared evidence", () => {
    const merged = mergeCandidates([
      { sessionId: 1, windows: 3, candidates: [wc(0), wc(2)] },
    ]);
    expect(merged).toHaveLength(2);
  });

  test("adjacent sessions: close date and similar titles merge; evidence is the union", () => {
    const merged = mergeCandidates([
      { sessionId: 1, windows: 1, candidates: [wc(0, { title: "Weekend trip to Goa", evidence: [{ messageId: 1, role: "primary" }] })] },
      {
        sessionId: 2,
        windows: 1,
        candidates: [
          wc(0, {
            title: "Goa weekend trip",
            occurredAt: at("2030-01-06 10:00"),
            evidence: [{ messageId: 50, role: "primary" }],
            significance: 2,
          }),
        ],
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sessionIds).toEqual([1, 2]);
    expect(merged[0]?.evidence.map((e) => e.messageId)).toEqual([1, 50]);
    expect(merged[0]?.significance).toBe(2);
  });

  test("adjacent sessions with different titles stay separate", () => {
    const merged = mergeCandidates([
      { sessionId: 1, windows: 1, candidates: [wc(0, { title: "Coffee together" })] },
      { sessionId: 2, windows: 1, candidates: [wc(0, { title: "Movie night at home", evidence: [{ messageId: 50, role: "primary" }] })] },
    ]);
    expect(merged).toHaveLength(2);
  });

  test("sessions that are not neighbours do not merge", () => {
    const merged = mergeCandidates([
      { sessionId: 1, windows: 1, candidates: [wc(0, { title: "Goa trip" })] },
      { sessionId: 2, windows: 1, candidates: [] },
      { sessionId: 3, windows: 1, candidates: [wc(0, { title: "Goa trip", evidence: [{ messageId: 50, role: "primary" }] })] },
    ]);
    expect(merged).toHaveLength(2);
  });

  test("a Saying across sessions never merges on title", () => {
    const saying = { personId: "person_1" as const, quote: "hi" };
    const merged = mergeCandidates([
      { sessionId: 1, windows: 1, candidates: [wc(0, { category: "Saying", title: "A line", saying })] },
      { sessionId: 2, windows: 1, candidates: [wc(0, { category: "Saying", title: "A line", saying, evidence: [{ messageId: 50, role: "primary" }] })] },
    ]);
    expect(merged).toHaveLength(2);
  });

  test("a merged event keeps the earliest-claimed first and the longest end", () => {
    const merged = mergeCandidates([
      {
        sessionId: 1,
        windows: 2,
        candidates: [
          wc(0, { isFirst: true, firstOf: "first trip", endedAt: at("2030-01-06 10:00") }),
          wc(1, { endedAt: at("2030-01-07 10:00") }),
        ],
      },
    ]);
    expect(merged[0]?.isFirst).toBe(true);
    expect(merged[0]?.firstOf).toBe("first trip");
    expect(merged[0]?.endedAt).toEqual(at("2030-01-07 10:00"));
  });

  test("an event with a most precise date supplies the date", () => {
    const merged = mergeCandidates([
      {
        sessionId: 1,
        windows: 2,
        candidates: [
          wc(0, { datePrecision: "approximate", occurredAt: at("2030-01-04 12:00") }),
          wc(1, { datePrecision: "exact_day", occurredAt: at("2030-01-05 18:00") }),
        ],
      },
    ]);
    expect(merged[0]?.datePrecision).toBe("exact_day");
    expect(merged[0]?.occurredAt).toEqual(at("2030-01-05 18:00"));
  });

  test("output is oldest first and does not alter the input", () => {
    const early = wc(0, { occurredAt: at("2030-01-01 10:00"), evidence: [{ messageId: 5, role: "primary" }], category: "Trip" });
    const late = wc(0, { occurredAt: at("2030-01-09 10:00"), evidence: [{ messageId: 6, role: "primary" }], category: "Plan" });
    const sessions = [{ sessionId: 1, windows: 1, candidates: [late, early] }];
    const merged = mergeCandidates(sessions);
    expect(merged.map((m) => m.category)).toEqual(["Trip", "Plan"]);
    expect(sessions[0]?.candidates[0]).toBe(late);
  });

  test("wordOverlap", () => {
    expect(wordOverlap("Goa weekend trip", "Weekend trip to Goa")).toBeGreaterThan(0.6);
    expect(wordOverlap("Coffee", "Movie night")).toBe(0);
    expect(wordOverlap("", "x")).toBe(0);
  });
});
