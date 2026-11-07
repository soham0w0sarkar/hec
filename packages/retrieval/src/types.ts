import type {
  MessageKind,
  MessageSource,
  PersonId,
} from "@hec/core";

export const MATCH_MODES = ["phrase", "any_word", "fuzzy"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const FOLD_FORMS = ["two", "one"] as const;
/** `two` collapsed a letter run of 3+ down to 2, or no collapse was needed. `one` collapsed it to a single letter. */
export type FoldForm = (typeof FOLD_FORMS)[number];

export type MatchKind = "exact" | "fuzzy";

export const PERIODS = ["day", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];

/**
 * Filters shared by the search functions.
 * `from` is inclusive and `until` is exclusive, both UTC instants.
 * `kinds` defaults to text, media, call, and share, which leaves out system and unsent.
 * Pass `kinds` yourself to include those. Empty and whitespace-only text is left out
 * unless `includeEmpty` is set.
 */
export type SearchFilters = {
  personId?: PersonId;
  source?: MessageSource;
  kinds?: readonly MessageKind[];
  includeEmpty?: boolean;
  from?: Date;
  until?: Date;
};

/** A citable message. `text` is the stored original, not a cleaned copy. */
export type MessageHit = {
  id: number;
  personId: PersonId;
  name: string;
  sentAt: Date;
  /** `YYYY-MM-DD HH:mm:ss` in the display timezone. */
  sentAtIst: string;
  text: string;
  source: MessageSource;
  sourceRef: string;
  kind: MessageKind;
  sessionId: number | null;
};

export type KeywordHit = MessageHit & {
  match: MatchKind;
  form: FoldForm;
  /** 1 for an exact token match. Word similarity in (0, 1] for fuzzy. */
  score: number;
};

export type ChunkHit = {
  id: number;
  sessionId: number;
  firstMessageId: number;
  lastMessageId: number;
  messageCount: number;
  transcript: string;
  from: Date;
  until: Date;
  fromIst: string;
  untilIst: string;
  /** Cosine similarity, 1 - distance. */
  score: number;
  model: string;
};
