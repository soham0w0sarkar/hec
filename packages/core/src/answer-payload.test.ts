import { describe, expect, test } from "bun:test";
import { AnswerPayloadSchema, type AnswerPayload } from "./answer-payload";

export function samplePayload(over: Partial<AnswerPayload> = {}): AnswerPayload {
  return {
    version: 1,
    question_type: "first_last",
    verdict: "found",
    interpretation_note: "Earliest message that contains the phrase.",
    claims: [
      {
        text: "Ravi sent the earliest matching message.",
        message_ids: [7],
        date: "2030-06-01",
        person: "Ravi",
        source: "instagram",
        quote: "hello there",
        basis: "messages",
      },
    ],
    searched: { tools: ["find_first"], variants: ["hello"], date_ranges: [{ from: null, until: null }] },
    caveats: ["A later message on WhatsApp uses a shorter spelling."],
    confidence: "high",
    sensitivity: "none",
    ...over,
  };
}

describe("AnswerPayload v1", () => {
  test("accepts a neutral payload and keeps the quote", () => {
    const parsed = AnswerPayloadSchema.parse(samplePayload());
    expect(parsed.version).toBe(1);
    expect(parsed.claims[0]?.quote).toBe("hello there");
  });

  test("rejects emoji and unknown keys outside a quote", () => {
    const emoji = samplePayload();
    emoji.interpretation_note = "Found it 😀";
    expect(AnswerPayloadSchema.safeParse(emoji).success).toBe(false);

    const quoted = samplePayload();
    const claim = quoted.claims[0];
    if (!claim) throw new Error("missing claim");
    claim.quote = "hello 😀";
    expect(AnswerPayloadSchema.safeParse(quoted).success).toBe(true);

    expect(AnswerPayloadSchema.safeParse({ ...samplePayload(), joke: "nope" }).success).toBe(false);
  });

  test("rejects a verdict or a sensitivity outside the set", () => {
    expect(AnswerPayloadSchema.safeParse({ ...samplePayload(), verdict: "maybe" }).success).toBe(false);
    expect(AnswerPayloadSchema.safeParse({ ...samplePayload(), sensitivity: "spicy" }).success).toBe(false);
    expect(AnswerPayloadSchema.safeParse({ ...samplePayload(), version: 2 }).success).toBe(false);
  });
});
