import { describe, expect, test } from "bun:test";
import type { AnswerPayload } from "@hec/core";
import { neutralText } from "./neutral";
import { validateRender } from "./validate";

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
});
