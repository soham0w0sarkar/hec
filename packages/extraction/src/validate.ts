import { DISPLAY_TIMEZONE, type PersonId } from "@hec/core";
import { isCategory, isPass1Category } from "./categories";
import type { RawEvent } from "./schema";
import { dayKey, monthKey, parseLocal } from "./time";
import { collapseWhitespace, parseRef } from "./transcript";
import {
  PRECISION_FROM_LLM,
  type Candidate,
  type EventCategory,
  type ExtractionMessage,
  type Pass1Category,
  type SpeakerLabels,
} from "./types";

export const DROP_REASONS = [
  "invalid_category",
  "running_joke_in_pass_1",
  "no_evidence",
  "empty_text",
  "invalid_significance",
  "saying_without_quote",
  "quote_not_verbatim",
  "speaker_mismatch",
  "bad_date",
  "date_outside_evidence",
  "ended_not_after_start",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export type Dropped = { index: number; reason: DropReason };

export type ValidationContext = {
  /** Every usable message of the session. Evidence is checked against this, not against the model. */
  messages: ReadonlyMap<number, ExtractionMessage>;
  /** Names from the people table. A Saying's speaker must match one of them. */
  labels: SpeakerLabels;
  timeZone?: string;
};

type Check<T> = { ok: true; value: T } | { ok: false; reason: DropReason };
const pass = <T>(value: T): Check<T> => ({ ok: true, value });
const fail = (reason: DropReason): Check<never> => ({ ok: false, reason });

/** Exactly one category, spelled as in EVENT_CATEGORIES, and not "Running joke" in pass 1. */
export function checkCategory(value: unknown): Check<Pass1Category> {
  if (!isCategory(value)) return fail("invalid_category");
  if (!isPass1Category(value)) return fail("running_joke_in_pass_1");
  return pass(value);
}

export type ResolvedEvidence = {
  evidence: Candidate["evidence"];
  messages: ExtractionMessage[];
};

/**
 * Keeps only refs that are real messages of this session. An event needs at least one.
 * Duplicate refs collapse, and a primary role wins over supporting. If the model marked nothing
 * primary, the first valid ref becomes primary. Unknown refs are ignored, never trusted.
 */
export function checkEvidence(
  refs: readonly { ref: string; role: "primary" | "supporting" }[],
  messages: ReadonlyMap<number, ExtractionMessage>,
): Check<ResolvedEvidence> {
  const roles = new Map<number, "primary" | "supporting">();
  for (const entry of refs) {
    const id = parseRef(entry.ref);
    if (id === null || !messages.has(id)) continue;
    if (roles.get(id) !== "primary") roles.set(id, entry.role);
  }
  if (roles.size === 0) return fail("no_evidence");

  const ordered = [...roles.keys()].map((id) => messages.get(id) as ExtractionMessage);
  ordered.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id - b.id);
  const evidence = ordered.map((message) => ({
    messageId: message.id,
    role: roles.get(message.id) as "primary" | "supporting",
  }));
  if (!evidence.some((entry) => entry.role === "primary")) (evidence[0] as { role: string }).role = "primary";

  return pass({ evidence, messages: ordered });
}

/**
 * A quote must appear word for word in an evidence message. Case, punctuation and spelling are
 * compared as written. Only whitespace is flattened, because the transcript the model saw has
 * newlines turned into spaces. Returns the message the quote was found in.
 */
export function findQuote(quote: string, evidence: readonly ExtractionMessage[]): ExtractionMessage | null {
  const wanted = collapseWhitespace(quote);
  if (wanted === "") return null;
  return evidence.find((message) => collapseWhitespace(message.text).includes(wanted)) ?? null;
}

/** Names match case-insensitively, ignoring surrounding spaces. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function checkSaying(
  saying: RawEvent["saying"],
  evidence: readonly ExtractionMessage[],
  labels: SpeakerLabels,
): Check<{ personId: PersonId; quote: string }> {
  if (!saying || collapseWhitespace(saying.quote) === "") return fail("saying_without_quote");
  const source = findQuote(saying.quote, evidence);
  if (!source) return fail("quote_not_verbatim");
  // The speaker is whoever sent the message the quote is in. The model's name has to agree.
  if (!sameName(labels[source.personId], saying.speaker)) return fail("speaker_mismatch");
  return pass({ personId: source.personId, quote: collapseWhitespace(saying.quote) });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `occurred_at` has to fall inside the time range of the evidence, compared at the precision the
 * event claims: the calendar day for day and approximate dates, the month for month dates.
 *
 * A Life update may be dated one day before the messages that discuss it, because news is often
 * shared the day after it happened (or the same day). For that category the lower bound is one
 * day earlier than the first evidence message.
 */
export function checkTimeRange(
  occurredAt: Date,
  precision: Candidate["datePrecision"],
  evidence: readonly ExtractionMessage[],
  timeZone = DISPLAY_TIMEZONE,
  category: EventCategory = "Meetup",
): boolean {
  const key = precision === "month" ? monthKey : dayKey;
  const times = evidence.map((message) => message.sentAt.getTime());
  const earliest = Math.min(...times);
  const latest = Math.max(...times);
  const lowerInstant = category === "Life update" ? earliest - DAY_MS : earliest;
  const at = key(occurredAt, timeZone);
  return at >= key(new Date(lowerInstant), timeZone) && at <= key(new Date(latest), timeZone);
}

/** Applies every hard rule to one raw event. */
export function validateEvent(raw: RawEvent, context: ValidationContext): Check<Candidate> {
  const zone = context.timeZone ?? DISPLAY_TIMEZONE;

  const category = checkCategory(raw.category);
  if (!category.ok) return category;

  if (raw.title.trim() === "" || raw.summary.trim() === "") return fail("empty_text");
  if (!Number.isInteger(raw.significance) || raw.significance < 1 || raw.significance > 3) {
    return fail("invalid_significance");
  }

  const evidence = checkEvidence(raw.evidence, context.messages);
  if (!evidence.ok) return evidence;

  let saying: Candidate["saying"] = null;
  if (category.value === "Saying") {
    const checked = checkSaying(raw.saying, evidence.value.messages, context.labels);
    if (!checked.ok) return checked;
    saying = checked.value;
  }

  const occurred = parseLocal(raw.occurred_at, zone);
  if (!occurred) return fail("bad_date");
  const datePrecision = PRECISION_FROM_LLM[raw.date_precision];
  if (!checkTimeRange(occurred.instant, datePrecision, evidence.value.messages, zone, category.value)) {
    return fail("date_outside_evidence");
  }

  let endedAt: Date | null = null;
  if (raw.ended_at !== undefined && raw.ended_at !== null && raw.ended_at.trim() !== "") {
    const ended = parseLocal(raw.ended_at, zone);
    if (!ended) return fail("bad_date");
    if (ended.instant.getTime() <= occurred.instant.getTime()) return fail("ended_not_after_start");
    endedAt = ended.instant;
  }

  const firstOf = raw.first_of?.trim() ? raw.first_of.trim() : null;
  const times = evidence.value.messages.map((message) => message.sentAt.getTime());

  return pass({
    category: category.value,
    title: raw.title.trim(),
    summary: raw.summary.trim(),
    occurredAt: occurred.instant,
    datePrecision,
    endedAt,
    significance: raw.significance as Candidate["significance"],
    isFirst: raw.is_first,
    firstOf: raw.is_first ? firstOf : null,
    saying,
    evidence: evidence.value.evidence,
    evidenceFrom: new Date(Math.min(...times)),
    evidenceTo: new Date(Math.max(...times)),
  });
}

export type ValidationResult = {
  candidates: Candidate[];
  /** Index into the model's list and the rule that failed. Never the text. */
  dropped: Dropped[];
};

export function validateEvents(raw: readonly RawEvent[], context: ValidationContext): ValidationResult {
  const candidates: Candidate[] = [];
  const dropped: Dropped[] = [];

  raw.forEach((event, index) => {
    const checked = validateEvent(event, context);
    if (checked.ok) candidates.push(checked.value);
    else dropped.push({ index, reason: checked.reason });
  });

  return { candidates, dropped };
}

/** Drops by rule, for run records and logs. Counts only, so nothing from a message can leak. */
export function countDrops(dropped: readonly Dropped[]): Partial<Record<DropReason, number>> {
  const counts: Partial<Record<DropReason, number>> = {};
  for (const { reason } of dropped) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}
