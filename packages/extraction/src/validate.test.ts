import { describe, expect, test } from "bun:test";
import {
  checkCategory,
  checkEvidence,
  checkSaying,
  checkTimeRange,
  countDrops,
  findQuote,
  sameName,
  validateEvent,
  validateEvents,
} from "./validate";
import { LABELS, ctx, messageMap, msg, raw } from "./test-helpers";
import { parseLocal } from "./time";

const messages = [
  msg(1, "2030-01-05 18:00", "person_1", "see you at the cafe"),
  msg(2, "2030-01-05 18:30", "person_2", "Tum   mere\nliye sab kuch ho!"),
  msg(3, "2030-01-06 09:00", "person_1", "good morning"),
];
const context = ctx(messages);
const at = (value: string) => parseLocal(value)!.instant;

describe("category", () => {
  test("accepts each of the eight pass 1 categories", () => {
    for (const category of ["Milestone", "Meetup", "Trip", "Celebration", "Plan", "Conflict", "Saying", "Life update"]) {
      expect(checkCategory(category)).toEqual({ ok: true, value: category as never });
    }
  });

  test("rejects unknown, miscased, empty and non-string values", () => {
    for (const value of ["meetup", "Date night", "", "Meetup, Trip", ["Meetup"], null, 3]) {
      expect(checkCategory(value)).toEqual({ ok: false, reason: "invalid_category" });
    }
  });

  test("Running joke is a real category but not allowed in pass 1", () => {
    expect(checkCategory("Running joke")).toEqual({ ok: false, reason: "running_joke_in_pass_1" });
  });
});

describe("evidence", () => {
  test("an event needs at least one ref that exists in the session", () => {
    expect(checkEvidence([], context.messages)).toEqual({ ok: false, reason: "no_evidence" });
    expect(checkEvidence([{ ref: "m999", role: "primary" }], context.messages)).toEqual({
      ok: false,
      reason: "no_evidence",
    });
    expect(checkEvidence([{ ref: "free text", role: "primary" }], context.messages).ok).toBe(false);
  });

  test("unknown refs are ignored when another one is real", () => {
    const result = checkEvidence(
      [
        { ref: "m999", role: "primary" },
        { ref: "[m2]", role: "supporting" },
      ],
      context.messages,
    );
    expect(result.ok && result.value.evidence).toEqual([{ messageId: 2, role: "primary" }]);
  });

  test("duplicates collapse, primary wins, result is in time order", () => {
    const result = checkEvidence(
      [
        { ref: "m3", role: "supporting" },
        { ref: "m1", role: "supporting" },
        { ref: "m3", role: "primary" },
      ],
      context.messages,
    );
    expect(result.ok && result.value.evidence).toEqual([
      { messageId: 1, role: "supporting" },
      { messageId: 3, role: "primary" },
    ]);
  });

  test("when nothing is primary the first message becomes primary", () => {
    const result = checkEvidence([{ ref: "m2", role: "supporting" }, { ref: "m1", role: "supporting" }], context.messages);
    expect(result.ok && result.value.evidence[0]).toEqual({ messageId: 1, role: "primary" });
  });
});

describe("quote", () => {
  test("verbatim substring, case and punctuation exact", () => {
    expect(findQuote("mere liye sab kuch", messages)?.id).toBe(2);
    expect(findQuote("Tum mere liye sab kuch ho!", messages)?.id).toBe(2);
  });

  test("whitespace is flattened on both sides", () => {
    expect(findQuote("mere liye", [messages[1]!])?.id).toBe(2);
  });

  test("not verbatim: case, typo, punctuation, paraphrase", () => {
    expect(findQuote("tum mere liye", messages)).toBeNull();
    expect(findQuote("Tum mere liye sab kuch ho.", messages)).toBeNull();
    expect(findQuote("Tum mere lie", messages)).toBeNull();
    expect(findQuote("you are everything to me", messages)).toBeNull();
    expect(findQuote("   ", messages)).toBeNull();
  });

  test("checkSaying needs a quote from the evidence and the speaker's name", () => {
    const evidence = [messages[1]!];
    expect(checkSaying({ speaker: "Anita", quote: "mere liye sab kuch" }, evidence, LABELS)).toEqual({
      ok: true,
      value: { personId: "person_2", quote: "mere liye sab kuch" },
    });
    expect(checkSaying({ speaker: "ravi", quote: "mere liye sab kuch" }, evidence, LABELS)).toEqual({
      ok: false,
      reason: "speaker_mismatch",
    });
    expect(checkSaying({ speaker: "Anita", quote: "something else" }, evidence, LABELS)).toEqual({
      ok: false,
      reason: "quote_not_verbatim",
    });
    expect(checkSaying(null, evidence, LABELS)).toEqual({ ok: false, reason: "saying_without_quote" });
    expect(checkSaying({ speaker: "Anita", quote: "" }, evidence, LABELS)).toEqual({
      ok: false,
      reason: "saying_without_quote",
    });
  });

  test("the speaker name matches case-insensitively and ignores surrounding spaces", () => {
    expect(sameName(" Anita ", "anita")).toBe(true);
    expect(sameName("Anita", "Anit")).toBe(false);
  });

  test("a quote from a message that is not in the evidence is rejected", () => {
    // m1 is evidence, but the quote is in m2.
    expect(checkSaying({ speaker: "Anita", quote: "sab kuch" }, [messages[0]!], LABELS).ok).toBe(false);
  });
});

describe("time range", () => {
  const evidence = [messages[0]!, messages[1]!];

  test("a day inside the evidence days passes, outside fails", () => {
    expect(checkTimeRange(at("2030-01-05 12:00"), "exact_day", evidence)).toBe(true);
    expect(checkTimeRange(at("2030-01-04 23:59"), "exact_day", evidence)).toBe(false);
    expect(checkTimeRange(at("2030-01-06 00:01"), "exact_day", evidence)).toBe(false);
  });

  test("day comparison uses India days, not UTC days", () => {
    // 2030-01-05 23:50 IST is still the 5th in India but the 5th 18:20 UTC. 2030-01-06 00:10 IST is the 6th.
    expect(checkTimeRange(at("2030-01-05 23:50"), "exact_day", evidence)).toBe(true);
    expect(checkTimeRange(at("2030-01-06 00:10"), "exact_day", evidence)).toBe(false);
  });

  test("month precision compares months", () => {
    expect(checkTimeRange(at("2030-01"), "month", evidence)).toBe(true);
    expect(checkTimeRange(at("2030-02"), "month", evidence)).toBe(false);
  });

  test("approximate precision is held to the same days", () => {
    expect(checkTimeRange(at("2030-01-20"), "approximate", evidence)).toBe(false);
  });

  test("a Meetup or Trip may not be dated before its evidence", () => {
    expect(checkTimeRange(at("2030-01-04 12:00"), "exact_day", evidence, "Asia/Kolkata", "Meetup")).toBe(false);
    expect(checkTimeRange(at("2030-01-04 12:00"), "exact_day", evidence, "Asia/Kolkata", "Trip")).toBe(false);
  });

  test("a Life update may be dated one day before the messages that discuss it", () => {
    // Evidence starts on the 5th. The news happened on the 4th and was shared on the 5th.
    expect(checkTimeRange(at("2030-01-04 12:00"), "exact_day", evidence, "Asia/Kolkata", "Life update")).toBe(true);
    // Two days before is still too early.
    expect(checkTimeRange(at("2030-01-03 12:00"), "exact_day", evidence, "Asia/Kolkata", "Life update")).toBe(false);
    // The same day is fine, and so is the day after the last message only if the evidence reaches it.
    expect(checkTimeRange(at("2030-01-05 12:00"), "exact_day", evidence, "Asia/Kolkata", "Life update")).toBe(true);
    expect(checkTimeRange(at("2030-01-06 12:00"), "exact_day", evidence, "Asia/Kolkata", "Life update")).toBe(false);
  });

  test("a Life update's one-day allowance does not apply to the date after the messages", () => {
    const later = [msg(9, "2030-01-05 12:00", "person_1", "news"), msg(10, "2030-01-06 12:00", "person_2", "more news")];
    expect(checkTimeRange(at("2030-01-04 12:00"), "exact_day", later, "Asia/Kolkata", "Life update")).toBe(true);
    expect(checkTimeRange(at("2030-01-07 12:00"), "exact_day", later, "Asia/Kolkata", "Life update")).toBe(false);
  });
});

describe("validateEvent", () => {
  const good = raw({ occurred_at: "2030-01-05 18:00" });

  test("a good event becomes a candidate", () => {
    const result = validateEvent(good, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.category).toBe("Meetup");
      expect(result.value.datePrecision).toBe("exact_day");
      expect(result.value.evidence).toEqual([{ messageId: 1, role: "primary" }]);
      expect(result.value.evidenceFrom).toEqual(messages[0]!.sentAt);
    }
  });

  test("drops an event with no evidence, a bad category, bad significance, empty text", () => {
    expect(validateEvent(raw({ evidence: [] }), context)).toEqual({ ok: false, reason: "no_evidence" });
    expect(validateEvent(raw({ category: "Hangout" }), context)).toEqual({ ok: false, reason: "invalid_category" });
    expect(validateEvent(raw({ significance: 4 }), context)).toEqual({ ok: false, reason: "invalid_significance" });
    expect(validateEvent(raw({ significance: 0 }), context)).toEqual({ ok: false, reason: "invalid_significance" });
    expect(validateEvent(raw({ significance: 1.5 }), context)).toEqual({ ok: false, reason: "invalid_significance" });
    expect(validateEvent(raw({ title: "  " }), context)).toEqual({ ok: false, reason: "empty_text" });
  });

  test("drops an event dated outside its evidence", () => {
    expect(validateEvent(raw({ occurred_at: "2030-02-01 10:00" }), context)).toEqual({
      ok: false,
      reason: "date_outside_evidence",
    });
    expect(validateEvent(raw({ occurred_at: "not a date" }), context)).toEqual({ ok: false, reason: "bad_date" });
  });

  test("a Life update one day before its evidence is kept, a Meetup is dropped", () => {
    const life = validateEvent(
      raw({ category: "Life update", occurred_at: "2030-01-04 10:00", evidence: [{ ref: "m1", role: "primary" }] }),
      context,
    );
    expect(life.ok).toBe(true);
    const meetup = validateEvent(raw({ occurred_at: "2030-01-04 10:00" }), context);
    expect(meetup).toEqual({ ok: false, reason: "date_outside_evidence" });
  });

  test("ended_at has to be after occurred_at", () => {
    const base = { evidence: [{ ref: "m1", role: "primary" as const }, { ref: "m3", role: "supporting" as const }] };
    const ok = validateEvent(raw({ ...base, ended_at: "2030-01-06 09:00" }), context);
    expect(ok.ok && ok.value.endedAt?.toISOString()).toBe(at("2030-01-06 09:00").toISOString());
    expect(validateEvent(raw({ ...base, ended_at: "2030-01-05 18:00" }), context)).toEqual({
      ok: false,
      reason: "ended_not_after_start",
    });
    expect(validateEvent(raw({ ...base, ended_at: "2030-01-05 10:00" }), context)).toEqual({
      ok: false,
      reason: "ended_not_after_start",
    });
    expect(validateEvent(raw({ ...base, ended_at: "soon" }), context)).toEqual({ ok: false, reason: "bad_date" });
  });

  test("a Saying must carry a verbatim quote from the named speaker; other categories ignore a saying", () => {
    const saying = raw({
      category: "Saying",
      occurred_at: "2030-01-05 18:30",
      evidence: [{ ref: "m2", role: "primary" }],
      saying: { speaker: "Anita", quote: "mere liye sab kuch" },
    });
    const ok = validateEvent(saying, context);
    expect(ok.ok && ok.value.saying).toEqual({ personId: "person_2", quote: "mere liye sab kuch" });
    expect(validateEvent({ ...saying, saying: { speaker: "Anita", quote: "made up" } }, context)).toEqual({
      ok: false,
      reason: "quote_not_verbatim",
    });
    expect(validateEvent({ ...saying, saying: null }, context)).toEqual({ ok: false, reason: "saying_without_quote" });
    expect(validateEvent({ ...saying, saying: { speaker: "Ravi", quote: "mere liye sab kuch" } }, context)).toEqual({
      ok: false,
      reason: "speaker_mismatch",
    });

    const meetup = validateEvent(raw({ saying: { speaker: "Anita", quote: "anything" } }), context);
    expect(meetup.ok && meetup.value.saying).toBeNull();
  });

  test("first_of is only kept when is_first is true", () => {
    const claimed = validateEvent(raw({ is_first: true, first_of: " first cafe " }), context);
    expect(claimed.ok && claimed.value.firstOf).toBe("first cafe");
    const notClaimed = validateEvent(raw({ is_first: false, first_of: "first cafe" }), context);
    expect(notClaimed.ok && notClaimed.value.firstOf).toBeNull();
  });

  test("validateEvents keeps the good ones and reports reasons, not text", () => {
    const result = validateEvents([good, raw({ evidence: [] }), raw({ category: "x" })], context);
    expect(result.candidates).toHaveLength(1);
    expect(result.dropped).toEqual([
      { index: 1, reason: "no_evidence" },
      { index: 2, reason: "invalid_category" },
    ]);
    expect(countDrops(result.dropped)).toEqual({ no_evidence: 1, invalid_category: 1 });
  });

  test("messageMap is used for lookups", () => {
    expect(messageMap(messages).get(2)?.personId).toBe("person_2");
  });
});
