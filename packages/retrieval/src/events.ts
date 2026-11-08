import type { SQL } from "bun";
import {
  DATE_PRECISIONS,
  EVENT_CATEGORIES,
  TIMELINE_EVENT_STATUSES,
  type DatePrecision,
  type EventCategory,
  type PersonId,
} from "@hec/core";
import { withCache } from "./cache";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./constants";
import { RetrievalError } from "./errors";
import { readDataVersion, runRead } from "./query";
import { asCount, asId, known } from "./rows";
import type { RetrievalOptions } from "./keyword";

/** Evidence message ids returned with one event. Extra ids are dropped and `evidenceTruncated` is set. */
export const MAX_EVIDENCE_IDS = 50;

export type EventListQuery = {
  category?: EventCategory;
  /** Inclusive UTC instant. */
  from?: Date;
  /** Exclusive UTC instant. */
  until?: Date;
  limit?: number;
  /** Opaque cursor from the previous page. */
  after?: string;
  /** Only events the reviewer put on the timeline. Chat leaves this off and sees every approved event. */
  onTimelineOnly?: boolean;
};

export type EventHit = {
  id: number;
  title: string;
  summary: string;
  category: EventCategory;
  occurredAt: Date;
  /** `YYYY-MM-DD HH:mm:ss` in the display timezone. */
  occurredAtIst: string;
  datePrecision: DatePrecision;
  endedAt: Date | null;
  significance: number;
  highlight: boolean;
  isFirst: boolean;
  firstOf: string | null;
  speakerId: PersonId | null;
  quote: string | null;
  status: "approved" | "edited";
  evidenceMessageIds: number[];
  evidenceTruncated: boolean;
};

export type EventPage = {
  events: EventHit[];
  next: string | null;
};

type PreparedEvents = {
  category: EventCategory | null;
  from: Date | null;
  until: Date | null;
  limit: number;
  after: { occurredAt: Date; id: number } | null;
  onTimelineOnly: boolean;
};

type EventRow = {
  id: string | number;
  title: string;
  summary: string;
  category: string;
  occurred_at: Date | string;
  occurred_at_ist: string;
  date_precision: string;
  ended_at: Date | string | null;
  significance: number;
  highlight: boolean;
  is_first: boolean;
  first_of: string | null;
  speaker_id: string | null;
  quote: string | null;
  status: string;
  evidence_ids: unknown;
  evidence_count: string | number;
};

/**
 * Approved and edited timeline events, oldest first, then by id.
 * Drafts and rejected rows are never returned. `from` is inclusive, `until` is exclusive.
 * Each row carries its evidence message ids, capped at MAX_EVIDENCE_IDS.
 */
export async function listEvents(sql: SQL, query: EventListQuery = {}, options: RetrievalOptions = {}): Promise<EventPage> {
  const prepared = prepareEventList(query);
  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(
    version,
    options.cache,
    "events",
    cachePayload(prepared),
    () =>
      runRead(sql, async (tx) => {
        const statement = eventStatement(prepared);
        const rows = (await tx.unsafe(statement.sql, statement.params)) as EventRow[];
        const more = rows.length > prepared.limit;
        const page = rows.slice(0, prepared.limit).map(toEventHit);
        const last = page.at(-1);
        return { events: page, next: more && last ? encodeEventCursor(last) : null };
      }, options),
    revive,
  );
}

export function prepareEventList(query: EventListQuery): PreparedEvents {
  const category = query.category === undefined ? null : knownCategory(query.category);
  const from = query.from ?? null;
  const until = query.until ?? null;
  if (from && Number.isNaN(from.getTime())) throw new RetrievalError("invalid_input", "from is not a real time");
  if (until && Number.isNaN(until.getTime())) throw new RetrievalError("invalid_input", "until is not a real time");
  if (from && until && from.getTime() > until.getTime()) throw new RetrievalError("invalid_input", "from is after until");
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RetrievalError("invalid_input", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  return {
    category,
    from,
    until,
    limit,
    after: query.after === undefined ? null : parseEventCursor(query.after),
    onTimelineOnly: query.onTimelineOnly === true,
  };
}

/** The page statement and its parameters. The category is a parameter, not concatenated text. */
export function eventStatement(query: PreparedEvents): { sql: string; params: unknown[] } {
  const sql = `
    select e.id, e.title, e.summary, e.category, e.occurred_at,
      format_display_time(e.occurred_at) as occurred_at_ist,
      e.date_precision, e.ended_at, e.significance, e.highlight, e.is_first, e.first_of,
      e.speaker_id, e.quote, e.status,
      coalesce((
        select jsonb_agg(message_id order by message_id)
        from (
          select message_id from event_evidence
          where event_id = e.id
          order by message_id
          limit ${MAX_EVIDENCE_IDS}
        ) capped
      ), '[]'::jsonb) as evidence_ids,
      (select count(*) from event_evidence where event_id = e.id) as evidence_count
    from events e
    where e.status in ('approved', 'edited')
      and ($1::text is null or e.category = $1)
      and ($2::timestamptz is null or e.occurred_at >= $2)
      and ($3::timestamptz is null or e.occurred_at < $3)
      and (
        $4::timestamptz is null
        or (e.occurred_at, e.id) > ($4::timestamptz, $5::bigint)
      )
      and ($7::boolean = false or e.on_timeline)
    order by e.occurred_at asc, e.id asc
    limit $6`;
  return {
    sql,
    params: [
      query.category,
      query.from?.toISOString() ?? null,
      query.until?.toISOString() ?? null,
      query.after?.occurredAt.toISOString() ?? null,
      query.after?.id ?? null,
      query.limit + 1,
      query.onTimelineOnly,
    ],
  };
}

export function encodeEventCursor(event: { occurredAt: Date; id: number }): string {
  return Buffer.from(JSON.stringify({ t: event.occurredAt.toISOString(), i: event.id }), "utf8").toString("base64url");
}

export function parseEventCursor(value: string): { occurredAt: Date; id: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new RetrievalError("invalid_input", "cursor is not valid");
  }
  if (parsed === null || typeof parsed !== "object") throw new RetrievalError("invalid_input", "cursor is not valid");
  const record = parsed as { t?: unknown; i?: unknown };
  const occurredAt = new Date(typeof record.t === "string" ? record.t : "");
  const id = typeof record.i === "number" ? record.i : Number(record.i);
  if (Number.isNaN(occurredAt.getTime()) || !Number.isSafeInteger(id) || id < 1) {
    throw new RetrievalError("invalid_input", "cursor is not valid");
  }
  return { occurredAt, id };
}

function toEventHit(row: EventRow): EventHit {
  const occurredAt = row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) throw new Error(`bad occurred_at for event ${row.id}`);
  const endedAt = row.ended_at === null ? null : row.ended_at instanceof Date ? row.ended_at : new Date(row.ended_at);
  if (endedAt && Number.isNaN(endedAt.getTime())) throw new Error(`bad ended_at for event ${row.id}`);
  const evidenceCount = asCount(row.evidence_count);
  const ids = evidenceIds(row.evidence_ids);
  return {
    id: asId(row.id),
    title: row.title,
    summary: row.summary,
    category: known(EVENT_CATEGORIES, row.category, "category"),
    occurredAt,
    occurredAtIst: row.occurred_at_ist,
    datePrecision: known(DATE_PRECISIONS, row.date_precision, "date precision"),
    endedAt,
    significance: asCount(row.significance),
    highlight: row.highlight,
    isFirst: row.is_first,
    firstOf: row.first_of,
    speakerId: row.speaker_id === null ? null : known(["person_1", "person_2"] as const, row.speaker_id, "person"),
    quote: row.quote,
    status: known(TIMELINE_EVENT_STATUSES, row.status, "status"),
    evidenceMessageIds: ids,
    evidenceTruncated: evidenceCount > ids.length,
  };
}

function evidenceIds(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [];
  return list.slice(0, MAX_EVIDENCE_IDS).map((item) => asId(item as string | number));
}

function knownCategory(value: string): EventCategory {
  if (!(EVENT_CATEGORIES as readonly string[]).includes(value)) {
    throw new RetrievalError("invalid_input", "unknown category");
  }
  return value as EventCategory;
}

function cachePayload(query: PreparedEvents): unknown {
  return {
    category: query.category,
    from: query.from,
    until: query.until,
    limit: query.limit,
    after: query.after,
  };
}

function revive(page: EventPage): EventPage {
  return {
    next: page.next,
    events: page.events.map((event) => ({
      ...event,
      occurredAt: new Date(event.occurredAt),
      endedAt: event.endedAt === null ? null : new Date(event.endedAt),
    })),
  };
}
