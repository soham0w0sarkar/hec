import type { AnswerPayload, Verdict } from "@hec/core";

const DATE = /\d{4}-\d{2}-\d{2}/g;
const QUOTED = /"([^"]+)"|“([^”]+)”/g;

/**
 * Natural ways to say the search came back empty. The receipts state the verdict,
 * so the lead only has to be honest, not use the literal token `not_found`.
 */
const NOT_FOUND =
  /not[_ ]found|nothing matched|nothing in the search|could not find|couldn'?t find|did not find|didn'?t find|no message|no record|nothing on record|nothing recorded|not in the record|not on record|came up empty|came back empty|come up empty|turned up empty|no trace|no sign|no mention|no match|no such|don'?t have|doesn'?t have|isn'?t there|not there|nothing there/i;

const PARTIAL = /\bpartial\b|\bonly part\b|\bpart of it\b|\bincomplete\b/i;

const AMBIGUOUS =
  /\b(ambiguous|unclear|either|both|not certain|cannot tell|can'?t tell|too close|don'?t agree|doesn'?t settle|not settled)\b/i;

/** Joke and innuendo markers. Soft mode rejects a render that contains any of these. */
const SOFT_BAN =
  /\b(plot twist|slow burn|yearning|archives?|flirt|flirty|tease|teasing|chapter|innuendo|cheeky|lol|lmao|haha|wink|sexy|shamelessly)\b|😉|;\)/i;

export type FactCheck = {
  dates: string[];
  quotes: string[];
  messageIds: number[];
  verdict: Verdict | null;
};

/** Reasons the full spoken reply is not allowed. Empty means it passed. No model is involved. */
export function validateRender(text: string, payload: AnswerPayload): string[] {
  const reasons: string[] = [];
  const allowedDates = dateSet(payload);
  const allowedQuotes = new Set(payload.claims.flatMap((claim) => (claim.quote ? [claim.quote] : [])));
  const allowedNumbers = numberSet(payload);

  for (const date of text.match(DATE) ?? []) {
    if (!allowedDates.has(date)) reasons.push(`date ${date} is not in the payload`);
  }
  for (const claim of payload.claims) {
    if (claim.date && !text.includes(claim.date)) reasons.push(`missing date ${claim.date}`);
    if (claim.quote && !text.includes(claim.quote)) reasons.push("missing a payload quote");
    for (const id of claim.message_ids) {
      if (!numberTokens(text).has(id)) reasons.push(`missing message id ${id}`);
    }
  }
  for (const caveat of payload.caveats) {
    if (!text.includes(caveat)) reasons.push("missing a caveat");
  }
  for (const span of quotedSpans(text)) {
    if (!allowedQuotes.has(span)) reasons.push("quoted text is not a payload quote");
  }
  for (const value of numberTokens(text)) {
    if (!allowedNumbers.has(value)) reasons.push(`number ${value} is not in the payload`);
  }
  reasons.push(...verdictReasons(text, payload));
  if (payload.sensitivity === "heavy" && SOFT_BAN.test(withoutPayloadQuotes(text, payload))) {
    reasons.push("soft mode forbids jokes and innuendo");
  }
  if (text.length > 4000) reasons.push("reply is too long");
  return reasons;
}

/**
 * Checks only the model lead. Receipts are appended in code, so the lead must not invent
 * dates, numbers, or quotes, and must keep the verdict honest. It does not need to list claims.
 */
export function validateLead(text: string, payload: AnswerPayload): string[] {
  const reasons: string[] = [];
  const allowedQuotes = new Set(payload.claims.flatMap((claim) => (claim.quote ? [claim.quote] : [])));
  const allowedNumbers = numberSet(payload);
  const citedIds = new Set(payload.claims.flatMap((claim) => claim.message_ids));
  for (const date of text.match(DATE) ?? []) {
    reasons.push(`lead repeated the date ${date}`);
  }
  for (const span of quotedSpans(text)) {
    if (!allowedQuotes.has(span)) reasons.push("quoted text is not a payload quote");
  }
  for (const value of numberTokens(text)) {
    if (citedIds.has(value)) reasons.push(`lead repeated message id ${value}`);
    else if (!allowedNumbers.has(value)) reasons.push(`number ${value} is not in the payload`);
  }
  if (unbalancedQuotes(text)) reasons.push("unbalanced quotation marks");
  if (/\b(caveats?|confidence|verdict|message ids?|dates?|quotes?)\b|will follow|listed below|shown below/i.test(text)) {
    reasons.push("lead narrated the appendix");
  }
  if (payload.verdict === "not_found" && /not_found|verdict\s*:/i.test(text)) {
    reasons.push("not_found used a label");
  }
  reasons.push(...verdictReasons(text, payload));
  if (payload.sensitivity === "heavy" && SOFT_BAN.test(withoutPayloadQuotes(text, payload))) {
    reasons.push("soft mode forbids jokes and innuendo");
  }
  if (/<\/?(?:payload|start_of_lead|end_of_lead|lead)\b/i.test(text)) {
    reasons.push("lead leaked prompt tags");
  }
  if (text.length > 900) reasons.push("lead is too long");
  return reasons;
}

function unbalancedQuotes(text: string): boolean {
  const straight = (text.match(/"/g) ?? []).length;
  const open = (text.match(/“/g) ?? []).length;
  const close = (text.match(/”/g) ?? []).length;
  return straight % 2 === 1 || open !== close;
}

export function extractFacts(text: string, payload: AnswerPayload): FactCheck {
  const quotes = payload.claims.flatMap((claim) => (claim.quote && text.includes(claim.quote) ? [claim.quote] : []));
  const ids = [...new Set(payload.claims.flatMap((claim) => claim.message_ids))].filter((id) => numberTokens(text).has(id));
  return {
    dates: [...new Set(text.match(DATE) ?? [])],
    quotes,
    messageIds: ids,
    verdict: readVerdict(text),
  };
}

export function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const match of text.matchAll(QUOTED)) {
    const span = match[1] ?? match[2];
    if (span) spans.push(span);
  }
  return spans;
}

function verdictReasons(text: string, payload: AnswerPayload): string[] {
  const reasons: string[] = [];
  if (payload.verdict === "not_found" && !NOT_FOUND.test(text)) {
    reasons.push("not_found was not said");
  }
  if (payload.verdict === "not_found" && /\b(at least|luckily|probably|maybe they|i bet)\b/i.test(text)) {
    reasons.push("not_found invented a consolation");
  }
  const ambiguous = payload.verdict === "ambiguous" || payload.confidence === "ambiguous";
  if (ambiguous && !AMBIGUOUS.test(text)) {
    reasons.push("ambiguous was phrased as settled");
  }
  if (ambiguous && /\b(definitely|certainly|without a doubt|no question|the one and only)\b/i.test(text)) {
    reasons.push("ambiguous was phrased as certain");
  }
  if (payload.verdict === "partial" && !PARTIAL.test(text)) reasons.push("partial was not said");
  if (payload.verdict === "found" && readVerdict(text) !== "found") reasons.push("verdict was not kept");
  return reasons;
}

export function readVerdict(text: string): Verdict | null {
  if (NOT_FOUND.test(text)) return "not_found";
  if (/\bambiguous\b/i.test(text)) return "ambiguous";
  if (PARTIAL.test(text)) return "partial";
  if (/\bfound\b/i.test(text)) return "found";
  return null;
}

function dateSet(payload: AnswerPayload): Set<string> {
  const dates = new Set<string>();
  for (const value of strings(payload)) {
    for (const date of value.match(DATE) ?? []) dates.add(date);
  }
  return dates;
}

function numberSet(payload: AnswerPayload): Set<number> {
  const numbers = new Set<number>();
  for (const claim of payload.claims) for (const id of claim.message_ids) numbers.add(id);
  for (const value of strings(payload)) {
    for (const token of value.match(/\d+/g) ?? []) numbers.add(Number(token));
  }
  return numbers;
}

function numberTokens(text: string): Set<number> {
  return new Set((text.match(/\d+/g) ?? []).map(Number));
}

function withoutPayloadQuotes(text: string, payload: AnswerPayload): string {
  let stripped = text;
  for (const claim of payload.claims) {
    if (claim.quote) stripped = stripped.replaceAll(claim.quote, "");
  }
  return stripped;
}

function strings(payload: AnswerPayload): string[] {
  const values = [payload.interpretation_note, payload.verdict, payload.confidence, ...payload.caveats, ...payload.searched.variants];
  for (const claim of payload.claims) {
    values.push(claim.text);
    if (claim.date) values.push(claim.date);
    if (claim.person) values.push(claim.person);
    if (claim.quote) values.push(claim.quote);
    if (claim.source) values.push(claim.source);
  }
  for (const range of payload.searched.date_ranges) {
    if (range.from) values.push(range.from);
    if (range.until) values.push(range.until);
  }
  return values;
}
