import {
  AnswerPayloadSchema,
  CONFIDENCE_LEVELS,
  QUESTION_TYPES,
  SENSITIVITY_LEVELS,
  VERDICTS,
  type AnswerClaim,
  type AnswerPayload,
  type ClaimBasis,
  type Confidence,
  type QuestionType,
  type Sensitivity,
  type Verdict,
} from "@hec/core";
import type { Ledger, LedgerMessage } from "./ledger";
import { questionIsHeavy, questionWantsIntimate } from "./sensitive";

/** Two first/last hits closer than this, from different people, are not a single winner. */
export const CLOSE_MATCH_MS = 60 * 60 * 1000;

const EMOJI = /\p{Extended_Pictographic}/gu;
const JOKE = /\b(lol|lmao|haha|rofl)\b/gi;

/**
 * Turns the model's draft into a payload that only says what this run's tools returned.
 * A bad quote is removed. A claim that then has nothing to stand on is dropped.
 * Sensitivity is raised for a heavy question or a Conflict event. An unreadable sensitivity becomes heavy.
 */
export function enforce(draft: unknown, ledger: Ledger, question: string): AnswerPayload {
  const record = asRecord(draft);
  const questionType = known(QUESTION_TYPES, record.question_type) ?? inferQuestionType(ledger);
  const sensitivity = resolveSensitivity(question, ledger, record.sensitivity);
  const look = ledger.looks.find((item) => item.tool === "find_first") ?? ledger.looks[0] ?? null;
  const forced = questionType === "first_last" ? closePair(look, ledger) : null;

  let dropped = 0;
  const claims: AnswerClaim[] = [];
  const rawClaims = Array.isArray(record.claims) ? record.claims : [];
  for (const raw of rawClaims) {
    const claim = cleanClaim(raw, ledger, question);
    if (claim) claims.push(claim);
    else dropped += 1;
    if (claims.length === 12) break;
  }

  if (forced) {
    for (const message of [forced.a, forced.b]) {
      if (claims.some((claim) => claim.message_ids.includes(message.id))) continue;
      const built = claimFor(message);
      if (built && claims.length < 12) claims.push(built);
    }
  }

  let verdict: Verdict = known(VERDICTS, record.verdict) ?? (claims.length > 0 ? "found" : "not_found");
  const caveats = cleanList(record.caveats);
  if (verdict === "not_found") {
    claims.length = 0;
  } else if (verdict === "found" && claims.length === 0) {
    verdict = "not_found";
    caveats.push("No claim was supported by the search.");
  }
  if (forced && (verdict === "found" || verdict === "ambiguous")) verdict = "ambiguous";
  if (verdict === "ambiguous" && claims.length < 2) {
    caveats.push("The result is ambiguous, and only one supporting message was left after the checks.");
  }

  let confidence: Confidence = known(CONFIDENCE_LEVELS, record.confidence) ?? "medium";
  if (verdict === "ambiguous") confidence = "ambiguous";
  else if (verdict === "not_found" || verdict === "partial") confidence = "low";
  else if (dropped > 0 && confidence === "high") confidence = "medium";

  const interpretation = forced
    ? "Two matching messages are close in time, so this does not pick a single first."
    : verdict === "not_found"
      ? "Nothing in the search supported an answer."
      : plain(typeof record.interpretation_note === "string" ? record.interpretation_note : "", 500) ||
        "Read from the messages the search returned.";

  if (questionType === "first_last" && look) caveats.push(...alternativeCaveats(look, ledger));
  if (forced) {
    const minutes = Math.round(forced.gapMs / 60_000);
    caveats.push(
      minutes < 1
        ? "The top two matches are under a minute apart, so neither one is clearly first."
        : `The top two matches are ${minutes} minutes apart, so neither one is clearly first.`,
    );
  }

  const payload: AnswerPayload = {
    version: 1,
    question_type: questionType,
    verdict,
    interpretation_note: interpretation,
    claims,
    searched: {
      tools: ledger.tools.slice(0, 40),
      variants: ledger.variants.map((item) => item.slice(0, 80)).slice(0, 32),
      date_ranges: ledger.dateRanges.slice(0, 20).map((range) => ({
        from: range.from?.slice(0, 40) ?? null,
        until: range.until?.slice(0, 40) ?? null,
      })),
    },
    caveats: unique(caveats).slice(0, 12),
    confidence,
    sensitivity,
  };

  const parsed = AnswerPayloadSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  return AnswerPayloadSchema.parse({
    ...payload,
    question_type: "other",
    verdict: "partial",
    interpretation_note: "The draft answer could not be checked.",
    claims: [],
    caveats: ["The draft answer could not be checked, so nothing from it is included."],
    confidence: "low",
  });
}

export function inferQuestionType(ledger: Ledger): QuestionType {
  const tools = ledger.tools;
  if (tools.includes("find_first") || tools.includes("find_last")) return "first_last";
  if (tools.includes("count_matches") || tools.includes("matches_per_period")) return "count";
  if (tools.includes("get_day_transcript")) return "on_this_date";
  if (tools.includes("get_stats")) return "stats";
  if (tools.includes("list_events")) return "timeline";
  if (tools.some((tool) => ["keyword_search", "semantic_search", "hybrid_search", "get_context_around"].includes(tool))) {
    return "what_did_we_say";
  }
  return "other";
}

function cleanClaim(raw: unknown, ledger: Ledger, question: string): AnswerClaim | null {
  const record = asRecord(raw);
  const basis: ClaimBasis = known(["messages", "count", "stats", "timeline"] as const, record.basis) ?? "messages";
  const quote = typeof record.quote === "string" && record.quote.trim().length > 0 ? record.quote : null;
  const text = plain(typeof record.text === "string" ? record.text : "", 500);
  if (!text) return null;

  if (basis === "count" || basis === "stats") {
    if (quote) return null;
    if (!numbersFit(text, allowedFigures(ledger, basis, [], record.date))) return null;
    const date = typeof record.date === "string" && dayOk(record.date, ledger, basis) ? record.date : null;
    return { text, message_ids: [], date, person: null, source: null, quote: null, basis };
  }

  const ids = messageIds(record.message_ids).filter((id) => usableId(id, ledger, question, basis));
  if (basis === "messages" && ids.length === 0) return null;
  if (basis === "timeline" && !timelineOk(record, ledger, ids)) return null;

  const cited = ids.flatMap((id) => {
    const message = ledger.messages.get(id);
    return message ? [message] : [];
  });
  const person = typeof record.person === "string" ? plain(record.person, 80) : null;
  const source = record.source === "instagram" || record.source === "whatsapp" ? record.source : null;
  const date = typeof record.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.date) ? record.date : null;

  if (basis === "messages") {
    if (person && !cited.some((message) => message.name === person || message.personId === person)) return null;
    if (source && !cited.some((message) => message.source === source)) return null;
    if (date && !cited.some((message) => message.sentAtIst.startsWith(date))) return null;
  }
  if (basis === "timeline") {
    const events = eventsFor(ledger, ids, date);
    if (events.length === 0) return null;
    if (date && !events.some((event) => event.date === date)) return null;
    if (person && !cited.some((message) => message.name === person || message.personId === person)) return null;
  }

  let keptQuote = quote;
  if (keptQuote && !quoteFits(keptQuote, cited, ledger, basis, date)) {
    if (text.includes(keptQuote)) return null;
    keptQuote = null;
  }
  if (!numbersFit(text, allowedFigures(ledger, basis, ids, date))) return null;

  return {
    text,
    message_ids: ids,
    date,
    person: person || null,
    source,
    quote: keptQuote,
    basis,
  };
}

function usableId(id: number, ledger: Ledger, question: string, basis: ClaimBasis): boolean {
  const message = ledger.messages.get(id);
  if (message) {
    if (message.intimate && !questionWantsIntimate(question)) return false;
    return true;
  }
  if (basis !== "timeline") return false;
  return ledger.events.some((event) => event.evidenceIds.includes(id));
}

function timelineOk(record: Record<string, unknown>, ledger: Ledger, ids: number[]): boolean {
  const date = typeof record.date === "string" ? record.date : null;
  return eventsFor(ledger, ids, date).length > 0;
}

function eventsFor(ledger: Ledger, ids: number[], date: string | null) {
  return ledger.events.filter((event) => {
    if (date && event.date !== date) return false;
    if (ids.length > 0 && !ids.every((id) => event.evidenceIds.includes(id))) return false;
    return date !== null || ids.length > 0;
  });
}

function quoteFits(
  quote: string,
  cited: readonly LedgerMessage[],
  ledger: Ledger,
  basis: ClaimBasis,
  date: string | null,
): boolean {
  if (cited.some((message) => message.text.includes(quote))) return true;
  if (basis !== "timeline") return false;
  return eventsFor(ledger, cited.map((message) => message.id), date).some((event) => event.quote?.includes(quote));
}

function allowedFigures(ledger: Ledger, basis: ClaimBasis, ids: number[], date: unknown): Set<number> {
  const ok = new Set<number>(basis === "count" || basis === "stats" ? ledger.figures : []);
  for (const id of ids) ok.add(id);
  const days = [typeof date === "string" ? date : "", ...(basis === "stats" ? ledger.statDates : [])];
  if (basis === "timeline") {
    for (const event of ledger.events) {
      ok.add(event.id);
      days.push(event.date);
      for (const id of event.evidenceIds) ok.add(id);
    }
  }
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(day)) continue;
    for (const part of day.slice(0, 10).split("-")) ok.add(Number(part));
  }
  return ok;
}

function numbersFit(text: string, allowed: Set<number>): boolean {
  const found = text.match(/\d+/g) ?? [];
  return found.every((item) => allowed.has(Number(item)));
}

function dayOk(date: string, ledger: Ledger, basis: ClaimBasis): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (basis === "stats") return ledger.statDates.has(date);
  return true;
}

function claimFor(message: LedgerMessage): AnswerClaim | null {
  if (message.intimate) return null;
  return {
    text: `${message.name} sent a matching message.`,
    message_ids: [message.id],
    date: message.sentAtIst.slice(0, 10),
    person: message.name,
    source: message.source,
    quote: message.text.length <= 200 ? message.text : null,
    basis: "messages",
  };
}

function closePair(
  look: Ledger["looks"][number] | null,
  ledger: Ledger,
): { a: LedgerMessage; b: LedgerMessage; gapMs: number } | null {
  if (!look?.hitId) return null;
  const first = ledger.messages.get(look.hitId);
  const secondId = look.runnerIds[0];
  const second = secondId === undefined ? undefined : ledger.messages.get(secondId);
  if (!first || !second || first.intimate || second.intimate) return null;
  if (first.personId === second.personId) return null;
  const gapMs = Math.abs(new Date(first.sentAt).getTime() - new Date(second.sentAt).getTime());
  if (gapMs > CLOSE_MATCH_MS) return null;
  return { a: first, b: second, gapMs };
}

function alternativeCaveats(look: Ledger["looks"][number], ledger: Ledger): string[] {
  const word = look.tool === "find_last" ? "Latest" : "Earliest";
  const lines: string[] = [];
  for (const row of look.byPerson) {
    const message = row.hitId === null ? undefined : ledger.messages.get(row.hitId);
    if (!message || message.intimate) {
      lines.push(`${word} match for ${row.personId}: none in this search.`);
      continue;
    }
    lines.push(`${word} match for ${message.name}: ${message.sentAtIst.slice(0, 10)} on ${message.source}.`);
  }
  const sourceBits = look.bySource.map((row) => {
    const message = row.hitId === null ? undefined : ledger.messages.get(row.hitId);
    if (!message || message.intimate) return `${row.source}: none in this search`;
    return `${row.source}: ${message.sentAtIst.slice(0, 10)}`;
  });
  if (sourceBits.length > 0) lines.push(`${word} by app: ${sourceBits.join("; ")}.`);
  return lines;
}

function resolveSensitivity(question: string, ledger: Ledger, raw: unknown): Sensitivity {
  if (questionIsHeavy(question) || ledger.events.some((event) => event.category === "Conflict")) return "heavy";
  const given = known(SENSITIVITY_LEVELS, raw);
  return given ?? "heavy";
}

function messageIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isInteger(item) && item > 0 && !ids.includes(item)) ids.push(item);
  }
  return ids.slice(0, 20);
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const text = plain(item, 400);
    return text ? [text] : [];
  });
}

function plain(value: string, max: number): string {
  return value.replace(EMOJI, "").replace(JOKE, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function known<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
