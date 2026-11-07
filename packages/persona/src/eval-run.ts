import { readFileSync } from "node:fs";
import { AnswerPayloadSchema, type AnswerPayload } from "@hec/core";
import type { ChatModel } from "@hec/llm";
import { neutralText } from "./neutral";
import { render, type Persona } from "./render";

const file = JSON.parse(readFileSync(new URL("../../../evals/persona/payload.json", import.meta.url), "utf8")) as {
  synthetic?: boolean;
  payload: AnswerPayload;
};
if (file.synthetic !== true) {
  console.error("persona evals refuse a payload file that is not marked synthetic");
  process.exit(1);
}

const payload = AnswerPayloadSchema.parse(file.payload);
const heavy: AnswerPayload = {
  ...payload,
  verdict: "found",
  confidence: "medium",
  sensitivity: "heavy",
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
};

const zero = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costInr: 0 };
const extreme: Persona = { id: "extreme", system: "Dramatic, but facts only." };

function speaking(text: string): ChatModel {
  return { model: "scripted", async complete() { return { text, usage: zero }; } };
}

const plain = await render(payload, "neutral");
const geek = await render(payload, "romance_geek", { model: speaking(`Noted in the archives.\n${neutralText(payload)}`) });
const loud = await render(payload, extreme, { model: speaking(`MAXIMUM DRAMA.\n${neutralText(payload)}`) });
const facts = [plain, geek, loud].map((item) => JSON.stringify(item.facts));
let failed = facts[0] !== facts[1] || facts[0] !== facts[2];
console.log(`${failed ? "fail" : "pass"} tone-invariance verdict ${plain.facts.verdict}`);

const soft = await render(heavy, "romance_geek", { model: speaking("What a plot twist 😉") });
const softFail = /plot twist|😉|teas/i.test(soft.text) || !soft.text.includes("2030-06-03");
if (softFail) failed = true;
console.log(`${softFail ? "fail" : "pass"} soft-mode`);

if (failed) process.exitCode = 1;
