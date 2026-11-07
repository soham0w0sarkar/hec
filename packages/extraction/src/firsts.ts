import type { MergedCandidate } from "./merge";

/**
 * Finds the earliest message in the whole history that matches some search words, or null.
 * The default is keyword search from `@hec/retrieval` (see first-lookup.ts). Anything with this
 * shape works, which is also how tests stand in for the database.
 */
export type FirstLookup = (query: {
  text: string;
  /** Caller-supplied spellings, searched with the text in one query. Retrieval does not invent any. */
  variants?: readonly string[];
}) => Promise<{ messageId: number; sentAt: Date } | null>;

export type FirstsOptions = {
  /**
   * An earlier keyword match than this before the event's evidence counts against the claim.
   * Matches a little before the evidence are normal: people talk about a thing before it happens.
   */
  toleranceMs?: number;
};

export const DEFAULT_FIRST_TOLERANCE_MS = 24 * 60 * 60 * 1000;

const normalizeQuery = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Pass 3. `is_first` is a claim from one session, so it is checked against everything:
 *
 * 1. Search the whole history for the event's `first_of` words and take the earliest hit.
 * 2. No hit, or no search words: `unverified`, and `is_first` is cleared. The review file shows why.
 * 3. The earliest hit is well before this event's evidence (and is not part of it): `refuted`.
 * 4. Otherwise `verified`. Verified claims that point at the same earliest message and the same
 *    category are one kind of first. Only the earliest event of that kind keeps `is_first`; the
 *    rest become `superseded`.
 *
 * Events that never claimed a first are returned untouched.
 */
export async function checkFirsts(
  candidates: readonly MergedCandidate[],
  lookup: FirstLookup,
  options: FirstsOptions = {},
): Promise<MergedCandidate[]> {
  const tolerance = options.toleranceMs ?? DEFAULT_FIRST_TOLERANCE_MS;
  const cache = new Map<string, Awaited<ReturnType<FirstLookup>>>();
  const earliest = async (text: string) => {
    const key = normalizeQuery(text);
    if (!cache.has(key)) cache.set(key, await lookup({ text: key }));
    return cache.get(key) ?? null;
  };

  const results = [...candidates];
  const verified = new Map<string, number[]>();

  for (let index = 0; index < results.length; index++) {
    const candidate = results[index] as MergedCandidate;
    if (!candidate.isFirst) continue;

    if (candidate.firstOf === null) {
      results[index] = { ...candidate, isFirst: false, firstCheck: "unverified" };
      continue;
    }
    const hit = await earliest(candidate.firstOf);
    if (hit === null) {
      results[index] = { ...candidate, isFirst: false, firstCheck: "unverified" };
      continue;
    }

    const inEvidence = candidate.evidence.some((entry) => entry.messageId === hit.messageId);
    const earlier = hit.sentAt.getTime() < candidate.evidenceFrom.getTime() - tolerance;
    if (earlier && !inEvidence) {
      results[index] = { ...candidate, isFirst: false, firstCheck: "refuted" };
      continue;
    }

    results[index] = { ...candidate, firstCheck: "verified" };
    const key = `${candidate.category}:${hit.messageId}`;
    verified.set(key, [...(verified.get(key) ?? []), index]);
  }

  for (const indexes of verified.values()) {
    const [, ...rest] = [...indexes].sort((a, b) => {
      const left = results[a] as MergedCandidate;
      const right = results[b] as MergedCandidate;
      return left.occurredAt.getTime() - right.occurredAt.getTime() || left.evidenceFrom.getTime() - right.evidenceFrom.getTime();
    });
    for (const index of rest) {
      results[index] = { ...(results[index] as MergedCandidate), isFirst: false, firstCheck: "superseded" };
    }
  }

  return results;
}
