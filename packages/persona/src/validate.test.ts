import { describe, expect, test } from "bun:test";
import type { AnswerPayload } from "@hec/core";
import { neutralText } from "./neutral";
import { validateLead, validateRender } from "./validate";

function payload(over: Partial<AnswerPayload> = {}): AnswerPayload {
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
    searched: { tools: ["find_first"], variants: ["hello"], date_ranges: [] },
    caveats: ["A later note on WhatsApp uses a shorter spelling."],
    confidence: "high",
    sensitivity: "none",
    ...over,
  };
}

describe("validateRender", () => {
  test("accepts the neutral rendering", () => {
    const body = payload();
    expect(validateRender(neutralText(body), body)).toEqual([]);
  });

  test("rejects an invented date", () => {
    const body = payload();
    const text = `${neutralText(body)}\nAlso on 1999-01-01.`;
    expect(validateRender(text, body).some((reason) => reason.includes("1999-01-01"))).toBe(true);
  });

  test("rejects an altered quote", () => {
    const body = payload();
    const text = neutralText(body).replace("hello there", '"hello thar"');
    const reasons = validateRender(text, body);
    expect(reasons.some((reason) => reason.includes("quote"))).toBe(true);
  });

  test("rejects a dropped caveat", () => {
    const body = payload();
    const text = neutralText(body).replace(body.caveats[0] ?? "", "");
    expect(validateRender(text, body).some((reason) => reason.includes("caveat"))).toBe(true);
  });

  test("rejects an ambiguous verdict phrased as certain", () => {
    const body = payload({ verdict: "ambiguous", confidence: "ambiguous" });
    const text = `Ravi definitely said it first on 2030-06-01.\nQuote: hello there\nMessages: (#7).\n${body.caveats[0]}`;
    const reasons = validateRender(text, body);
    expect(reasons.some((reason) => reason.includes("certain") || reason.includes("settled"))).toBe(true);
  });

  test("rejects a not_found reply that invents a consolation", () => {
    const body = payload({ verdict: "not_found", claims: [], confidence: "low" });
    const text = "Nothing matched the search, but luckily they probably said it on a call.";
    expect(validateRender(text, body).length).toBeGreaterThan(0);
  });

  test("accepts natural ways of saying the search came back empty", () => {
    const body = payload({ verdict: "not_found", claims: [], caveats: [], confidence: "low" });
    for (const lead of [
      "I couldn't find a record of that.",
      "The search came up empty.",
      "The search turned up empty.",
      "There is no record of that in the story.",
      "That one isn't there.",
      "I don't have a message for that.",
    ]) {
      expect(validateRender(lead, body)).toEqual([]);
    }
  });

  test("accepts a partial verdict said as 'only part'", () => {
    const body = payload({ verdict: "partial", claims: [], caveats: [], confidence: "low" });
    expect(validateRender("I only found part of it.", body)).toEqual([]);
  });

  test("accepts an ambiguous verdict said as 'don't agree'", () => {
    const body = payload({ verdict: "ambiguous", claims: [], caveats: [], confidence: "ambiguous" });
    expect(validateRender("The records don't agree.", body)).toEqual([]);
  });

  test("accepts a plain 'couldn't find it' lead", () => {
    const body = payload({ verdict: "not_found", claims: [], caveats: [], confidence: "low" });
    expect(validateLead("I checked and I couldn't find it.", body)).toEqual([]);
  });

  test("rejects an unbalanced quotation in the lead", () => {
    const body = payload();
    const reasons = validateLead('He was the first to say "hello there.', body);
    expect(reasons.some((reason) => reason.includes("unbalanced"))).toBe(true);
  });

  test("rejects a date in the lead even when it is in the payload", () => {
    const body = payload();
    const reasons = validateLead("It happened on 2030-06-01.", body);
    expect(reasons.some((reason) => reason.includes("repeated the date"))).toBe(true);
  });

  test("rejects a message id in the lead", () => {
    const body = payload();
    const reasons = validateLead("Message 7 says it.", body);
    expect(reasons.some((reason) => reason.includes("repeated message id"))).toBe(true);
  });

  test("rejects a lead that narrates the appendix", () => {
    const body = payload();
    for (const lead of [
      "Dates and message ids will follow below.",
      "I'll leave the dates and quotes up to you.",
      "Caveats and confidence are listed below.",
    ]) {
      const reasons = validateLead(lead, body);
      expect(reasons.some((reason) => reason.includes("appendix"))).toBe(true);
    }
  });

  test("rejects the literal not_found label in the lead", () => {
    const body = payload({ verdict: "not_found", claims: [], caveats: [], confidence: "low" });
    const reasons = validateLead("Not_found. I looked and couldn't find it.", body);
    expect(reasons.some((reason) => reason.includes("label"))).toBe(true);
  });
});
