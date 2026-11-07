// Shared types for the chat schema. SQL lives in @hec/db.
// Column names there are snake_case; these fields are camelCase.
// Message times are UTC instants. Asia/Kolkata is the seeded display timezone.

/** Person ids. Display names are not stored here; see PEOPLE_DISPLAY_NAMES in @hec/db. */
export const PERSON_IDS = ["person_1", "person_2"] as const;
export type PersonId = (typeof PERSON_IDS)[number];

export const MESSAGE_SOURCES = ["instagram", "whatsapp"] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

export const MESSAGE_KINDS = ["text", "media", "call", "share", "system", "unsent"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Kinds that count as conversation in daily_stats and search. */
export const COUNTED_MESSAGE_KINDS = ["text", "media", "call", "share"] as const;

export const DATE_PRECISIONS = ["exact_day", "month", "approximate"] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

export const EVENT_STATUSES = ["draft", "approved", "edited", "rejected"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** The nine timeline categories, spelled exactly like this in the database and the review file. */
export const EVENT_CATEGORIES = [
  "Milestone",
  "Meetup",
  "Trip",
  "Celebration",
  "Plan",
  "Conflict",
  "Running joke",
  "Saying",
  "Life update",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const SIGNIFICANCE_LEVELS = [1, 2, 3] as const;
export type Significance = (typeof SIGNIFICANCE_LEVELS)[number];

/** Statuses the timeline page shows. */
export const TIMELINE_EVENT_STATUSES = ["approved", "edited"] as const;

export const EVIDENCE_ROLES = ["primary", "supporting"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

export const RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Seeded into app_settings. Stored instants are still UTC. */
export const DISPLAY_TIMEZONE = "Asia/Kolkata";

/**
 * pgvector column width. HNSW indexes top out at 2000 dimensions.
 * A new model of this width is a re-embed. A different width needs a migration.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** Postgres text search config. The english config drops "I" and "you". */
export const SEARCH_REGCONFIG = "simple";

/** Reactions, shared-link info, call duration, media type. Keys differ per source. */
export type MessageExtras = Record<string, unknown>;

export type Person = {
  id: PersonId;
  name: string;
};

export type SourceIdentity = {
  source: MessageSource;
  rawName: string;
  personId: PersonId;
};

export type Message = {
  id: number;
  personId: PersonId;
  sentAt: Date;
  text: string;
  source: MessageSource;
  sourceRef: string;
  kind: MessageKind;
  extras: MessageExtras;
  sessionId: number | null;
};

export type Session = {
  id: number;
  startedAt: Date;
  endedAt: Date;
  messageCount: number;
  sources: MessageSource[];
};

export type Chunk = {
  id: number;
  sessionId: number;
  position: number;
  firstMessageId: number;
  lastMessageId: number;
  messageCount: number;
  transcript: string;
  embedding: number[] | null;
  embeddingModel: string | null;
};

export type ExtractionRun = {
  id: number;
  model: string;
  promptVersion: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
};

export type Event = {
  id: number;
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
  /** Set for Saying events only. */
  speakerId: PersonId | null;
  quote: string | null;
  status: EventStatus;
  extractionRunId: number;
};

export const FIRST_CHECKS = ["verified", "refuted", "unverified", "superseded"] as const;
export type FirstCheck = (typeof FIRST_CHECKS)[number];

export type EventEvidence = {
  eventId: number;
  messageId: number;
  role: EvidenceRole;
};

export type DailyStat = {
  day: string;
  personId: PersonId;
  source: MessageSource;
  messageCount: number;
  firstMessageAt: Date;
  callCount: number;
};

export type IngestRun = {
  id: number;
  source: MessageSource;
  fileName: string;
  fileHash: string;
  rowsSeen: number | null;
  rowsInserted: number | null;
  rowsSkipped: number | null;
  status: RunStatus;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

export {
  ANSWER_PAYLOAD_VERSION,
  AnswerClaimSchema,
  AnswerPayloadSchema,
  CLAIM_BASES,
  CONFIDENCE_LEVELS,
  QUESTION_TYPES,
  SENSITIVITY_LEVELS,
  VERDICTS,
} from "./answer-payload";
export type { AnswerClaim, AnswerPayload, ClaimBasis, Confidence, QuestionType, Sensitivity, Verdict } from "./answer-payload";
