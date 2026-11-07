import type { PersonId } from "@hec/core";
import type { RawEvent } from "./schema";
import { parseLocal } from "./time";
import type { Candidate, ExtractionMessage, SpeakerLabels } from "./types";

/** Invented names. Tests use these exactly as the real labels from the people table are used. */
export const LABELS: SpeakerLabels = { person_1: "Ravi", person_2: "Anita" };

/** `at` is IST wall time, `YYYY-MM-DD HH:mm`. */
export function msg(
  id: number,
  at: string,
  personId: PersonId,
  text: string,
  extra: Partial<ExtractionMessage> = {},
): ExtractionMessage {
  const parsed = parseLocal(at);
  if (!parsed) throw new Error(`bad test date ${at}`);
  return { id, personId, sentAt: parsed.instant, text, source: "instagram", kind: "text", ...extra };
}

export function messageMap(messages: ExtractionMessage[]): Map<number, ExtractionMessage> {
  return new Map(messages.map((message) => [message.id, message]));
}

/** A validation context over these messages, with the test labels. */
export function ctx(messages: ExtractionMessage[]) {
  return { messages: messageMap(messages), labels: LABELS };
}

export function raw(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    category: "Meetup",
    title: "Coffee together",
    summary: "They met for coffee.",
    occurred_at: "2030-01-05 18:00",
    date_precision: "day",
    ended_at: null,
    significance: 1,
    is_first: false,
    first_of: null,
    evidence: [{ ref: "m1", role: "primary" }],
    saying: null,
    ...overrides,
  };
}

export function candidate(overrides: Partial<Candidate> = {}): Candidate {
  const at = parseLocal("2030-01-05 18:00")!.instant;
  return {
    category: "Meetup",
    title: "Coffee together",
    summary: "They met for coffee.",
    occurredAt: at,
    datePrecision: "exact_day",
    endedAt: null,
    significance: 1,
    isFirst: false,
    firstOf: null,
    saying: null,
    evidence: [{ messageId: 1, role: "primary" }],
    evidenceFrom: at,
    evidenceTo: at,
    ...overrides,
  };
}
