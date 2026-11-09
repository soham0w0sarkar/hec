import { AnswerPayloadSchema, type AnswerPayload } from "@hec/core";
import { ZERO_USAGE, type ChatModel, type Usage } from "@hec/llm";
import { voiceFallbackText } from "./fallback";
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
  /** Set when both model attempts failed the fact check and the voice fallback was used. */
  fallbackReasons: string[] | null;
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
  const first = await askSafe(model, voice, checked, null);
  if (!first.reply) {
    return pack(voiceFallbackText(checked), checked, ZERO_USAGE, [first.error]);
  }
  const firstLead = cleanLead(first.reply.text);
  const firstSpoken = composeSpoken(firstLead, checked);
  const firstReasons = reasonsFor(firstLead, firstSpoken, checked);
  if (firstReasons.length === 0) {
    return pack(firstSpoken, checked, first.reply.usage);
  }

  const second = await askSafe(model, voice, checked, firstReasons);
  if (!second.reply) {
    return pack(voiceFallbackText(checked), checked, first.reply.usage, [second.error]);
  }
  const usage = add(first.reply.usage, second.reply.usage);
  const secondLead = cleanLead(second.reply.text);
  const secondSpoken = composeSpoken(secondLead, checked);
  const secondReasons = reasonsFor(secondLead, secondSpoken, checked);
  if (secondReasons.length === 0) {
    return pack(secondSpoken, checked, usage);
  }
  return pack(voiceFallbackText(checked), checked, usage, secondReasons);
}

function reasonsFor(lead: string, spoken: string, payload: AnswerPayload): string[] {
  return [...validateLead(lead, payload), ...validateRender(spoken, payload)];
}

/** Drops leaked prompt tags some models echo into the lead. */
export function cleanLead(text: string): string {
  return text
    .replace(/<\/?(?:start_of_lead|end_of_lead|payload|lead)\b[^>]*>/gi, "")
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .trim();
}

type Reply = { text: string; usage: Usage };

async function askSafe(
  model: ChatModel,
  persona: Persona,
  payload: AnswerPayload,
  failures: string[] | null,
): Promise<{ reply: Reply; error: null } | { reply: null; error: string }> {
  try {
    return { reply: await ask(model, persona, payload, failures), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { reply: null, error: `persona model failed: ${message}` };
  }
}

async function ask(
  model: ChatModel,
  persona: Persona,
  payload: AnswerPayload,
  failures: string[] | null,
): Promise<Reply> {
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

function pack(
  text: string,
  payload: AnswerPayload,
  usage: Usage,
  fallbackReasons: string[] | null = null,
): Rendered {
  const facts = extractFacts(text, payload);
  return {
    text,
    used_message_ids: facts.messageIds,
    mentioned_dates: facts.dates,
    facts,
    usage,
    fallbackReasons,
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
