import type { DatePrecision, EvidenceRole, FirstCheck, PersonId, Significance } from "@hec/core";
import { checkFirsts, type FirstLookup, type FirstsOptions } from "./firsts";
import { mergeCandidates, type MergeOptions, type MergedCandidate, type SessionCandidates } from "./merge";
import type { EventCategory } from "./types";

/** One row for `events` plus its evidence, before it is written. */
export type FinalEvent = {
  title: string;
  summary: string;
  category: EventCategory;
  occurredAt: Date;
  datePrecision: DatePrecision;
  endedAt: Date | null;
  significance: Significance;
  isFirst: boolean;
  firstOf: string | null;
  firstCheck: FirstCheck | null;
  speakerId: PersonId | null;
  quote: string | null;
  evidence: { messageId: number; role: EvidenceRole }[];
};

export type PipelineOptions = {
  merge?: MergeOptions;
  firsts?: FirstsOptions;
};

/**
 * Pass 2 and pass 3 for one run: merge the sessions' candidates, check every first claim against
 * the whole history, then shape the rows. The database constraints are repeated here, so a
 * violation is a bug we see before any insert starts.
 */
export async function buildFinalEvents(
  sessions: readonly SessionCandidates[],
  lookup: FirstLookup,
  options: PipelineOptions = {},
): Promise<FinalEvent[]> {
  const merged = mergeCandidates(sessions, options.merge);
  const checked = await checkFirsts(merged, lookup, options.firsts);
  return checked.map(toFinalEvent);
}

export function toFinalEvent(candidate: MergedCandidate): FinalEvent {
  if (candidate.isFirst && candidate.firstCheck !== "verified") {
    throw new Error("internal: a first claim reached insert without a verified check");
  }
  if (candidate.category === "Saying" && candidate.saying === null) {
    throw new Error("internal: a Saying reached insert without a quote");
  }
  if (candidate.category !== "Saying" && candidate.saying !== null) {
    throw new Error("internal: a non-Saying carries a quote");
  }
  if (candidate.endedAt && candidate.endedAt.getTime() <= candidate.occurredAt.getTime()) {
    throw new Error("internal: ended_at is not after occurred_at");
  }

  return {
    title: candidate.title,
    summary: candidate.summary,
    category: candidate.category,
    occurredAt: candidate.occurredAt,
    datePrecision: candidate.datePrecision,
    endedAt: candidate.endedAt,
    significance: candidate.significance,
    isFirst: candidate.isFirst,
    firstOf: candidate.firstOf,
    firstCheck: candidate.firstCheck,
    speakerId: candidate.saying?.personId ?? null,
    quote: candidate.saying?.quote ?? null,
    evidence: candidate.evidence,
  };
}
