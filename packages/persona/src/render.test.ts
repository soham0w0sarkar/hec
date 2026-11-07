import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { AnswerPayload } from "@hec/core";
import type { ChatModel, ChatRequest } from "@hec/llm";
import { neutralText } from "./neutral";
import { loadPersonaPrompt } from "./prompt";
import { render, type Persona } from "./render";
import { extractFacts } from "./validate";

function payload(over: Partial<AnswerPayload> = {}): AnswerPayload {
  return {
    version: 1,
    question_type: "first_last",
    verdict: "ambiguous",
    interpretation_note: "Two messages are close, so this does not pick a single first.",
    claims: [
      {
        text: "Ravi sent a matching message.",
        message_ids: [7],
        date: "2030-06-01",
        person: "Ravi",
        source: "instagram",
        quote: "hello there",
        basis: "messages",
      },
      {
        text: "Anita sent a matching message.",
        message_ids: [8],
        date: "2030-06-01",
        person: "Anita",
        source: "whatsapp",
        quote: "hello you",
        basis: "messages",
      },
    ],
    searched: { tools: ["find_first"], variants: ["hello"], date_ranges: [] },
    caveats: ["The top two matches are 20 minutes apart, so neither one is clearly first."],
    confidence: "ambiguous",
    sensitivity: "none",
    ...over,
  };
}

function speaking(write: (request: ChatRequest) => string): ChatModel & { calls: number } {
  const model = {
    model: "scripted",
    calls: 0,
    async complete(request: ChatRequest) {
      model.calls += 1;
      return {
        text: write(request),
        usage: { inputTokens: 30, outputTokens: 20, cachedInputTokens: 0, costInr: 0 },
      };
    },
  };
  return model;
}

const extreme: Persona = {
  id: "extreme",
  system: "You are extremely dramatic. You still may only reword the payload.",
};

describe("render", () => {
  test("the same payload keeps the same facts across three voices and calls no tools", async () => {
    const body = payload();
    const sources = ["render.ts", "validate.ts", "neutral.ts", "prompt.ts"].map((file) =>
      readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
    );
    for (const source of sources) {
      expect(source).not.toContain("@hec/retrieval");
      expect(source).not.toContain("@hec/agent");
      expect(source).not.toContain("executeTool");
    }

    const romance = speaking(() => `The archives are glowing, and it is still ambiguous.\n${neutralText(body)}`);
    const wild = speaking(() => `UNHINGED BUT FAITHFUL, and it is ambiguous.\n${neutralText(body)}`);
    const plain = await render(body, "neutral");
    const geek = await render(body, "romance_geek", { model: romance });
    const loud = await render(body, extreme, { model: wild });

    expect(romance.calls).toBe(1);
    expect(wild.calls).toBe(1);
    expect(geek.text).not.toBe(plain.text);
    expect(loud.text).not.toBe(geek.text);
    expect(extractFacts(geek.text, body)).toEqual(extractFacts(plain.text, body));
    expect(extractFacts(loud.text, body)).toEqual(extractFacts(plain.text, body));
    expect(geek.facts.verdict).toBe("ambiguous");
    expect(geek.mentioned_dates).toEqual(["2030-06-01"]);
    expect(geek.used_message_ids).toEqual([7, 8]);
  });

  test("a failed fact check is retried once and then falls back to neutral", async () => {
    const body = payload();
    const model = speaking(() => "On 1999-01-01 they definitely said it.");
    const rendered = await render(body, "romance_geek", { model });
    expect(model.calls).toBe(2);
    expect(rendered.text).toBe(neutralText(body));
    expect(rendered.mentioned_dates).toEqual(["2030-06-01"]);
  });

  test("heavy sensitivity stays soft even for the romance persona", async () => {
    const body = payload({
      sensitivity: "heavy",
      verdict: "found",
      confidence: "medium",
      interpretation_note: "A reviewed conflict is on this day.",
      claims: [
        {
          text: "An argument is on the timeline.",
          message_ids: [4],
          date: "2030-06-03",
          person: null,
          source: null,
          quote: null,
          basis: "timeline",
        },
      ],
      caveats: ["This is one reviewed event."],
    });
    const model = speaking(() => "What a plot twist, the slow burn is teasing us 😉");
    const rendered = await render(body, "romance_geek", { model });
    expect(model.calls).toBe(2);
    expect(rendered.text).toBe(neutralText(body));
    expect(rendered.text).not.toMatch(/plot twist|teasing|😉|flirt/i);
    expect(rendered.facts.verdict).toBe("found");
  });

  test("a corrected retry is kept", async () => {
    const body = payload();
    let n = 0;
    const model = speaking(() => {
      n += 1;
      return n === 1 ? "definitely on 1999-01-01" : `Still ambiguous.\n${neutralText(body)}`;
    });
    const rendered = await render(body, extreme, { model });
    expect(model.calls).toBe(2);
    expect(rendered.text).toContain("Still ambiguous");
    expect(rendered.text).not.toContain("1999");
  });

  test("the romance prompt is the versioned file", () => {
    const text = loadPersonaPrompt();
    expect(text.startsWith("You are HEC's narrator:")).toBe(true);
    expect(text).toContain("SOFT MODE (when payload.sensitivity is \"heavy\")");
    expect(text).toContain("You only reword the AnswerPayload.");
  });
});
