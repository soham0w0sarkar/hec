import type { DatePrecision, EventCategory, EvidenceRole, MessageKind, MessageSource, PersonId, Significance } from "@hec/core";
import { EVENT_CATEGORIES } from "@hec/core";

export { EVENT_CATEGORIES };
export type { EventCategory, Significance };

/** Pass 1 never emits a running joke. That needs several sessions and has its own pass. */
export const PASS_1_CATEGORIES = EVENT_CATEGORIES.filter(
  (category): category is Exclude<EventCategory, "Running joke"> => category !== "Running joke",
);
export type Pass1Category = (typeof PASS_1_CATEGORIES)[number];

/** What the LLM calls the precision. Stored as the `date_precision` enum. */
export const LLM_PRECISIONS = ["day", "month", "approx"] as const;
export type LlmPrecision = (typeof LLM_PRECISIONS)[number];
export const PRECISION_FROM_LLM: Record<LlmPrecision, DatePrecision> = {
  day: "exact_day",
  month: "month",
  approx: "approximate",
};

/** Speaker display name for each person id, read from the `people` table (set from PEOPLE_DISPLAY_NAMES). */
export type SpeakerLabels = Record<PersonId, string>;

/** A message as extraction needs it. Mirrors the `messages` columns. */
export type ExtractionMessage = {
  id: number;
  personId: PersonId;
  sentAt: Date;
  text: string;
  source: MessageSource;
  kind: MessageKind;
};

/** A validated pass 1 event. Nothing in here came from the model without a code check. */
export type Candidate = {
  category: Pass1Category;
  title: string;
  summary: string;
  occurredAt: Date;
  datePrecision: DatePrecision;
  endedAt: Date | null;
  significance: Significance;
  isFirst: boolean;
  /** What to search for to find the earliest matching message. Set when `isFirst` is claimed. */
  firstOf: string | null;
  saying: { personId: PersonId; quote: string } | null;
  /** At least one entry, at least one primary. Every id is a message of the session. */
  evidence: { messageId: number; role: EvidenceRole }[];
  /** Earliest and latest evidence message time. */
  evidenceFrom: Date;
  evidenceTo: Date;
};

export type { FirstCheck } from "@hec/core";
export { FIRST_CHECKS } from "@hec/core";
