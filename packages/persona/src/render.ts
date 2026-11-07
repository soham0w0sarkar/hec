import { AnswerPayloadSchema, type AnswerPayload } from "@hec/core";
import { ZERO_USAGE, type ChatModel, type Usage } from "@hec/llm";
import { neutralText } from "./neutral";
import { loadPersonaPrompt } from "./prompt";
import { composeSpoken } from "./receipts";
import { extractFacts, validateLead, validateRender, type FactCheck } from "./validate";

export type Persona = {
  id: string;
  /** Null skips the model and uses the plain rendering. */
  system: string | null;
};

export type Rendered = {
  text: string;
  used_message_ids: number[];
  mentioned_dates: string[];
  facts: FactCheck;
  usage: Usage;
};

const romanceSystem = loadPersonaPrompt();

export const PERSONAS = {
  romance_geek: { id: "romance_geek", system: romanceSystem } satisfies Persona,
  neutral: { id: "neutral", system: null } satisfies Persona,
};

export function personaByName(name: string): Persona {
  if (name === "romance_geek" || name === "neutral") return PERSONAS[name];
  throw new Error(`unknown persona "${name}"`);
}

/**
 * Rewords a payload. The model writes a short voice lead only; receipts are appended in code.
 * A lead that fails the fact check is retried once with the reasons, then replaced by the neutral text.
 * Heavy sensitivity uses soft mode for every persona.
 */
export async function render(
  payload: AnswerPayload,
  persona: Persona | "romance_geek" | "neutral",
  options: { model?: ChatModel } = {},
): Promise<Rendered> {
  const checked = AnswerPayloadSchema.parse(payload);
  const voice = typeof persona === "string" ? personaByName(persona) : persona;
  const plain = neutralText(checked);
  if (!voice.system) return pack(plain, checked, ZERO_USAGE);

  const model = options.model;
  if (!model) throw new Error(`persona ${voice.id} needs a model`);
  const first = await ask(model, voice, checked, null);
  const firstLead = cleanLead(first.text);
  const firstSpoken = composeSpoken(firstLead, checked);
  if (leadOk(firstLead, checked) && validateRender(firstSpoken, checked).length === 0) {
    return pack(firstSpoken, checked, first.usage);
  }

  const second = await ask(model, voice, checked, [
    ...validateLead(firstLead, checked),
    ...validateRender(firstSpoken, checked),
  ]);
  const usage = add(first.usage, second.usage);
  const secondLead = cleanLead(second.text);
  const secondSpoken = composeSpoken(secondLead, checked);
  if (leadOk(secondLead, checked) && validateRender(secondSpoken, checked).length === 0) {
    return pack(secondSpoken, checked, usage);
  }
  return pack(plain, checked, usage);
}

function leadOk(lead: string, payload: AnswerPayload): boolean {
  return validateLead(lead, payload).length === 0;
}

/** Drops leaked prompt tags some models echo into the lead. */
export function cleanLead(text: string): string {
  return text
    .replace(/<\/?(?:start_of_lead|end_of_lead|payload|lead)\b[^>]*>/gi, "")
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .trim();
}

async function ask(
  model: ChatModel,
  persona: Persona,
  payload: AnswerPayload,
  failures: string[] | null,
): Promise<{ text: string; usage: Usage }> {
  const soft = payload.sensitivity === "heavy" ? "SOFT MODE is on. No jokes, no innuendo, no teasing." : "";
  const retry = failures ? `The previous reply failed these checks: ${failures.slice(0, 8).join("; ")}. Fix only that.` : "";
  const user = [
    "Write a short voice lead only (2-5 sentences). The program appends the dates, quotes, and message ids after you.",
    "Include the verdict value in the lead: found, not_found, ambiguous, or partial.",
    "Do not invent dates, numbers, names, quotes, or events. Prefer no digits at all in the lead.",
    "Plain text only. Do not wrap the lead in tags, XML, markdown fences, or the word payload.",
    "Use quotation marks only around a payload quote you copy exactly.",
    soft,
    retry,
    "<payload>",
    JSON.stringify(payload),
    "</payload>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  const reply = await model.complete({
    system: persona.system ?? "",
    user,
    temperature: payload.sensitivity === "heavy" ? 0.2 : 0.7,
    maxTokens: 280,
  });
  return { text: reply.text.trim(), usage: reply.usage };
}

function pack(text: string, payload: AnswerPayload, usage: Usage): Rendered {
  const facts = extractFacts(text, payload);
  return {
    text,
    used_message_ids: facts.messageIds,
    mentioned_dates: facts.dates,
    facts,
    usage,
  };
}

function add(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    costInr: a.costInr === null || b.costInr === null ? null : a.costInr + b.costInr,
  };
}
