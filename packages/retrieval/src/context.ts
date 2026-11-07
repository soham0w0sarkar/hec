import type { SQL } from "bun";
import { COUNTED_MESSAGE_KINDS, MESSAGE_KINDS, MESSAGE_SOURCES, PERSON_IDS, type MessageKind } from "@hec/core";
import { withCache } from "./cache";
import { DEFAULT_LIMIT, MAX_CONTEXT, MAX_LIMIT } from "./constants";
import { RetrievalError } from "./errors";
import { readDataVersion, runRead } from "./query";
import { MESSAGE_COLUMNS, toMessageHit, type MessageRow } from "./rows";
import { istDayStart } from "./time";
import type { MessageHit, SearchFilters } from "./types";
import { encodeCursor, parseCursor, type RetrievalOptions } from "./keyword";

export type TranscriptQuery = SearchFilters & {
  limit?: number;
  order?: "asc" | "desc";
  after?: string;
};

/**
 * Messages around one id on the merged timeline, both apps together.
 * The target is included even when it is system, unsent, or empty.
 * Neighbours follow the usual filters. `before` and `after` are each capped.
 * Missing ids return an empty list.
 */
export async function getContextAround(
  sql: SQL,
  messageId: number,
  before: number,
  after: number,
  filters: Omit<SearchFilters, "from" | "until"> = {},
  options: RetrievalOptions = {},
): Promise<{ messages: MessageHit[] }> {
  if (!Number.isSafeInteger(messageId) || messageId < 1) {
    throw new RetrievalError("invalid_input", "message id is not valid");
  }
  for (const [label, value] of [
    ["before", before],
    ["after", after],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_CONTEXT) {
      throw new RetrievalError("invalid_input", `${label} must be a whole number from 0 to ${MAX_CONTEXT}`);
    }
  }
  const prepared = prepareFilters(filters);
  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(
    version,
    options.cache,
    "context",
    { messageId, before, after, ...prepared },
    () =>
      runRead(sql, async (tx) => {
        const rows = (await tx.unsafe(
          `with anchor as (
             select id, sent_at, source, source_ref from messages where id = $1::bigint
           ),
           earlier as (
             select ${MESSAGE_COLUMNS}
             from messages m
             join people p on p.id = m.person_id
             cross join anchor a
             where (m.sent_at, m.source, m.source_ref) < (a.sent_at, a.source, a.source_ref)
               and ($4::text is null or m.person_id = $4)
               and ($5::text is null or m.source = $5::message_source)
               and m.kind = any (array(select jsonb_array_elements_text($6::jsonb))::message_kind[])
               and ($7::boolean or length(btrim(m."text")) > 0)
             order by m.sent_at desc, m.source desc, m.source_ref desc
             limit $2
           ),
           later as (
             select ${MESSAGE_COLUMNS}
             from messages m
             join people p on p.id = m.person_id
             cross join anchor a
             where (m.sent_at, m.source, m.source_ref) > (a.sent_at, a.source, a.source_ref)
               and ($4::text is null or m.person_id = $4)
               and ($5::text is null or m.source = $5::message_source)
               and m.kind = any (array(select jsonb_array_elements_text($6::jsonb))::message_kind[])
               and ($7::boolean or length(btrim(m."text")) > 0)
             order by m.sent_at, m.source, m.source_ref
             limit $3
           )
           select * from (
             select * from earlier
             union all
             select ${MESSAGE_COLUMNS}
             from messages m
             join people p on p.id = m.person_id
             join anchor a on a.id = m.id
             union all
             select * from later
           ) around
           order by sent_at, source, source_ref`,
          [messageId, before, after, prepared.personId, prepared.source, prepared.kinds, prepared.includeEmpty],
        )) as MessageRow[];
        return { messages: rows.map(toMessageHit) };
      }, options),
    (value) => ({ messages: value.messages.map(reviveMessage) }),
  );
}

/**
 * Every message on one display-timezone calendar day. `day` is `YYYY-MM-DD`.
 * The day starts at 00:00 in that zone and ends at the next midnight, exclusive.
 * Pages are capped. Pass `next` back as `after`.
 */
export async function getDayTranscript(
  sql: SQL,
  day: string,
  query: TranscriptQuery = {},
  options: RetrievalOptions = {},
): Promise<{ hits: MessageHit[]; next: string | null }> {
  istDayStart(day);
  if (query.from || query.until) {
    throw new RetrievalError("invalid_input", "day transcript takes a calendar day, not a from/until range");
  }
  const prepared = prepareFilters(query);
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RetrievalError("invalid_input", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const order = query.order ?? "asc";
  if (order !== "asc" && order !== "desc") throw new RetrievalError("invalid_input", "order must be asc or desc");
  const after = query.after === undefined ? null : parseCursor(query.after);
  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(
    version,
    options.cache,
    "day",
    { day, ...prepared, limit, order, after },
    () =>
      runRead(sql, async (tx) => {
        const direction = order === "asc" ? { op: ">", dir: "asc" } : { op: "<", dir: "desc" };
        const rows = (await tx.unsafe(
          `select ${MESSAGE_COLUMNS}
           from messages m
           join people p on p.id = m.person_id
           where m.sent_at >= display_day_start($1::date)
             and m.sent_at < display_day_start(($1::date + 1))
             and ($2::text is null or m.person_id = $2)
             and ($3::text is null or m.source = $3::message_source)
             and m.kind = any (array(select jsonb_array_elements_text($4::jsonb))::message_kind[])
             and ($5::boolean or length(btrim(m."text")) > 0)
             and (
               $6::timestamptz is null
               or (m.sent_at, m.source, m.source_ref) ${direction.op} ($6::timestamptz, $7::message_source, $8)
             )
           order by m.sent_at ${direction.dir}, m.source ${direction.dir}, m.source_ref ${direction.dir}
           limit $9`,
          [
            day,
            prepared.personId,
            prepared.source,
            prepared.kinds,
            prepared.includeEmpty,
            after?.sentAt.toISOString() ?? null,
            after?.source ?? null,
            after?.sourceRef ?? null,
            limit + 1,
          ],
        )) as MessageRow[];
        const more = rows.length > limit;
        const hits = rows.slice(0, limit).map(toMessageHit);
        const last = hits.at(-1);
        return { hits, next: more && last ? encodeCursor(last) : null };
      }, options),
    (value) => ({ ...value, hits: value.hits.map(reviveMessage) }),
  );
}

function prepareFilters(filters: SearchFilters): {
  personId: string | null;
  source: string | null;
  kinds: MessageKind[];
  includeEmpty: boolean;
} {
  const personId =
    filters.personId === undefined
      ? null
      : assertAllowed(PERSON_IDS, filters.personId, "person");
  const source =
    filters.source === undefined ? null : assertAllowed(MESSAGE_SOURCES, filters.source, "source");
  const kinds =
    filters.kinds === undefined
      ? [...COUNTED_MESSAGE_KINDS]
      : filters.kinds.map((kind) => assertAllowed(MESSAGE_KINDS, kind, "kind"));
  if (kinds.length === 0) throw new RetrievalError("invalid_input", "kinds is empty");
  if (filters.includeEmpty !== undefined && typeof filters.includeEmpty !== "boolean") {
    throw new RetrievalError("invalid_input", "includeEmpty must be true or false");
  }
  return { personId, source, kinds, includeEmpty: filters.includeEmpty ?? false };
}

function assertAllowed<T extends string>(allowed: readonly T[], value: string, label: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new RetrievalError("invalid_input", `unknown ${label}`);
  return value as T;
}

function reviveMessage(hit: MessageHit): MessageHit {
  return { ...hit, sentAt: new Date(hit.sentAt) };
}
