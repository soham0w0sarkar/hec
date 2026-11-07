import type { DatePrecision } from "@hec/core";
import type { WindowedCandidate } from "./extract";
import type { Candidate, FirstCheck } from "./types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type MergeOptions = {
  /** How far apart two dates may be and still be the same event, by the looser precision. */
  tolerance?: Record<DatePrecision, number>;
  /** Minimum word overlap of two titles to merge across sessions. Same-session windows use evidence. */
  titleSimilarity?: number;
};

export const DEFAULT_MERGE_OPTIONS = {
  tolerance: { exact_day: 36 * HOUR, approximate: 7 * DAY, month: 31 * DAY },
  titleSimilarity: 0.6,
} as const satisfies Required<MergeOptions>;

/** One session's pass 1 output, in the run's time order. */
export type SessionCandidates = {
  sessionId: number;
  /** How many windows the session was split into, including windows with no events. */
  windows: number;
  candidates: readonly WindowedCandidate[];
};

export type MergedCandidate = Candidate & {
  /** Every session that contributed evidence. */
  sessionIds: number[];
  /** How many pass 1 events became this one. */
  mergedFrom: number;
  /** Set by pass 3. Null until then, and for events that never claimed a first. */
  firstCheck: FirstCheck | null;
};

type Node = { candidate: WindowedCandidate; sessionId: number; unit: number };

/**
 * Pass 2. The same event shows up twice when a long session is cut into overlapping windows, or
 * when something spans two neighbouring sessions. Two events merge when all of these hold:
 *
 * - they came from different windows that sit next to each other in time order,
 * - same category,
 * - their dates are close (each date is widened by the precision's tolerance, and the ranges
 *   must touch; `ended_at` stretches the range),
 * - same session: they cite at least one message in common.
 *   different sessions: a message belongs to one session, so evidence cannot overlap; their titles
 *   must share most of their words instead. A Saying only merges on shared evidence.
 *
 * A merged event keeps every evidence message. The text, date and precision come from one source
 * event, so they stay consistent with each other. A run never mixes with another run, because
 * this only sees one run's candidates.
 */
export function mergeCandidates(sessions: readonly SessionCandidates[], options: MergeOptions = {}): MergedCandidate[] {
  const tolerance = options.tolerance ?? DEFAULT_MERGE_OPTIONS.tolerance;
  const titleSimilarity = options.titleSimilarity ?? DEFAULT_MERGE_OPTIONS.titleSimilarity;

  const nodes: Node[] = [];
  let offset = 0;
  for (const session of sessions) {
    for (const candidate of session.candidates) {
      nodes.push({ candidate, sessionId: session.sessionId, unit: offset + candidate.window });
    }
    offset += Math.max(1, session.windows);
  }

  const parent = nodes.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[index] !== root) {
      const next = parent[index] as number;
      parent[index] = root;
      index = next;
    }
    return root;
  };

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i] as Node;
      const b = nodes[j] as Node;
      if (isSameEvent(a, b, tolerance, titleSimilarity)) parent[find(j)] = find(i);
    }
  }

  const groups = new Map<number, Node[]>();
  nodes.forEach((node, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), node]);
  });

  return [...groups.values()]
    .map(combine)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || firstEvidence(a) - firstEvidence(b));
}

const firstEvidence = (candidate: Candidate) => candidate.evidence[0]?.messageId ?? 0;

function isSameEvent(
  a: Node,
  b: Node,
  tolerance: Record<DatePrecision, number>,
  titleSimilarity: number,
): boolean {
  if (a.unit === b.unit || Math.abs(a.unit - b.unit) > 1) return false;
  if (a.candidate.category !== b.candidate.category) return false;
  if (!rangesTouch(a.candidate, b.candidate, tolerance)) return false;

  const shared = sharesEvidence(a.candidate, b.candidate);
  if (a.sessionId === b.sessionId) return shared;
  if (a.candidate.category === "Saying") return shared;
  return shared || wordOverlap(a.candidate.title, b.candidate.title) >= titleSimilarity;
}

function rangesTouch(a: Candidate, b: Candidate, tolerance: Record<DatePrecision, number>): boolean {
  const slack = Math.max(tolerance[a.datePrecision], tolerance[b.datePrecision]);
  const end = (c: Candidate) => (c.endedAt ?? c.occurredAt).getTime();
  return a.occurredAt.getTime() <= end(b) + slack && b.occurredAt.getTime() <= end(a) + slack;
}

function sharesEvidence(a: Candidate, b: Candidate): boolean {
  const ids = new Set(a.evidence.map((entry) => entry.messageId));
  return b.evidence.some((entry) => ids.has(entry.messageId));
}

function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 2),
  );
}

/** Jaccard overlap of the two titles' words, 0 to 1. */
export function wordOverlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const word of left) if (right.has(word)) common++;
  return common / (left.size + right.size - common);
}

const PRECISION_RANK: Record<DatePrecision, number> = { exact_day: 0, month: 1, approximate: 2 };

function combine(group: Node[]): MergedCandidate {
  const members = group.map((node) => node.candidate);

  // The event with the most evidence supplies the words. The most precise date supplies the date.
  const byEvidence = [...members].sort((a, b) => b.evidence.length - a.evidence.length);
  const byDate = [...members].sort(
    (a, b) =>
      PRECISION_RANK[a.datePrecision] - PRECISION_RANK[b.datePrecision] || a.occurredAt.getTime() - b.occurredAt.getTime(),
  );
  const text = byEvidence[0] as Candidate;
  const date = byDate[0] as Candidate;

  const roles = new Map<number, "primary" | "supporting">();
  for (const member of members) {
    for (const entry of member.evidence) {
      if (roles.get(entry.messageId) !== "primary") roles.set(entry.messageId, entry.role);
    }
  }
  const evidence = [...roles].map(([messageId, role]) => ({ messageId, role }));

  const ends = members.flatMap((member) => (member.endedAt ? [member.endedAt.getTime()] : []));
  let endedAt = ends.length === 0 ? null : new Date(Math.max(...ends));
  if (endedAt && endedAt.getTime() <= date.occurredAt.getTime()) endedAt = null;

  // The merged range is the union of the sources, so the date still sits inside the evidence.
  const evidenceFrom = new Date(Math.min(...members.map((member) => member.evidenceFrom.getTime())));
  const evidenceTo = new Date(Math.max(...members.map((member) => member.evidenceTo.getTime())));

  const claimsFirst = members.filter((member) => member.isFirst);
  const firstSource = claimsFirst.find((member) => member.firstOf !== null) ?? claimsFirst[0];

  return {
    category: text.category,
    title: text.title,
    summary: text.summary,
    occurredAt: date.occurredAt,
    datePrecision: date.datePrecision,
    endedAt,
    significance: Math.max(...members.map((member) => member.significance)) as Candidate["significance"],
    isFirst: claimsFirst.length > 0,
    firstOf: firstSource?.firstOf ?? null,
    saying: text.saying ?? members.find((member) => member.saying)?.saying ?? null,
    evidence,
    evidenceFrom,
    evidenceTo,
    sessionIds: [...new Set(group.map((node) => node.sessionId))],
    mergedFrom: members.length,
    firstCheck: null,
  };
}
